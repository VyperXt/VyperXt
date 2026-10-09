// Testes de regressão da 2ª rodada de revisão do PR #1.
import { readFileSync } from "node:fs";
import { asc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leads, messages, sequences, stages, users, type Message } from "../src/db/schema.js";
import { normalizePhone } from "../src/lib/phone.js";
import { runAutoReply, unansweredInbound } from "../src/services/ai-flows.js";
import { renderTemplate } from "../src/services/automation.js";
import { createLead } from "../src/services/leads.js";
import { handleIncoming, sendToLead } from "../src/services/messaging.js";
import { resetUserPassword } from "../src/services/users.js";
import { getSettings } from "../src/settings.js";
import { EvolutionProvider, parseEvolutionWebhook } from "../src/whatsapp/evolution.js";
import { parseMetaWebhook } from "../src/whatsapp/meta.js";
import { login, setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env.close();
});

const inbound = (phone: string | null, body: string, extra: Partial<Parameters<typeof handleIncoming>[1]> = {}) =>
  handleIncoming(env.ctx, { phone, body, mediaType: "text", fromMe: false, externalId: `x-${Math.random()}`, ...extra });

const allLeads = () => env.ctx.db.select().from(leads);
const messagesOf = (leadId: number) =>
  env.ctx.db.select().from(messages).where(eq(messages.leadId, leadId)).orderBy(asc(messages.id));

describe("conversa com o bot", () => {
  it("C0: resposta do bot a uma mensagem anterior não conta como resposta à mensagem nova", () => {
    const m = (id: number, direction: "in" | "out", extra: Partial<Message> = {}) =>
      ({ id, direction, author: direction === "in" ? "lead" : "bot", replyToId: null, ...extra }) as Message;
    // in 1, in 2, bot respondendo a 1 (o lead escreveu de novo enquanto o bot enviava)
    expect(unansweredInbound([m(1, "in"), m(2, "in"), m(3, "out", { replyToId: 1 })])?.id).toBe(2);
    expect(unansweredInbound([m(1, "in"), m(2, "out", { replyToId: 1 })])).toBeUndefined();
    // mensagem de um vendedor depois conta como resposta
    expect(unansweredInbound([m(1, "in"), m(2, "in"), m(3, "out", { author: "agent" })])).toBeUndefined();
    expect(unansweredInbound([m(1, "out", { author: "agent" })])).toBeUndefined();
  });

  it("C0: bot responde a mensagem que ficou antes da resposta dele (janela entre a checagem e o envio)", async () => {
    const lead = await createLead(env.ctx, { phone: "11900005555", chatMode: "bot", source: "whatsapp" });
    const base = { leadId: lead.id, mediaType: "text", createdAt: env.ctx.now() };
    const [m1] = await env.ctx.db.insert(messages).values({ ...base, direction: "in", author: "lead", body: "qual o preço?", status: "received" }).returning();
    const [m2] = await env.ctx.db.insert(messages).values({ ...base, direction: "in", author: "lead", body: "e o prazo?", status: "received" }).returning();
    await env.ctx.db.insert(messages).values({ ...base, direction: "out", author: "bot", body: "R$ 100", status: "sent", replyToId: m1!.id });

    const result = await runAutoReply(env.ctx, lead.id);
    expect(result.sent).toBe(true);
    const out = (await messagesOf(lead.id)).filter((m) => m.direction === "out");
    expect(out.at(-1)!.replyToId).toBe(m2!.id);
    // e não responde de novo
    expect((await runAutoReply(env.ctx, lead.id)).sent).toBe(false);
  });

  it("A: lead que escreve durante um envio continua em 'Aguardando você'", async () => {
    const lead = await createLead(env.ctx, { phone: "11900006666", chatMode: "human" });
    const original = env.wa.sendText.bind(env.wa);
    env.wa.sendText = async (phone, text) => {
      env.advanceMinutes(0.01); // o envio demora; o lead escreve no meio
      await inbound("5511900006666", "e o prazo?");
      return original(phone, text);
    };
    await sendToLead(env.ctx, lead.id, "Segue a proposta", { author: "agent" });
    await env.settle();
    const [row] = await env.ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(row!.lastMessageAt!.getTime()).toBe(row!.lastInboundAt!.getTime());

    const app = await env.app();
    const token = await login(app);
    const res = await app.inject({ method: "GET", url: "/api/conversations?filter=waiting", headers: { authorization: `Bearer ${token}` } });
    expect(res.json().map((c: { lead: { id: number } }) => c.lead.id)).toContain(lead.id);
    await app.close();
  });

  it("G: horário do WhatsApp é mantido em webhooks atrasados, sem bagunçar a ordem", async () => {
    // Conversa com humano: nenhuma resposta do bot entra no meio
    await createLead(env.ctx, { phone: "11900007777", chatMode: "human" });
    const now = env.ctx.now().getTime();
    const twoHoursAgo = new Date(now - 2 * 3600_000);
    const first = await inbound("5511900007777", "mandei de manhã", { timestamp: twoHoursAgo });
    expect(first!.createdAt.getTime()).toBe(twoHoursAgo.getTime());
    // reenvio de uma mensagem ainda mais antiga: fica depois da última (ordem do que já foi lido)
    const older = await inbound("5511900007777", "mensagem reenviada", { timestamp: new Date(now - 3 * 3600_000) });
    expect(older!.createdAt.getTime()).toBe(twoHoursAgo.getTime() + 1);
    // relógio do celular adiantado: nunca no futuro
    const future = await inbound("5511900007777", "relógio adiantado", { timestamp: new Date(now + 3600_000) });
    expect(future!.createdAt.getTime()).toBe(now);
    await env.settle();
  });
});

