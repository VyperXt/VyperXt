import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leads, scheduledMessages } from "../src/db/schema.js";
import {
  OVERDUE_GRACE_MS,
  reflowOverdueBatches,
  resetLastAutomationSendAtForTest,
  runSchedulerTick,
} from "../src/services/automation.js";
import { setup, type TestEnv } from "./helpers.js";

let env: TestEnv;

beforeEach(async () => {
  resetLastAutomationSendAtForTest();
  env = await setup();
});

afterEach(async () => {
  await env.close();
});

async function createLead(name: string, phone: string) {
  const [l] = await env.ctx.db
    .insert(leads)
    .values({ name, phone, source: "manual" })
    .returning();
  return l!;
}

describe("Reflow de disparos atrasados (reflowOverdueBatches)", () => {
  it("1. Lote com 3 mensagens espaçadas de 5 min (now-60m, now-55m, now-50m) → 1ª enviada e outras em now+5m e now+10m sem rajada", async () => {
    const l1 = await createLead("Lead 1", "11988880001");
    const l2 = await createLead("Lead 2", "11988880002");
    const l3 = await createLead("Lead 3", "11988880003");

    // 15:00 UTC = 12:00 São Paulo (dentro da janela de envio 08:00–20:00)
    const now = new Date("2026-10-09T15:00:00Z");
    env.setNow(now);

    const batchId = "batch-lote-1";
    const [m1] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l1.id,
        body: "Msg 1 atrasada",
        sendAt: new Date(now.getTime() - 60 * 60_000),
        author: "automation",
        status: "pending",
        batchId,
      })
      .returning();

    const [m2] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l2.id,
        body: "Msg 2 atrasada",
        sendAt: new Date(now.getTime() - 55 * 60_000),
        author: "automation",
        status: "pending",
        batchId,
      })
      .returning();

    const [m3] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l3.id,
        body: "Msg 3 atrasada",
        sendAt: new Date(now.getTime() - 50 * 60_000),
        author: "automation",
        status: "pending",
        batchId,
      })
      .returning();

    // Roda o tick do agendador
    const tickRes = await runSchedulerTick(env.ctx);

    // Nenhuma rajada: só 1 envio nesse tick
    expect(tickRes.scheduled).toBe(1);
    expect(env.wa.sent).toHaveLength(1);
    expect(env.wa.sent[0]!.phone).toBe(l1.phone);

    // 1ª mensagem foi enviada
    const [m1After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, m1!.id));
    expect(m1After!.status).toBe("sent");

    // As outras ficam em now+5min e now+10min (tolerância de alguns segundos)
    const [m2After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, m2!.id));
    expect(m2After!.status).toBe("pending");
    const m2Expected = now.getTime() + 5 * 60_000;
    expect(Math.abs(m2After!.sendAt.getTime() - m2Expected)).toBeLessThanOrEqual(2000);

    const [m3After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, m3!.id));
    expect(m3After!.status).toBe("pending");
    const m3Expected = now.getTime() + 10 * 60_000;
    expect(Math.abs(m3After!.sendAt.getTime() - m3Expected)).toBeLessThanOrEqual(2000);

    // O espaçamento de 5 minutos entre m2 e m3 é exatamente preservado
    expect(m3After!.sendAt.getTime() - m2After!.sendAt.getTime()).toBe(5 * 60_000);
  });

  it("2. Mensagem atrasada só 1 min (dentro da tolerância) → não é remarcada", async () => {
    const l = await createLead("Lead Tolerancia", "11988880004");
    const now = new Date("2026-10-09T15:00:00Z");
    env.setNow(now);

    const sendAtOriginal = new Date(now.getTime() - 1 * 60_000); // atrasada 1 min (< 2 min)

    const [m] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l.id,
        body: "Dentro da tolerância",
        sendAt: sendAtOriginal,
        author: "automation",
        status: "pending",
        batchId: "batch-tolerancia",
      })
      .returning();

    const count = await reflowOverdueBatches(env.ctx, now);
    expect(count).toBe(0);

    const [mAfter] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, m!.id));
    expect(mAfter!.sendAt.getTime()).toBe(sendAtOriginal.getTime());
  });

  it("3. Mensagem author 'agent' atrasada → não é remarcada", async () => {
    const l = await createLead("Lead Agent", "11988880005");
    const now = new Date("2026-10-09T15:00:00Z");
    env.setNow(now);

    const sendAtOriginal = new Date(now.getTime() - 60 * 60_000); // 60 min atrasada

    const [m] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l.id,
        body: "Agendada pelo vendedor",
        sendAt: sendAtOriginal,
        author: "agent",
        status: "pending",
        batchId: "batch-agent",
      })
      .returning();

    const count = await reflowOverdueBatches(env.ctx, now);
    expect(count).toBe(0);

    const [mAfter] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, m!.id));
    expect(mAfter!.sendAt.getTime()).toBe(sendAtOriginal.getTime());
  });

  it("4. Dois lotes atrasados → cada um mantém seu próprio espaçamento", async () => {
    const lA1 = await createLead("Lead A1", "11988880011");
    const lA2 = await createLead("Lead A2", "11988880012");
    const lB1 = await createLead("Lead B1", "11988880021");
    const lB2 = await createLead("Lead B2", "11988880022");

    const now = new Date("2026-10-09T15:00:00Z");
    env.setNow(now);

    // Lote A: 60m e 55m atrás (espaçamento de 5 min)
    const [mA1] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: lA1.id,
        body: "Lote A1",
        sendAt: new Date(now.getTime() - 60 * 60_000),
        author: "automation",
        status: "pending",
        batchId: "lote-A",
      })
      .returning();

    const [mA2] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: lA2.id,
        body: "Lote A2",
        sendAt: new Date(now.getTime() - 55 * 60_000),
        author: "automation",
        status: "pending",
        batchId: "lote-A",
      })
      .returning();

    // Lote B: 30m e 20m atrás (espaçamento de 10 min)
    const [mB1] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: lB1.id,
        body: "Lote B1",
        sendAt: new Date(now.getTime() - 30 * 60_000),
        author: "automation",
        status: "pending",
        batchId: "lote-B",
      })
      .returning();

    const [mB2] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: lB2.id,
        body: "Lote B2",
        sendAt: new Date(now.getTime() - 20 * 60_000),
        author: "automation",
        status: "pending",
        batchId: "lote-B",
      })
      .returning();

    const count = await reflowOverdueBatches(env.ctx, now);
    expect(count).toBe(4);

    const [mA1After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, mA1!.id));
    const [mA2After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, mA2!.id));
    const [mB1After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, mB1!.id));
    const [mB2After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, mB2!.id));

    // Lote A: primeiro vira now, segundo vira now + 5 min
    expect(mA1After!.sendAt.getTime()).toBe(now.getTime());
    expect(mA2After!.sendAt.getTime()).toBe(now.getTime() + 5 * 60_000);
    expect(mA2After!.sendAt.getTime() - mA1After!.sendAt.getTime()).toBe(5 * 60_000);

    // Lote B: primeiro vira now, segundo vira now + 10 min
    expect(mB1After!.sendAt.getTime()).toBe(now.getTime());
    expect(mB2After!.sendAt.getTime()).toBe(now.getTime() + 10 * 60_000);
    expect(mB2After!.sendAt.getTime() - mB1After!.sendAt.getTime()).toBe(10 * 60_000);
  });

  it("itens com batchId nulo formam grupos individuais", async () => {
    const l1 = await createLead("Lead Single 1", "11988880031");
    const l2 = await createLead("Lead Single 2", "11988880032");

    const now = new Date("2026-10-09T15:00:00Z");
    env.setNow(now);

    const [m1] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l1.id,
        body: "Sem lote 1",
        sendAt: new Date(now.getTime() - 40 * 60_000),
        author: "automation",
        status: "pending",
        batchId: null,
      })
      .returning();

    const [m2] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l2.id,
        body: "Sem lote 2",
        sendAt: new Date(now.getTime() - 25 * 60_000),
        author: "automation",
        status: "pending",
        batchId: null,
      })
      .returning();

    const count = await reflowOverdueBatches(env.ctx, now);
    expect(count).toBe(2);

    const [m1After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, m1!.id));
    const [m2After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, m2!.id));

    // Ambos são deslocados para now independentemente
    expect(m1After!.sendAt.getTime()).toBe(now.getTime());
    expect(m2After!.sendAt.getTime()).toBe(now.getTime());
  });

  it("mensagens já enviadas, falhas ou canceladas não são remarcadas", async () => {
    const l = await createLead("Lead Outros Status", "11988880041");
    const now = new Date("2026-10-09T15:00:00Z");
    env.setNow(now);

    const pastDate = new Date(now.getTime() - 60 * 60_000);

    const [mSent] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l.id,
        body: "Já enviada",
        sendAt: pastDate,
        author: "automation",
        status: "sent",
        batchId: "batch-status",
      })
      .returning();

    const [mCanceled] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l.id,
        body: "Cancelada",
        sendAt: pastDate,
        author: "automation",
        status: "canceled",
        batchId: "batch-status",
      })
      .returning();

    const count = await reflowOverdueBatches(env.ctx, now);
    expect(count).toBe(0);

    const [mSentAfter] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, mSent!.id));
    expect(mSentAfter!.sendAt.getTime()).toBe(pastDate.getTime());

    const [mCanceledAfter] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, mCanceled!.id));
    expect(mCanceledAfter!.sendAt.getTime()).toBe(pastDate.getTime());
  });
});
