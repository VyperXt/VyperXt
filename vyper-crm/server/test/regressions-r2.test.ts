// Testes de regressão da 2ª rodada de revisão do PR #1.
import { readFileSync } from "node:fs";
import { AiRateLimitError } from "../src/ai/errors.js";
import { asc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activities, enrollments, leads, messages, sequences, stages, users, type Message } from "../src/db/schema.js";
import { normalizePhone } from "../src/lib/phone.js";
import { runAutoReply, unansweredInbound } from "../src/services/ai-flows.js";
import { renderTemplate, runSchedulerTick } from "../src/services/automation.js";
import { createLead } from "../src/services/leads.js";
import { handleIncoming, sendToLead } from "../src/services/messaging.js";
import { resetUserPassword } from "../src/services/users.js";
import { getSettings, updateSettings } from "../src/settings.js";
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

    // Depois o mesmo contato escreve numa conversa endereçada pelo número (formato da Evolution 2.3.7:
    // remoteJid = número, remoteJidAlt = LID): o lead é o mesmo e ganha o telefone
    const withPhone = parseEvolutionWebhook({
      event: "messages.upsert",
      sender: "5511900000000@s.whatsapp.net",
      data: {
        key: { remoteJid: "5531988887777@s.whatsapp.net", remoteJidAlt: "123456789012345@lid", addressingMode: "pn", fromMe: false, id: "L2" },
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

describe("3ª rodada", () => {
  it("login: rajada em paralelo não passa do limite da conta", async () => {
    const proxied = await setup({ TRUST_PROXY: "true" });
    const app = await proxied.app();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { "x-forwarded-for": `203.0.113.${i}` },
          payload: { email: "admin@test.dev", password: "errada" },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(20);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(20);
    // Redefinir a senha pelo script libera a conta na hora
    await resetUserPassword(proxied.ctx.db, "admin@test.dev", "novaSenha99");
    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": "198.51.100.9" },
      payload: { email: "admin@test.dev", password: "novaSenha99" },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
    await proxied.close();
  });

  it("login: quem erra a senha de propósito não tranca para fora quem já usa o CRM naquele navegador", async () => {
    const proxied = await setup({ TRUST_PROXY: "true" });
    const app = await proxied.app();
    const login = (password: string, ip: string, device?: string, email = "admin@test.dev") =>
      app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": ip }, payload: { email, password, device } });

    // O admin já entrou antes neste navegador e guardou o sinal
    const first = await login("senha123", "198.51.100.1");
    const device = first.json().device as string;
    expect(device).toMatch(/^\d+\.[\w-]+\.[\w-]+$/);

    // Atacante trava a conta trocando de IP
    for (let i = 0; i < 20; i++) await login("errada", `203.0.113.${i}`);
    expect((await login("senha123", "198.51.100.2")).statusCode).toBe(429); // navegador novo: bloqueado
    expect((await login("senha123", "198.51.100.1", device)).statusCode).toBe(200); // navegador de confiança: entra
    // sinal forjado (outro usuário / assinatura errada) não vale
    const forged = device.replace(/^\d+/, "999");
    expect((await login("senha123", "198.51.100.3", forged)).statusCode).toBe(429);
    expect((await login("senha123", "198.51.100.4", `${device}x`)).statusCode).toBe(429);

    // E-mail que não existe responde igual (não revela quais e-mails existem)
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await login("errada", `192.0.2.${i}`, undefined, "ninguem@x.dev")).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes[20]).toBe(429);
    await app.close();
    await proxied.close();
  });

  it("login: IPv6 da mesma faixa /64 conta como um cliente só", async () => {
    const proxied = await setup({ TRUST_PROXY: "true" });
    const app = await proxied.app();
    let last = 0;
    for (let i = 1; i <= 11; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-forwarded-for": `2001:db8:1:2::${i.toString(16)}` },
        payload: { email: "admin@test.dev", password: "errada" },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
    await app.close();
    await proxied.close();
  });

  it("Evolution: LID em remoteJidAlt (mensagem endereçada pelo número) também é guardado", () => {
    const res = parseEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "5531988887777@s.whatsapp.net", remoteJidAlt: "123456789012345:3@lid", fromMe: false, id: "P1" },
        message: { conversation: "oi" },
      },
    });
    expect(res.messages[0]).toMatchObject({ phone: "5531988887777", jid: "123456789012345@lid" });
  });

  it("Evolution: em mensagem sua, os campos alternativos são seus (não do contato)", () => {
    const sender = "5511900000000@s.whatsapp.net";
    // Você responde pelo celular numa conversa por LID: o LID é do contato, o número alternativo é o seu
    const lidChat = parseEvolutionWebhook({
      event: "messages.upsert",
      sender,
      data: { key: { remoteJid: "123456789012345@lid", remoteJidAlt: sender, fromMe: true, id: "M1" }, message: { conversation: "oi" } },
    });
    expect(lidChat.messages[0]).toMatchObject({ phone: null, jid: "123456789012345@lid", fromMe: true });
    // Conversa pelo número: o remoteJidAlt é o SEU LID, não pode ir para o contato
    const pnChat = parseEvolutionWebhook({
      event: "messages.upsert",
      sender,
      data: { key: { remoteJid: "5531988887777@s.whatsapp.net", remoteJidAlt: "999999999999999@lid", fromMe: true, id: "M2" }, message: { conversation: "oi" } },
    });
    expect(pnChat.messages[0]).toMatchObject({ phone: "5531988887777", fromMe: true });
    expect(pnChat.messages[0]!.jid).toBeUndefined();
    // A Evolution trocou o contato pelo seu próprio número: não vira lead
    const self = parseEvolutionWebhook({
      event: "messages.upsert",
      sender,
      data: { key: { remoteJid: sender, remoteJidAlt: sender, fromMe: true, id: "M3" }, message: { conversation: "oi" } },
    });
    expect(self.messages).toHaveLength(0);
  });

  it("lead só com LID é unificado com o lead do telefone quando o número aparece", async () => {
    const form = await createLead(env.ctx, { name: "Paula", phone: "(31) 98888-7777", source: "formulario", chatMode: "human" });
    await inbound(null, "oi, sou eu", { jid: "123456789012345@lid", name: "Paula Zap" });
    await env.settle();
    expect(await allLeads()).toHaveLength(2);
    await inbound("5531988887777", "agora com número", { jid: "123456789012345@lid" });
    await env.settle();
    const rows = await allLeads();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: form.id, phone: "5531988887777", waJid: "123456789012345@lid", name: "Paula", waName: "Paula Zap" });
    const bodies = (await messagesOf(form.id)).map((m) => m.body);
    expect(bodies).toEqual(expect.arrayContaining(["oi, sou eu", "agora com número"]));
    const timeline = await env.ctx.db.select().from(activities).where(eq(activities.leadId, form.id));
    expect(timeline.some((a) => a.type === "merged")).toBe(true);
  });

  it("lead antigo com o LID gravado no telefone é reaproveitado (sem duplicar)", async () => {
    const [legacy] = await env.ctx.db.insert(leads).values({ phone: "123456789012345", source: "whatsapp" }).returning();
    await inbound(null, "voltei", { jid: "123456789012345@lid" });
    await env.settle();
    const rows = await allLeads();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: legacy!.id, phone: null, waJid: "123456789012345@lid" });
  });

  it("com e sem o 9 já duplicados: a conversa continua no lead em que o contato escreveu", async () => {
    const [legacy] = await env.ctx.db
      .insert(leads)
      .values({ phone: "553188887777", source: "whatsapp", chatMode: "human", lastInboundAt: new Date("2026-10-01T12:00:00Z") })
      .returning();
    // par criado por versões antigas (o formulário com o 9, o WhatsApp sem)
    await env.ctx.db.insert(leads).values({ phone: "5531988887777", source: "formulario" });
    await inbound(normalizePhone("553188887777@s.whatsapp.net"), "continuando");
    await env.settle();
    expect((await messagesOf(legacy!.id)).map((m) => m.body)).toContain("continuando");
  });

  it("Argentina: celular no formato local com 15 vira o formato do WhatsApp", () => {
    expect(normalizePhone("+54 11 15 2345-6789")).toBe("5491123456789");
    expect(normalizePhone("+54 341 15 234-5678")).toBe("5493412345678");
    expect(normalizePhone("+54 9 11 2345-6789")).toBe("5491123456789");
  });
});