describe("contatos e telefones", () => {
  it("F/C32: contato só com LID vira lead, recebe resposta pelo LID e depois ganha o telefone", async () => {
    const parsed = parseEvolutionWebhook({
      event: "messages.upsert",
      data: { key: { remoteJid: "123456789012345@lid", fromMe: false, id: "L1" }, pushName: "Bia", message: { conversation: "oi" } },
    });
    await handleIncoming(env.ctx, parsed.messages[0]!);
    await env.settle();
    const [lead] = await allLeads();
    expect(lead).toMatchObject({ phone: null, waJid: "123456789012345@lid", waName: "Bia" });
    expect(env.wa.sent.at(-1)!.phone).toBe("123456789012345@lid");

    // Depois o WhatsApp manda o mesmo contato já com o número: o lead é o mesmo e ganha o telefone
    const withPhone = parseEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "123456789012345@lid", remoteJidAlt: "5531988887777@s.whatsapp.net", fromMe: false, id: "L2" },
        message: { conversation: "meu número apareceu" },
      },
    });
    expect(withPhone.messages[0]).toMatchObject({ phone: "5531988887777", jid: "123456789012345@lid" });
    await handleIncoming(env.ctx, withPhone.messages[0]!);
    await env.settle();
    const rows = await allLeads();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phone: "5531988887777", waJid: "123456789012345@lid" });
  });

  it("F: lead só com LID entra nas automações e na lista 'automatable' do n8n", async () => {
    await inbound(null, "oi", { jid: "999888777666555@lid" });
    await env.settle();
    const app = await env.app();
    const res = await app.inject({ method: "GET", url: "/api/integrations/leads?automatable=true", headers: { "x-api-key": "test-key" } });
    expect(res.json().items.map((l: { waJid: string }) => l.waJid)).toContain("999888777666555@lid");
    await app.close();
  });

  it("F/C33: mensagem 'unsupported' da Meta aparece na conversa (reação continua ignorada)", () => {
    const res = parseMetaWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  { from: "5511999990000", id: "u1", type: "unsupported", errors: [{ code: 131051 }] },
                  { from: "5511999990000", id: "r1", type: "reaction", reaction: { emoji: "👍", message_id: "x" } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]!.body).toContain("não suportada");
  });

  it("C30: México (521/52) e Argentina (549/54) não duplicam o lead", async () => {
    const mx = await createLead(env.ctx, { phone: "+52 55 1234 5678" });
    const ar = await createLead(env.ctx, { phone: "+54 11 2345 6789" });
    await inbound(normalizePhone("5215512345678@s.whatsapp.net"), "hola");
    await inbound(normalizePhone("5491123456789@s.whatsapp.net"), "hola");
    await env.settle();
    expect(await allLeads()).toHaveLength(2);
    expect((await messagesOf(mx.id)).some((m) => m.body === "hola")).toBe(true);
    expect((await messagesOf(ar.id)).some((m) => m.body === "hola")).toBe(true);
  });

  it("celular antigo gravado sem o 9 continua sendo achado (sem duplicar)", async () => {
    const [legacy] = await env.ctx.db.insert(leads).values({ phone: "553199998888", source: "whatsapp" }).returning();
    await inbound(normalizePhone("553199998888@s.whatsapp.net"), "voltei");
    await env.settle();
    expect(await allLeads()).toHaveLength(1);
    expect((await messagesOf(legacy!.id)).map((m) => m.body)).toContain("voltei");
  });

  it("migração 0002 converte celulares antigos para o formato com 9 (sem quebrar duplicados)", async () => {
    await env.ctx.db.insert(leads).values([
      { phone: "553199998888", source: "whatsapp" }, // só o formato antigo → converte
      { phone: "553188887777", source: "whatsapp" }, // os dois formatos existem → fica como está
      { phone: "5531988887777", source: "formulario" },
      { phone: "551133334444", source: "manual" }, // fixo → não mexe
    ]);
    const file = readFileSync(new URL("../drizzle/0002_lid_reply_to_br_phones.sql", import.meta.url), "utf8");
    const update = file.split("--> statement-breakpoint").at(-1)!;
    await env.ctx.db.execute(sql.raw(update));
    const phones = (await allLeads()).map((l) => l.phone).sort();
    expect(phones).toEqual(["551133334444", "553188887777", "5531988887777", "5531999998888"]);
  });
});

