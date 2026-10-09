// Testes de regressão para os problemas encontrados na revisão do PR #1.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insecureSettings, isInsecureAdminPassword, loadConfig, trustProxyValue } from "../src/config.js";
import { enrollments, leads, messages, sequences } from "../src/db/schema.js";
import { normalizePhone } from "../src/lib/phone.js";
import { renderTemplate, runSchedulerTick } from "../src/services/automation.js";
import { createLead } from "../src/services/leads.js";
import { handleIncoming, sendToLead } from "../src/services/messaging.js";
import { getSettings } from "../src/settings.js";
import { parseEvolutionWebhook } from "../src/whatsapp/evolution.js";
import { parseMetaWebhook } from "../src/whatsapp/meta.js";
import { login, setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env.close();
});

const inbound = (phone: string, body: string, extra: Partial<Parameters<typeof handleIncoming>[1]> = {}) =>
  handleIncoming(env.ctx, { phone, body, mediaType: "text", fromMe: false, externalId: `x-${Math.random()}`, ...extra });

const leadByPhone = async (phone: string) => (await env.ctx.db.select().from(leads).where(eq(leads.phone, phone)))[0];
const allLeads = () => env.ctx.db.select().from(leads);

describe("mensagens e leads", () => {
  it("C0: mensagem que chega enquanto o bot envia ainda é respondida", async () => {
    // O webhook da 2ª mensagem chega no meio do envio da 1ª resposta e com o horário do celular
    // levemente no passado. Antes, ela ficava ordenada antes da resposta e nunca era respondida.
    const original = env.wa.sendText.bind(env.wa);
    let injected = false;
    env.wa.sendText = async (phone, text) => {
      if (!injected) {
        injected = true;
        await inbound("5511900001111", "e qual o prazo?", { timestamp: new Date(env.ctx.now().getTime() - 500) });
      }
      return original(phone, text);
    };
    await inbound("5511900001111", "qual o preço?");
    await env.settle();
    expect(env.ai.callsOf("reply")).toHaveLength(2);
    expect(env.wa.sent).toHaveLength(2);
  });

  it("C1: duas primeiras mensagens simultâneas de um número novo → 1 lead, 2 mensagens", async () => {
    const results = await Promise.allSettled([
      inbound("5511900002222", "Oi"),
      inbound("5511900002222", "quero saber o preço"),
      inbound("5511900002222", "e o prazo"),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    await env.settle();
    expect(await allLeads()).toHaveLength(1);
    const msgs = await env.ctx.db.select().from(messages).where(eq(messages.direction, "in"));
    expect(msgs).toHaveLength(3);
  });

  it("webhook duplicado chegando ao mesmo tempo grava a mensagem uma vez só", async () => {
    await inbound("5511900003333", "primeira");
    await env.settle();
    await Promise.all([
      inbound("5511900003333", "repetida", { externalId: "same-id" }),
      inbound("5511900003333", "repetida", { externalId: "same-id" }),
    ]);
    await env.settle();
    const msgs = await env.ctx.db.select().from(messages).where(eq(messages.externalId, "same-id"));
    expect(msgs).toHaveLength(1);
  });

  it("C26: número internacional não ganha 55 e as próximas mensagens chegam no mesmo lead", async () => {
    const phone = normalizePhone("33612345678@s.whatsapp.net")!; // França, 11 dígitos
    expect(phone).toBe("33612345678");
    await inbound(phone, "Bonjour");
    await inbound(phone, "Tudo bem?");
    await env.settle();
    const rows = await allLeads();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phone).toBe("33612345678");
    const msgs = await env.ctx.db.select().from(messages).where(eq(messages.direction, "in"));
    expect(msgs).toHaveLength(2);
  });

  it("C2/C30: celular brasileiro com e sem o 9 é o mesmo lead", async () => {
    const lead = await createLead(env.ctx, { name: "Paula", phone: "(31) 99999-8888", source: "formulario" });
    expect(lead.phone).toBe("5531999998888");
    // O WhatsApp devolve a resposta sem o 9
    await inbound(normalizePhone("553199998888@s.whatsapp.net")!, "Oi, recebi!");
    await env.settle();
    expect(await allLeads()).toHaveLength(1);
    const msgs = await env.ctx.db.select().from(messages).where(eq(messages.leadId, lead.id));
    expect(msgs.map((m) => m.body)).toContain("Oi, recebi!");
  });

  it("C7: se o envio da resposta falha, a transferência para humano acontece mesmo assim", async () => {
    env.ai.handlers.reply = () => ({ reply: "Já te passo para a equipe", handoff: true, handoffReason: "quer fechar" });
    env.wa.failNext = "WhatsApp fora do ar";
    await inbound("5511900004444", "Quero fechar agora");
    await env.settle();
    const lead = await leadByPhone("5511900004444");
    expect(lead!.chatMode).toBe("human");
    expect(env.eventsOf("lead.handoff")).toHaveLength(1);
    const out = await env.ctx.db.select().from(messages).where(eq(messages.direction, "out"));
    expect(out[0]!.status).toBe("failed");
  });
});

describe("automações", () => {
  async function activateNoReply() {
    const [seq] = await env.ctx.db.select().from(sequences).where(eq(sequences.trigger, "no_reply"));
    await env.ctx.db.update(sequences).set({ active: true }).where(eq(sequences.id, seq!.id));
  }

  it("C4: não envia o follow-up se o lead respondeu enquanto a IA escrevia", async () => {
    await activateNoReply();
    const lead = await createLead(env.ctx, { phone: "11955550000", chatMode: "human" });
    await sendToLead(env.ctx, lead.id, "Conseguiu ver a proposta?", { author: "agent" });
    env.ai.handlers.followup = async () => {
      await inbound("5511955550000", "Vi sim, vou te responder já");
      return { send: true, message: "Oi! E aí, conseguiu ver?", reason: "" };
    };
    env.advanceMinutes(60 * 25);
    await runSchedulerTick(env.ctx);
    await env.settle();
    const auto = await env.ctx.db.select().from(messages).where(eq(messages.author, "automation"));
    expect(auto).toHaveLength(0);
    const [e] = await env.ctx.db.select().from(enrollments).where(eq(enrollments.leadId, lead.id));
    expect(e!.status).toBe("stopped");
  });

  it("C4: duas rodadas do agendador ao mesmo tempo enviam o passo uma vez só", async () => {
    await activateNoReply();
    const lead = await createLead(env.ctx, { phone: "11955551111", chatMode: "human" });
    await sendToLead(env.ctx, lead.id, "Oi!", { author: "agent" });
    env.advanceMinutes(60 * 25);
    await Promise.all([runSchedulerTick(env.ctx), runSchedulerTick(env.ctx)]);
    const auto = await env.ctx.db.select().from(messages).where(eq(messages.author, "automation"));
    expect(auto).toHaveLength(1);
  });

  it("C5: sem nome conhecido, o template não usa o telefone e a pontuação fica certa", async () => {
    const settings = await getSettings(env.ctx.db);
    const lead = await createLead(env.ctx, { phone: "11955552222" });
    expect(renderTemplate("Oi {{primeiro_nome}}, tudo bem?", lead, settings)).toBe("Oi, tudo bem?");
    const named = await createLead(env.ctx, { phone: "11955553333", name: "Ana Paula" });
    expect(renderTemplate("Oi {{primeiro_nome}}, tudo bem?", named, settings)).toBe("Oi Ana, tudo bem?");
  });
});

describe("API", () => {
  let app: Awaited<ReturnType<TestEnv["app"]>>;
  let token: string;
  beforeEach(async () => {
    app = await env.app();
    token = await login(app);
  });
  afterEach(async () => {
    await app.close();
  });
  const auth = (t = token) => ({ authorization: `Bearer ${t}` });
  const key = { "x-api-key": "test-key" };

  it("C6/C10: PUT parcial nas configurações não apaga os outros campos da seção", async () => {
    await app.inject({ method: "PUT", url: "/api/settings", headers: auth(), payload: { bot: { replyDelaySeconds: 30, defaultMode: "human" } } });
    const res = await app.inject({ method: "PUT", url: "/api/settings", headers: auth(), payload: { bot: { enabled: false } } });
    expect(res.json().settings.bot).toMatchObject({ enabled: false, replyDelaySeconds: 30, defaultMode: "human" });
  });

  it("C9: ligar/desligar uma automação mantém o gatilho e as outras opções", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/sequences",
        headers: auth(),
        payload: { name: "Teste", trigger: "no_reply", stopOnReply: false, steps: [{ delayMinutes: 10, mode: "text", message: "oi" }] },
      })
    ).json();
    const patched = (await app.inject({ method: "PATCH", url: `/api/sequences/${created.id}`, headers: auth(), payload: { active: false } })).json();
    expect(patched).toMatchObject({ active: false, trigger: "no_reply", stopOnReply: false });
  });

  it("C12: usuário removido perde o acesso na hora", async () => {
    await app.inject({ method: "POST", url: "/api/users", headers: auth(), payload: { name: "Vend", email: "v@x.dev", password: "123456" } });
    const agentToken = (
      await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "v@x.dev", password: "123456" } })
    ).json().token;
    expect((await app.inject({ method: "GET", url: "/api/leads", headers: auth(agentToken) })).statusCode).toBe(200);
    const users = (await app.inject({ method: "GET", url: "/api/users", headers: auth() })).json();
    const agent = users.find((u: { email: string }) => u.email === "v@x.dev");
    await app.inject({ method: "DELETE", url: `/api/users/${agent.id}`, headers: auth() });
    expect((await app.inject({ method: "GET", url: "/api/leads", headers: auth(agentToken) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/events?token=${agentToken}` })).statusCode).toBe(401);
  });

  it("C12: trocar a senha derruba os logins antigos e devolve um token novo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: auth(),
      payload: { current: "senha123", next: "outraSenha9" },
    });
    expect(res.statusCode).toBe(200);
    const fresh = res.json().token;
    expect((await app.inject({ method: "GET", url: "/api/leads", headers: auth() })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/leads", headers: auth(fresh) })).statusCode).toBe(200);
  });

  it("C14: etapa ou responsável inexistente dá 400 (não 500)", async () => {
    const a = await app.inject({ method: "POST", url: "/api/leads", headers: auth(), payload: { name: "X", stageId: 999 } });
    expect(a.statusCode).toBe(400);
    const lead = (await app.inject({ method: "POST", url: "/api/leads", headers: auth(), payload: { name: "Y" } })).json();
    const b = await app.inject({ method: "PATCH", url: `/api/leads/${lead.id}`, headers: auth(), payload: { ownerId: 999 } });
    expect(b.statusCode).toBe(400);
    const c = await app.inject({ method: "DELETE", url: "/api/users/abc", headers: auth() });
    expect(c.statusCode).toBe(400);
    const imp = await app.inject({ method: "POST", url: "/api/leads/import", headers: auth(), payload: { leads: [{ name: "Z", stageId: 999 }] } });
    expect(imp.json().errors[0].error).toContain("não existe");
  });

  it("C3: filtro updatedSince da API de integração funciona (inclusive no Postgres)", async () => {
    await app.inject({ method: "POST", url: "/api/integrations/leads", headers: key, payload: { phone: "11966660000" } });
    const since = new Date(env.ctx.now().getTime() - 60_000).toISOString();
    const res = await app.inject({ method: "GET", url: `/api/integrations/leads?updatedSince=${since}`, headers: key });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(1);
  });

  it("C26: integração com número internacional não duplica nem ganha 55", async () => {
    const a = await app.inject({ method: "POST", url: "/api/integrations/leads", headers: key, payload: { phone: "+33 6 12 34 56 78" } });
    expect(a.json()).toMatchObject({ created: true, lead: { phone: "33612345678" } });
    const b = await app.inject({ method: "POST", url: "/api/integrations/leads", headers: key, payload: { phone: "+33612345678", name: "Jean" } });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ created: false, lead: { phone: "33612345678", name: "Jean" } });
  });

  it("C31: withoutTag deixa de fora quem já tem a etiqueta", async () => {
    await app.inject({ method: "POST", url: "/api/integrations/leads", headers: key, payload: { phone: "11966661111", tags: ["follow-up-n8n"] } });
    await app.inject({ method: "POST", url: "/api/integrations/leads", headers: key, payload: { phone: "11966662222" } });
    const res = await app.inject({ method: "GET", url: "/api/integrations/leads?withoutTag=follow-up-n8n", headers: key });
    expect(res.json().items.map((l: { phone: string }) => l.phone)).toEqual(["5511966662222"]);
  });

  it("C11: X-Forwarded-For não burla o limite de tentativas de login", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-forwarded-for": `10.0.0.${i}` },
        payload: { email: "admin@test.dev", password: "errada" },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe("parsers e configuração", () => {
  it("C2: telefones canônicos", () => {
    expect(normalizePhone("553199998888@s.whatsapp.net")).toBe("5531999998888");
    expect(normalizePhone("+55 31 9999-8888")).toBe("5531999998888");
    expect(normalizePhone("551133334444")).toBe("551133334444"); // fixo continua igual
    expect(normalizePhone("+1 415 555 2671")).toBe("14155552671");
  });

  it("C32: remetente só com LID é ignorado (não vira telefone falso)", () => {
    const res = parseEvolutionWebhook({
      event: "messages.upsert",
      data: { key: { remoteJid: "123456789012345@lid", fromMe: false, id: "L1" }, message: { conversation: "oi" } },
    });
    expect(res.messages).toHaveLength(0);
    expect(res.skipped?.[0]).toContain("LID");
  });

  it("C33: reação da Meta não vira mensagem do lead", () => {
    const res = parseMetaWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: { messages: [{ from: "5511999990000", id: "r1", type: "reaction", reaction: { emoji: "👍", message_id: "x" } }] },
            },
          ],
        },
      ],
    });
    expect(res.messages).toHaveLength(0);
  });

  it("C13/C28: segredos de exemplo são detectados", () => {
    const example = loadConfig({
      JWT_SECRET: "troque-por-um-segredo-longo-e-aleatorio",
      CRM_API_KEY: "troque-por-uma-chave-para-o-n8n",
      WEBHOOK_SECRET: "troque-por-um-token-de-webhook",
      WHATSAPP_PROVIDER: "evolution",
      EVOLUTION_API_KEY: "troque-por-uma-chave-da-evolution",
    });
    expect(insecureSettings(example).sort()).toEqual(["CRM_API_KEY", "EVOLUTION_API_KEY", "JWT_SECRET", "WEBHOOK_SECRET"]);
    const pg = loadConfig({ JWT_SECRET: "a".repeat(64), DATABASE_URL: "postgres://crm:troque-a-senha-do-banco@postgres:5432/crm" });
    expect(insecureSettings(pg)).toEqual(["POSTGRES_PASSWORD"]);
    const good = loadConfig({ JWT_SECRET: "a".repeat(64), CRM_API_KEY: "k1", WEBHOOK_SECRET: "w1", WHATSAPP_PROVIDER: "simulator" });
    expect(insecureSettings(good)).toEqual([]);
    expect(isInsecureAdminPassword("troque-esta-senha")).toBe(true);
    expect(isInsecureAdminPassword("uma-senha-forte-123")).toBe(false);
  });

  it("C11: TRUST_PROXY", () => {
    expect(trustProxyValue("false")).toBe(false);
    expect(trustProxyValue("")).toBe(false);
    expect(trustProxyValue("true")).toBe(true);
    expect(trustProxyValue("10.0.0.0/8")).toBe("10.0.0.0/8");
    const fn = trustProxyValue("1") as (a: string, hop: number) => boolean;
    expect([fn("x", 0), fn("x", 1)]).toEqual([true, false]);
  });
});