describe("IA gratuita (OpenRouter)", () => {
  const rateLimit = (daily: boolean) => () => {
    throw new AiRateLimitError(daily ? "Limite diário do OpenRouter atingido" : "OpenRouter ocupado agora", { daily });
  };

  it("acabou a cota do dia: a conversa passa para um humano em vez de ficar sem resposta", async () => {
    env.ai.handlers.reply = rateLimit(true);
    await inbound("5511900008888", "oi, quanto custa?");
    await env.settle();
    const [lead] = await allLeads();
    expect(lead!.chatMode).toBe("human");
    expect(env.eventsOf("lead.handoff")[0]!.body.data.reason).toContain("limite diário");
    expect(env.ai.callsOf("reply")).toHaveLength(1);
    expect(env.wa.sent).toHaveLength(0);
    const timeline = await env.ctx.db.select().from(activities).where(eq(activities.leadId, lead!.id));
    expect(timeline.some((a) => a.type === "handoff")).toBe(true);
  });

  it("limite passageiro (por minuto, modelo ocupado): o bot tenta de novo e responde, sem passar para humano", async () => {
    let calls = 0;
    env.ai.handlers.reply = () => {
      if (++calls === 1) throw new AiRateLimitError("OpenRouter ocupado agora", { daily: false });
      return { reply: "Custa R$ 100.", handoff: false, handoffReason: "" };
    };
    await inbound("5511900009999", "oi, quanto custa?");
    await env.settle();
    const [lead] = await allLeads();
    expect(lead!.chatMode).toBe("bot");
    expect(env.wa.sent.map((m) => m.text)).toEqual(["Custa R$ 100."]);
    expect(env.eventsOf("lead.handoff")).toHaveLength(0);
  });

  it("ocupado em todas as tentativas: depois de 2 novas tentativas passa para um humano", async () => {
    env.ai.handlers.reply = rateLimit(false);
    await inbound("5511900007070", "oi");
    await env.settle();
    const [lead] = await allLeads();
    expect(env.ai.callsOf("reply")).toHaveLength(3);
    expect(lead!.chatMode).toBe("human");
    expect(env.eventsOf("lead.handoff")[0]!.body.data.reason).toContain("ocupada");
  });

  it("se alguém respondeu enquanto a IA esperava, não passa para humano", async () => {
    await updateSettings(env.ctx.db, { bot: { pauseOnPhoneReply: false } });
    env.ai.handlers.reply = async () => {
      const [lead] = await allLeads();
      await sendToLead(env.ctx, lead!.id, "Oi! Já te respondo o preço.", { author: "agent" });
      throw new AiRateLimitError("Limite diário do OpenRouter atingido", { daily: true });
    };
    await inbound("5511900006060", "oi, quanto custa?");
    await env.settle();
    const [lead] = await allLeads();
    expect(lead!.chatMode).toBe("bot");
    expect(env.eventsOf("lead.handoff")).toHaveLength(0);
  });

  it("formulário do n8n: sem cota para qualificar, o lead ainda recebe as boas-vindas", async () => {
    env.ai.handlers.qualify = rateLimit(true);
    const app = await env.app();
    const res = await app.inject({
      method: "POST",
      url: "/api/integrations/leads",
      headers: { "x-api-key": "test-key" },
      payload: { name: "Bia", phone: "11955556666", qualify: true, welcomeMessage: "Oi {{primeiro_nome}}!" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: true, welcome: { sent: true }, qualify: { ok: false } });
    expect(env.wa.sent.map((m) => m.text)).toEqual(["Oi Bia!"]);
    await app.close();
  });

  it("follow-up com IA sem cota: o passo volta para a fila e a rodada para", async () => {
    const [seq] = await env.ctx.db.select().from(sequences).where(eq(sequences.trigger, "no_reply"));
    await env.ctx.db.update(sequences).set({ active: true }).where(eq(sequences.id, seq!.id));
    const a = await createLead(env.ctx, { phone: "11955557777", chatMode: "human" });
    const b = await createLead(env.ctx, { phone: "11955558888", chatMode: "human" });
    await sendToLead(env.ctx, a.id, "Conseguiu ver a proposta?", { author: "agent" });
    await sendToLead(env.ctx, b.id, "Conseguiu ver a proposta?", { author: "agent" });
    env.ai.handlers.followup = rateLimit(true);
    env.advanceMinutes(60 * 25);
    await runSchedulerTick(env.ctx);
    const rows = await env.ctx.db.select().from(enrollments).orderBy(asc(enrollments.id));
    expect(rows.map((r) => [r.status, r.stepIndex])).toEqual([
      ["active", 0],
      ["active", 0],
    ]);
    expect(rows[0]!.nextRunAt!.getTime()).toBeGreaterThan(env.ctx.now().getTime()); // reagendado
    expect(env.ai.callsOf("followup")).toHaveLength(1); // a rodada parou no primeiro limite
    const failed = await env.ctx.db.select().from(activities).where(eq(activities.type, "followup_failed"));
    expect(failed).toHaveLength(0);
  });
});