describe("templates", () => {
  it("H: o texto do autor fica como foi escrito; só o espaço da variável vazia some", async () => {
    const settings = await getSettings(env.ctx.db);
    const ana = await createLead(env.ctx, { phone: "11955554444", name: "Ana" });
    const anon = await createLead(env.ctx, { phone: "11955555555" });
    expect(renderTemplate("Oi {{primeiro_nome}} :) Tudo certo ? Valor : R$ 100", ana, settings)).toBe(
      "Oi Ana :) Tudo certo ? Valor : R$ 100",
    );
    expect(renderTemplate("Planos:\n  1 - Basic\n  2 - Pro", ana, settings)).toBe("Planos:\n  1 - Basic\n  2 - Pro");
    expect(renderTemplate("Oi {{primeiro_nome}}, tudo bem?", anon, settings)).toBe("Oi, tudo bem?");
    expect(renderTemplate("Oi, {{primeiro_nome}}! Tudo bem?", anon, settings)).toBe("Oi! Tudo bem?");
    expect(renderTemplate("{{primeiro_nome}}, tudo bem?", anon, settings)).toBe("tudo bem?");
    expect(renderTemplate("Combinado {{primeiro_nome}} ;) até amanhã", anon, settings)).toBe("Combinado ;) até amanhã");
  });
});

describe("API e segurança", () => {
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

  it("I: PATCH vazio em automação e etapa dá 400 (não 500)", async () => {
    const [seq] = await env.ctx.db.select().from(sequences).limit(1);
    const a = await app.inject({ method: "PATCH", url: `/api/sequences/${seq!.id}`, headers: auth(), payload: {} });
    expect(a.statusCode).toBe(400);
    const b = await app.inject({ method: "PATCH", url: `/api/sequences/${seq!.id}`, headers: auth(), payload: { foo: 1 } });
    expect(b.statusCode).toBe(400);
    const [stage] = await env.ctx.db.select().from(stages).limit(1);
    const c = await app.inject({ method: "PATCH", url: `/api/stages/${stage!.id}`, headers: auth(), payload: {} });
    expect(c.statusCode).toBe(400);
  });

  it("E: withoutTag aceita várias etiquetas", async () => {
    const key = { "x-api-key": "test-key" };
    await app.inject({ method: "POST", url: "/api/integrations/leads", headers: key, payload: { phone: "11966663333", tags: ["follow-up-n8n"] } });
    await app.inject({ method: "POST", url: "/api/integrations/leads", headers: key, payload: { phone: "11966664444", tags: ["follow-up-n8n-pulado"] } });
    await app.inject({ method: "POST", url: "/api/integrations/leads", headers: key, payload: { phone: "11966665555" } });
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/leads?withoutTag=follow-up-n8n,follow-up-n8n-pulado",
      headers: key,
    });
    expect(res.json().items.map((l: { phone: string }) => l.phone)).toEqual(["5511966665555"]);
  });

  it("B: atrás de um proxy (mesmo IP para todos), errar a senha de uma conta não bloqueia as outras", async () => {
    await app.inject({ method: "POST", url: "/api/users", headers: auth(), payload: { name: "Vend", email: "v@x.dev", password: "123456" } });
    for (let i = 0; i < 11; i++) {
      await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@test.dev", password: "errada" } });
    }
    const admin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@test.dev", password: "senha123" } });
    expect(admin.statusCode).toBe(429);
    const other = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "v@x.dev", password: "123456" } });
    expect(other.statusCode).toBe(200);
  });

  it("C12: reset-password derruba os logins abertos", async () => {
    expect((await app.inject({ method: "GET", url: "/api/leads", headers: auth() })).statusCode).toBe(200);
    expect(await resetUserPassword(env.ctx.db, "ADMIN@test.dev", "novaSenha99")).toBe("reset");
    expect((await app.inject({ method: "GET", url: "/api/leads", headers: auth() })).statusCode).toBe(401);
    const [admin] = await env.ctx.db.select().from(users).where(eq(users.email, "admin@test.dev"));
    expect(admin!.tokenVersion).toBe(1);
  });

  it("K: webhook recusado aparece no log como aviso", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const pino = (await import("pino")).default;
    const logger = pino({ level: "info" }, { write: (line: string) => void warnings.push(JSON.parse(line)) });
    const { buildApp } = await import("../src/app.js");
    const evo = await setup({ WHATSAPP_PROVIDER: "evolution" });
    const evoApp = await buildApp(evo.ctx, { logger });
    const res = await evoApp.inject({ method: "POST", url: "/api/webhooks/evolution?token=antigo", payload: { event: "messages.upsert" } });
    expect(res.statusCode).toBe(401);
    const entry = warnings.find((w) => w.msg === "webhook recusado");
    expect(entry).toMatchObject({ level: 40, status: 401 });
    expect(JSON.stringify(entry)).not.toContain("antigo"); // o token não vai para o log
    await evoApp.close();
    await evo.close();
  });
});

