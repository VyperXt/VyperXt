import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup, login, type TestEnv } from "./helpers.js";

let env: TestEnv;
let app: Awaited<ReturnType<TestEnv["app"]>>;
let token: string;

beforeEach(async () => {
  env = await setup();
  app = await env.app();
  token = await login(app);
});
afterEach(async () => {
  await app.close();
  await env.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe("painel (API autenticada)", () => {
  it("exige login", async () => {
    const res = await app.inject({ method: "GET", url: "/api/leads" });
    expect(res.statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@test.dev", password: "x" } });
    expect(bad.statusCode).toBe(401);
  });

  it("CRUD de leads, funil e conversa", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: auth(),
      payload: { name: "Bruno", phone: "(11) 97777-6666", value: 1500, tags: ["vip"] },
    });
    expect(created.statusCode).toBe(200);
    const lead = created.json();
    expect(lead.phone).toBe("5511977776666");

    const dup = await app.inject({ method: "POST", url: "/api/leads", headers: auth(), payload: { phone: "11977776666" } });
    expect(dup.statusCode).toBe(409);

    const stages = (await app.inject({ method: "GET", url: "/api/stages", headers: auth() })).json();
    const proposta = stages.find((s: { name: string }) => s.name === "Proposta");
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/leads/${lead.id}`,
      headers: auth(),
      payload: { stageId: proposta.id },
    });
    expect(moved.json().stageId).toBe(proposta.id);
    expect(env.eventsOf("lead.stage_changed")[0]!.body.data.to.name).toBe("Proposta");

    const sent = await app.inject({
      method: "POST",
      url: `/api/leads/${lead.id}/messages`,
      headers: auth(),
      payload: { body: "Oi Bruno!" },
    });
    expect(sent.statusCode).toBe(200);
    expect(env.wa.sent[0]).toMatchObject({ phone: "5511977776666", text: "Oi Bruno!" });

    const detail = (await app.inject({ method: "GET", url: `/api/leads/${lead.id}`, headers: auth() })).json();
    expect(detail.activities.map((a: { type: string }) => a.type)).toContain("stage_changed");

    const convs = (await app.inject({ method: "GET", url: "/api/conversations", headers: auth() })).json();
    expect(convs[0].lastMessage.body).toBe("Oi Bruno!");

    const search = (await app.inject({ method: "GET", url: "/api/leads?search=7777", headers: auth() })).json();
    expect(search.total).toBe(1);

    const dash = (await app.inject({ method: "GET", url: "/api/dashboard", headers: auth() })).json();
    expect(dash.totals.leads).toBe(1);
    expect(dash.totals.pipelineValue).toBe(1500);
    expect(dash.leadsPerDay).toHaveLength(14);
  });

  it("falha de envio no WhatsApp fica registrada", async () => {
    const lead = (await app.inject({ method: "POST", url: "/api/leads", headers: auth(), payload: { phone: "11966665555" } })).json();
    env.wa.failNext = "número sem WhatsApp";
    const res = await app.inject({ method: "POST", url: `/api/leads/${lead.id}/messages`, headers: auth(), payload: { body: "Oi" } });
    expect(res.statusCode).toBe(502);
    const msgs = (await app.inject({ method: "GET", url: `/api/leads/${lead.id}/messages`, headers: auth() })).json();
    expect(msgs[0]).toMatchObject({ status: "failed", error: "número sem WhatsApp" });
  });

  it("copiloto: gerar, perguntar — sem enviar nada", async () => {
    const lead = (
      await app.inject({ method: "POST", url: "/api/leads", headers: auth(), payload: { phone: "11955554444", chatMode: "human" } })
    ).json();
    const gen = await app.inject({ method: "POST", url: `/api/leads/${lead.id}/copilot`, headers: auth() });
    expect(gen.json().insight.data.nextBestAction).toContain("orçamento");
    const latest = (await app.inject({ method: "GET", url: `/api/leads/${lead.id}/copilot`, headers: auth() })).json();
    expect(latest.insight.id).toBe(gen.json().insight.id);
    const ask = await app.inject({
      method: "POST",
      url: `/api/leads/${lead.id}/copilot/ask`,
      headers: auth(),
      payload: { question: "Como respondo se ele achar caro?", draft: "é caro mesmo" },
    });
    expect(ask.json().suggestedMessage).toBeTruthy();
    expect(env.ai.callsOf("copilot_ask")[0]!.prompt).toContain("é caro mesmo");
    expect(env.wa.sent).toHaveLength(0);
  });

  it("captador: extrai leads de texto e importa", async () => {
    env.ai.handlers.extract = () => ({
      leads: [
        { name: "Paula", phone: "(31) 98888-1111", email: "paula@x.com", company: "Loja X", interest: "site", notes: "" },
        { name: "Rafa", phone: "", email: "rafa@y.com", company: "", interest: "", notes: "indicação" },
      ],
    });
    const ex = await app.inject({ method: "POST", url: "/api/leads/extract", headers: auth(), payload: { text: "Paula da Loja X..." } });
    const found = ex.json().leads;
    expect(found[0].phone).toBe("5531988881111");
    const imp = await app.inject({ method: "POST", url: "/api/leads/import", headers: auth(), payload: { leads: found } });
    expect(imp.json()).toMatchObject({ created: 2, errors: [] });
  });

  it("configurações e usuários", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth(),
      payload: { business: { name: "Vyper Studio" }, bot: { replyDelaySeconds: 2 } },
    });
    expect(put.json().settings.business.name).toBe("Vyper Studio");
    expect(put.json().settings.bot.enabled).toBe(true);
    const get = (await app.inject({ method: "GET", url: "/api/settings", headers: auth() })).json();
    expect(get.system.webhooks.evolution).toContain("/api/webhooks/evolution?token=whsec");

    const user = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: auth(),
      payload: { name: "Vendedor", email: "v@test.dev", password: "123456" },
    });
    expect(user.json().role).toBe("agent");
  });

  it("tokens na URL não vão para o log", async () => {
    const { redactUrl } = await import("../src/app.js");
    expect(redactUrl("/api/events?token=eyJabc.def")).toBe("/api/events?token=***");
    expect(redactUrl("/api/webhooks/evolution?x=1&token=segredo")).toBe("/api/webhooks/evolution?x=1&token=***");
    expect(redactUrl("/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=1")).toBe(
      "/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=***&hub.challenge=1",
    );
  });

  it("simulador injeta mensagem e dispara o bot", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/whatsapp/simulate",
      headers: auth(),
      payload: { phone: "11912345678", name: "Teste", body: "Oi!" },
    });
    expect(res.statusCode).toBe(200);
    await env.settle();
    expect(env.wa.sent).toHaveLength(1);
  });
});

describe("API de integração (n8n)", () => {
  const key = { "x-api-key": "test-key" };

  it("exige x-api-key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/integrations/leads" });
    expect(res.statusCode).toBe(401);
  });

  it("cria e depois atualiza o mesmo lead (upsert por telefone)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/integrations/leads",
      headers: key,
      payload: {
        name: "Carla",
        phone: "11911112222",
        source: "formulario-site",
        message: "Quero orçamento para 10 pessoas",
        qualify: true,
        welcomeMessage: "Oi {{primeiro_nome}}! Recebemos seu contato 😊",
        stage: "Qualificando",
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ created: true, welcome: { sent: true } });
    expect(first.json().lead.notes).toContain("10 pessoas");
    expect(env.wa.sent[0]!.text).toBe("Oi Carla! Recebemos seu contato 😊");
    expect(env.ai.callsOf("qualify")[0]!.prompt).toContain("10 pessoas");

    const second = await app.inject({
      method: "POST",
      url: "/api/integrations/leads",
      headers: key,
      payload: { phone: "+55 11 91111-2222", email: "carla@z.com", tags: ["evento"] },
    });
    expect(second.json().created).toBe(false);
    expect(second.json().lead).toMatchObject({ email: "carla@z.com", tags: ["evento"] });
  });

  it("captador com IA a partir de texto solto", async () => {
    env.ai.handlers.extract = () => ({
      leads: [{ name: "Diego", phone: "41 99999-0000", email: "", company: "Oficina D", interest: "sistema", notes: "" }],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/integrations/leads",
      headers: key,
      payload: { rawText: "Diego da Oficina D (41 99999-0000) quer um sistema" },
    });
    expect(res.json().lead).toMatchObject({ name: "Diego", phone: "5541999990000", company: "Oficina D" });
  });

  it("lista leads parados e envia follow-up escrito pela IA", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/api/integrations/leads", headers: key, payload: { phone: "11900001111" } })
    ).json();
    const id = created.lead.id;
    await app.inject({ method: "POST", url: `/api/integrations/leads/${id}/messages`, headers: key, payload: { text: "Oi!" } });
    env.advanceMinutes(60 * 30);
    const stale = (await app.inject({ method: "GET", url: "/api/integrations/leads?inactiveHours=24", headers: key })).json();
    expect(stale.items.map((l: { id: number }) => l.id)).toEqual([id]);
    const automatable = (
      await app.inject({ method: "GET", url: "/api/integrations/leads?inactiveHours=24&automatable=true", headers: key })
    ).json();
    expect(automatable.count).toBe(1);

    const fu = await app.inject({
      method: "POST",
      url: `/api/integrations/leads/${id}/messages`,
      headers: key,
      payload: { ai: true, instruction: "retomar" },
    });
    expect(fu.json().sent).toBe(true);
    expect(env.wa.sent.at(-1)!.text).toBe("Oi! Conseguiu pensar na proposta?");

    const moved = await app.inject({
      method: "PATCH",
      url: `/api/integrations/leads/${id}`,
      headers: key,
      payload: { stage: "Perdido", addTags: ["sem-resposta"] },
    });
    expect(moved.json().tags).toEqual(["sem-resposta"]);
    // Em "Perdido" não entra mais em automações
    const after = (await app.inject({ method: "GET", url: "/api/integrations/leads?automatable=true", headers: key })).json();
    expect(after.count).toBe(0);
  });
});

describe("webhooks do WhatsApp", () => {
  const evolutionPayload = {
    event: "messages.upsert",
    instance: "crm",
    data: {
      key: { remoteJid: "5511987654321@s.whatsapp.net", fromMe: false, id: "3EB0ABC" },
      pushName: "Fernanda",
      message: { conversation: "Olá, vi o anúncio" },
      messageType: "conversation",
      messageTimestamp: 1760022000,
    },
  };

  it("Evolution: exige token e cria o lead", async () => {
    const noToken = await app.inject({ method: "POST", url: "/api/webhooks/evolution", payload: evolutionPayload });
    expect(noToken.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/api/webhooks/evolution?token=whsec", payload: evolutionPayload });
    expect(ok.statusCode).toBe(200);
    await env.settle();
    const leads = (await app.inject({ method: "GET", url: "/api/leads", headers: auth() })).json();
    expect(leads.items[0]).toMatchObject({ phone: "5511987654321", waName: "Fernanda", source: "whatsapp" });
  });

  it("Meta: verificação do webhook e assinatura", async () => {
    const verify = await app.inject({
      method: "GET",
      url: "/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345",
    });
    expect(verify.body).toBe("12345");
    const wrong = await app.inject({
      method: "GET",
      url: "/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1",
    });
    expect(wrong.statusCode).toBe(403);

    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                contacts: [{ wa_id: "5521988887777", profile: { name: "Gabi" } }],
                messages: [{ from: "5521988887777", id: "wamid.1", timestamp: "1760022000", type: "text", text: { body: "Oi" } }],
              },
            },
          ],
        },
      ],
    });
    const unsigned = await app.inject({
      method: "POST",
      url: "/api/webhooks/meta",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);
    const sig = "sha256=" + createHmac("sha256", "app-secret").update(body).digest("hex");
    const signed = await app.inject({
      method: "POST",
      url: "/api/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
      payload: body,
    });
    expect(signed.statusCode).toBe(200);
    await env.settle();
    const leads = (await app.inject({ method: "GET", url: "/api/leads", headers: auth() })).json();
    expect(leads.items[0]).toMatchObject({ phone: "5521988887777", waName: "Gabi" });
  });
});
