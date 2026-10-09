import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enrollments, messages, scheduledMessages, sequences } from "../src/db/schema.js";
import { isWithinSendWindow, renderTemplate, runSchedulerTick } from "../src/services/automation.js";
import { createLead } from "../src/services/leads.js";
import { handleIncoming, sendToLead } from "../src/services/messaging.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env.close();
});

async function activate(trigger: "no_reply" | "lead_created") {
  const [seq] = await env.ctx.db.select().from(sequences).where(eq(sequences.trigger, trigger));
  await env.ctx.db.update(sequences).set({ active: true }).where(eq(sequences.id, seq!.id));
  return seq!;
}

describe("automações de follow-up", () => {
  it("'sem resposta': manda follow-ups da IA e para quando o lead responde", async () => {
    await updateSettings(env.ctx.db, { bot: { defaultMode: "human" } });
    await activate("no_reply");
    const lead = await createLead(env.ctx, { name: "João", phone: "11988887777", source: "manual" });
    await sendToLead(env.ctx, lead.id, "Oi João, recebeu a proposta?", { author: "agent" });

    const [e] = await env.ctx.db.select().from(enrollments).where(eq(enrollments.leadId, lead.id));
    expect(e!.status).toBe("active");

    // Ainda não venceu
    env.advanceMinutes(60);
    expect((await runSchedulerTick(env.ctx)).steps).toBe(0);

    // Passou 1 dia → passo 1 (IA)
    env.advanceMinutes(60 * 23);
    expect((await runSchedulerTick(env.ctx)).steps).toBe(1);
    expect(env.wa.sent.at(-1)!.text).toBe("Oi! Conseguiu pensar na proposta?");
    const out = await env.ctx.db.select().from(messages).where(eq(messages.author, "automation"));
    expect(out).toHaveLength(1);

    // Lead respondeu → para
    await handleIncoming(env.ctx, { phone: "5511988887777", body: "Recebi sim!", mediaType: "text", fromMe: false });
    await env.settle();
    const [after] = await env.ctx.db.select().from(enrollments).where(eq(enrollments.id, e!.id));
    expect(after!.status).toBe("stopped");
    expect(after!.stopReason).toBe("lead respondeu");
  });

  it("'lead criado': boas-vindas com variáveis para leads de formulário", async () => {
    await activate("lead_created");
    const lead = await createLead(env.ctx, {
      name: "Ana Paula",
      phone: "21977776666",
      interest: "consultoria",
      source: "formulario",
    });
    await runSchedulerTick(env.ctx);
    expect(env.wa.sent).toHaveLength(1);
    expect(env.wa.sent[0]!.text).toBe(
      "Oi Ana, tudo bem? Aqui é da Minha Empresa! Vi que você se interessou por consultoria. Posso te ajudar com alguma dúvida?",
    );
    const [e] = await env.ctx.db.select().from(enrollments).where(eq(enrollments.leadId, lead.id));
    expect(e!.status).toBe("completed");
  });

  it("leads que chegam pelo WhatsApp não entram em 'lead criado'", async () => {
    await activate("lead_created");
    await handleIncoming(env.ctx, { phone: "5511900000000", body: "oi", mediaType: "text", fromMe: false });
    await env.settle();
    expect(await env.ctx.db.select().from(enrollments)).toHaveLength(0);
  });

  it("a IA pode decidir NÃO mandar o follow-up", async () => {
    await activate("no_reply");
    env.ai.handlers.followup = () => ({ send: false, message: "", reason: "Lead disse que não tem interesse" });
    const lead = await createLead(env.ctx, { phone: "11955554444", chatMode: "human" });
    await sendToLead(env.ctx, lead.id, "Alguma dúvida?", { author: "agent" });
    env.advanceMinutes(60 * 25);
    await runSchedulerTick(env.ctx);
    expect(env.wa.sent).toHaveLength(1);
    const [e] = await env.ctx.db.select().from(enrollments).where(eq(enrollments.leadId, lead.id));
    expect(e!.status).toBe("stopped");
    expect(e!.stopReason).toContain("não tem interesse");
  });

  it("respeita a janela de horário de envio", async () => {
    await activate("no_reply");
    const lead = await createLead(env.ctx, { phone: "11944443333", chatMode: "human" });
    await sendToLead(env.ctx, lead.id, "Oi", { author: "agent" });
    // 23:30 em São Paulo do dia seguinte → fora da janela
    env.setNow(new Date("2026-10-11T02:30:00Z"));
    expect((await runSchedulerTick(env.ctx)).steps).toBe(0);
    // 09:00 → dentro
    env.setNow(new Date("2026-10-11T12:00:00Z"));
    expect((await runSchedulerTick(env.ctx)).steps).toBe(1);
  });

  it("envia mensagens agendadas na hora certa", async () => {
    const lead = await createLead(env.ctx, { phone: "11933332222", chatMode: "human" });
    await env.ctx.db
      .insert(scheduledMessages)
      .values({ leadId: lead.id, body: "Lembrete da reunião amanhã!", sendAt: new Date(env.ctx.now().getTime() + 30 * 60_000) });
    await runSchedulerTick(env.ctx);
    expect(env.wa.sent).toHaveLength(0);
    env.advanceMinutes(31);
    await runSchedulerTick(env.ctx);
    expect(env.wa.sent.map((s) => s.text)).toEqual(["Lembrete da reunião amanhã!"]);
    const [sm] = await env.ctx.db.select().from(scheduledMessages);
    expect(sm!.status).toBe("sent");
  });
});

describe("utilitários", () => {
  it("renderTemplate", async () => {
    const settings = await getSettings(env.ctx.db);
    const lead = await createLead(env.ctx, { name: "Carlos Silva", phone: "11922221111", company: "ACME" });
    expect(renderTemplate("Oi {{primeiro_nome}} da {{empresa}} {{inexistente}}!", lead, settings)).toBe("Oi Carlos da ACME!");
  });

  it("isWithinSendWindow (inclusive janelas que viram a noite)", async () => {
    const s = await getSettings(env.ctx.db);
    const at = (iso: string) => new Date(iso);
    expect(isWithinSendWindow(s, at("2026-10-09T11:00:00Z"), "America/Sao_Paulo")).toBe(true); // 08:00
    expect(isWithinSendWindow(s, at("2026-10-09T10:59:00Z"), "America/Sao_Paulo")).toBe(false); // 07:59
    expect(isWithinSendWindow(s, at("2026-10-09T23:00:00Z"), "America/Sao_Paulo")).toBe(false); // 20:00
    const night = { ...s, automation: { ...s.automation, sendWindowStart: "22:00", sendWindowEnd: "06:00" } };
    expect(isWithinSendWindow(night, at("2026-10-10T03:00:00Z"), "America/Sao_Paulo")).toBe(true); // 00:00
    expect(isWithinSendWindow(night, at("2026-10-09T15:00:00Z"), "America/Sao_Paulo")).toBe(false); // 12:00
  });
});