describe("login por conta (IP forjável)", () => {
  it("B: trocar de IP a cada tentativa não burla o limite por conta", async () => {
    const proxied = await setup({ TRUST_PROXY: "true" });
    const app = await proxied.app();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-forwarded-for": `203.0.113.${i}` },
        payload: { email: "admin@test.dev", password: "errada" },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
    // nem a senha certa entra enquanto a conta está bloqueada
    const right = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "198.51.100.1" },
      payload: { email: "admin@test.dev", password: "senha123" },
    });
    expect(right.statusCode).toBe(429);
    await app.close();
    await proxied.close();
  });
});

describe("tempo real", () => {
  it("C12: conexão de tempo real aberta é encerrada quando a senha muda", async () => {
    env.ctx.sessionCheckMs = 50;
    const app = await env.app();
    const token = await login(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=${token}`, { signal: AbortSignal.timeout(5_000) });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // event: ready

    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { authorization: `Bearer ${token}` },
      payload: { current: "senha123", next: "outraSenha9" },
    });
    expect(changed.statusCode).toBe(200);

    let done = false;
    let received = "";
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value) received += new TextDecoder().decode(chunk.value);
    }
    expect(done).toBe(true); // o servidor fechou a conexão
    // e nenhum evento depois disso chega por ela
    await createLead(env.ctx, { phone: "11977770000", name: "Depois" });
    expect(received).not.toContain("Depois");
    await app.close();
  });
});

describe("Evolution", () => {
  it("K: na inicialização o webhook é regravado se a instância já existe", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fake = (state: "open" | 404) =>
      (async (url: string, init: RequestInit) => {
        calls.push({ method: String(init.method), url, body: init.body as string | undefined });
        if (url.includes("connectionState")) {
          return state === 404 ? new Response("not found", { status: 404 }) : Response.json({ instance: { state } });
        }
        return Response.json({});
      }) as unknown as typeof fetch;
    const opts = { baseUrl: "http://evo:8080", apiKey: "k", instance: "crm", webhookUrl: "http://crm:3000/api/webhooks/evolution?token=novo" };

    expect(await new EvolutionProvider({ ...opts, fetchImpl: fake("open") }).syncWebhook()).toBe("updated");
    const set = calls.find((c) => c.url.includes("/webhook/set/crm"));
    expect(JSON.parse(set!.body!).webhook.url).toBe(opts.webhookUrl);

    calls.length = 0;
    expect(await new EvolutionProvider({ ...opts, fetchImpl: fake(404) }).syncWebhook()).toBe("no_instance");
    expect(calls.some((c) => c.url.includes("/webhook/set"))).toBe(false);
  });
});
