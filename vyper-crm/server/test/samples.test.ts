import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiError, AiRateLimitError } from "../src/ai/provider.js";
import { leads, leadSamples, messages } from "../src/db/schema.js";
import { handleIncoming } from "../src/services/messaging.js";
import { maybeAutoSample, recoverInterruptedSamples, slugify } from "../src/services/samples.js";
import { updateSettings } from "../src/settings.js";
import { login, setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
let app: Awaited<ReturnType<TestEnv["app"]>>;
let token: string;

beforeEach(async () => {
  env = await setup({ WHATSAPP_PROVIDER: "simulator" });
  app = await env.app();
  token = await login(app);
});
afterEach(async () => {
  await app.close();
  await env.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function createLead(payload: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/leads",
    headers: auth(),
    payload: { name: "Ana", company: "Padaria Pão de Açúcar", phone: "11 98888-7777", ...payload },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: number; phone: string };
}

async function request(leadId: number, payload: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: `/api/leads/${leadId}/samples`, headers: auth(), payload });
}

async function listSamples(leadId: number) {
  return (await app.inject({ method: "GET", url: `/api/leads/${leadId}/samples`, headers: auth() })).json() as Array<
    Record<string, any>
  >;
}

async function getSample(id: number) {
  return (await app.inject({ method: "GET", url: `/api/samples/${id}`, headers: auth() })).json() as Record<string, any>;
}

async function readySample(leadId: number, payload: Record<string, unknown> = {}) {
  const res = await request(leadId, payload);
  expect(res.statusCode).toBe(202);
  await env.settle();
  const sample = await getSample(res.json().sample.id);
  expect(sample.status).toBe("ready");
  return sample;
}

/** Mensagem do lead chegando pelo WhatsApp (dispara qualificação + bot) */
async function inbound(body: string, phone = "5511977776666") {
  await handleIncoming(env.ctx, { phone, name: "Lead Quente", body, mediaType: "text", fromMe: false, externalId: `in-${Math.random()}` });
  await env.settle();
  const [lead] = await env.ctx.db.select().from(leads).where(eq(leads.phone, phone));
  return lead!;
}

const quente = () => ({
  name: "",
  email: "",
  company: "",
  interest: "site",
  budget: "",
  timeline: "",
  score: 90,
  temperature: "quente",
  summary: "Quer fechar.",
  suggestedStage: "",
  tags: [],
});

describe("amostras automáticas", () => {
  it("lead quente → o Claude cria um site demo (sem enviar nada ao lead) e o OpenRouter não é usado para isso", async () => {
    env.ai.handlers.qualify = quente;
    const lead = await inbound("Quero fechar o site, quanto fica?");

    const samples = await listSamples(lead.id);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ kind: "site", status: "ready", trigger: "hot", hasPreview: true });
    expect(samples[0]!.content).toBeUndefined();
    expect(env.claude.callsOf("sample_site")).toHaveLength(1);
    expect(env.ai.callsOf("sample_site")).toHaveLength(0);
    // O prompt leva a conversa e o contexto da empresa; o tempo limite é longo
    const call = env.claude.callsOf("sample_site")[0]!;
    expect(call.prompt).toContain("Quero fechar o site");
    expect(call.system).toContain("Demonstração criada por");
    expect(call.timeoutMs).toBe(10 * 60_000);
    // Só a resposta do bot saiu; a amostra espera a sua revisão
    expect(env.wa.sent.every((m) => !m.text.includes("demo.test"))).toBe(true);
    expect(env.publisher.deploys).toHaveLength(0);
    // Painel avisado; n8n não
    expect(env.eventsOf("sample.updated")).toHaveLength(0);
  });

  it("conversa passada para humano → gera a amostra no tipo padrão das configurações", async () => {
    await updateSettings(env.ctx.db, { samples: { defaultKind: "image" } });
    env.ai.handlers.reply = () => ({ reply: "Vou chamar alguém da equipe!", handoff: true, handoffReason: "quer fechar" });
    const lead = await inbound("Quero falar com uma pessoa");

    const samples = await listSamples(lead.id);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ kind: "image", status: "ready", trigger: "handoff" });
  });

  it("não gera quando desligado, sem Claude, com amostra existente, sem telefone ou com opt-out", async () => {
    env.ai.handlers.qualify = quente;

    await updateSettings(env.ctx.db, { samples: { autoGenerate: false } });
    let lead = await inbound("Quero fechar", "5511911110001");
    expect(await listSamples(lead.id)).toHaveLength(0);

    await updateSettings(env.ctx.db, { samples: { autoGenerate: true, onHot: false } });
    lead = await inbound("Quero fechar", "5511911110002");
    expect(await listSamples(lead.id)).toHaveLength(0);

    await updateSettings(env.ctx.db, { samples: { onHot: true } });
    env.ctx.claude = null;
    lead = await inbound("Quero fechar", "5511911110003");
    expect(await listSamples(lead.id)).toHaveLength(0);
    env.ctx.claude = env.claude;

    // Já tem uma amostra pronta → não cria outra
    const withSample = await createLead({ phone: "11 91111-0004" });
    await readySample(withSample.id);
    await maybeAutoSample(env.ctx, withSample.id, "hot");
    await env.settle();
    expect(await listSamples(withSample.id)).toHaveLength(1);

    // Uma amostra descartada não impede uma nova
    const discarded = await createLead({ phone: "11 91111-0005" });
    const old = await readySample(discarded.id);
    await app.inject({ method: "POST", url: `/api/samples/${old.id}/discard`, headers: auth() });
    await maybeAutoSample(env.ctx, discarded.id, "handoff");
    await env.settle();
    expect((await listSamples(discarded.id)).map((s) => s.status)).toEqual(["ready", "discarded"]);

    const optedOut = await createLead({ phone: "11 91111-0006" });
    await env.ctx.db.update(leads).set({ optedOut: true }).where(eq(leads.id, optedOut.id));
    await maybeAutoSample(env.ctx, optedOut.id, "hot");

    const noPhone = await createLead({ phone: null, email: "x@y.com" });
    await maybeAutoSample(env.ctx, noPhone.id, "hot");
    await env.settle();
    expect(await listSamples(optedOut.id)).toHaveLength(0);
    expect(await listSamples(noPhone.id)).toHaveLength(0);
  });
});

describe("amostras manuais", () => {
  it("pedido → 202 gerando → pronto, com o HTML só no detalhe", async () => {
    const lead = await createLead();
    let finish: (v: unknown) => void = () => {};
    env.claude.handlers.sample_site = () =>
      new Promise((resolve) => (finish = resolve)).then(() => ({
        title: "Site demo",
        html: "```html\n<!doctype html><html><head><title>x</title></head><body><h1>Pão de Açúcar</h1></body></html>\n```",
        caption: "Oi! Fiz uma prévia do site de vocês:",
        notes: "Endereço genérico.",
      }));

    const res = await request(lead.id, { kind: "site", instruction: "  use tons de verde  " });
    expect(res.statusCode).toBe(202);
    const created = res.json().sample;
    expect(created).toMatchObject({ status: "generating", trigger: "manual", kind: "site", instruction: "use tons de verde" });

    // Enquanto gera: um segundo pedido é recusado
    await new Promise((r) => setTimeout(r, 20));
    expect((await request(lead.id)).statusCode).toBe(409);

    finish(null);
    await env.settle();
    const sample = await getSample(created.id);
    expect(sample).toMatchObject({
      status: "ready",
      title: "Site demo",
      caption: "Oi! Fiz uma prévia do site de vocês:",
      notes: "Endereço genérico.",
    });
    // Cercas de markdown retiradas e noindex garantido
    expect(sample.content.startsWith("<!doctype html>")).toBe(true);
    expect(sample.content).toContain('name="robots" content="noindex');
    expect(env.claude.callsOf("sample_site")[0]!.prompt).toContain("Pedido do vendedor para esta versão: use tons de verde");
    expect((await listSamples(lead.id))[0]).toMatchObject({ hasPreview: true, status: "ready" });
  });

  it("arte: o SVG vira PNG de verdade (data URL no detalhe)", async () => {
    const lead = await createLead();
    const sample = await readySample(lead.id, { kind: "image" });
    expect(sample.content).toContain("<svg");
    expect(sample.imagePng).toMatch(/^data:image\/png;base64,/);
    const png = Buffer.from(sample.imagePng.split(",")[1], "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(1080); // largura
    expect(png.readUInt32BE(20)).toBe(1350); // altura
  });

  it("falha do Claude fica registrada (limite da assinatura com a mensagem dele) e dá para tentar de novo", async () => {
    const lead = await createLead();
    env.claude.handlers.sample_site = () => {
      throw new AiRateLimitError("Limite de uso do Claude atingido — libera às 23:00.", { daily: true });
    };
    const res = await request(lead.id);
    await env.settle();
    expect(await getSample(res.json().sample.id)).toMatchObject({
      status: "failed",
      error: "Limite de uso do Claude atingido — libera às 23:00.",
    });

    env.claude.handlers.sample_site = () => ({ title: "x", html: "só texto, sem página", caption: "", notes: "" });
    const again = await request(lead.id);
    expect(again.statusCode).toBe(202);
    await env.settle();
    expect((await getSample(again.json().sample.id)).error).toMatch(/página HTML completa/);
  });

  it("sem Claude Code: 503 com a dica de configuração", async () => {
    const lead = await createLead();
    env.ctx.claude = null;
    const res = await request(lead.id);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/CLAUDE_CODE_ENABLED=true/);
  });

  it("valida o pedido e o lead", async () => {
    const lead = await createLead();
    expect((await request(lead.id, { kind: "video" })).statusCode).toBe(400);
    expect((await request(lead.id, { instruction: "x".repeat(1001) })).statusCode).toBe(400);
    expect((await request(99999)).statusCode).toBe(404);
  });

  it("reinício do servidor: amostra que estava sendo gerada vira falha", async () => {
    const lead = await createLead();
    await env.ctx.db.insert(leadSamples).values({ leadId: lead.id, kind: "site", trigger: "manual" });
    expect(await recoverInterruptedSamples(env.ctx)).toBe(1);
    const [row] = await listSamples(lead.id);
    expect(row).toMatchObject({ status: "failed", error: expect.stringMatching(/reiniciou/) });
  });
});

describe("publicar, enviar e descartar", () => {
  it("publicar dá uma pasta própria e mantém no ar os demos anteriores (menos os descartados)", async () => {
    const a = await readySample((await createLead({ phone: "11 92222-0001", company: "Clínica Sorriso" })).id);
    const b = await readySample((await createLead({ phone: "11 92222-0002", company: "Ótica Visão" })).id);
    const c = await readySample((await createLead({ phone: "11 92222-0003", company: "Bar do Zé" })).id);

    const pubA = await app.inject({ method: "POST", url: `/api/samples/${a.id}/publish`, headers: auth() });
    expect(pubA.statusCode).toBe(200);
    expect(pubA.json().slug).toMatch(/^clinica-sorriso-[0-9a-f]{10}$/);
    expect(pubA.json().publicUrl).toBe(`https://demo.test/${pubA.json().slug}/`);
    expect(env.publisher.lastPaths()).toEqual([`/${pubA.json().slug}/index.html`]);

    const pubB = (await app.inject({ method: "POST", url: `/api/samples/${b.id}/publish`, headers: auth() })).json();
    expect(env.publisher.lastPaths().sort()).toEqual([`/${pubA.json().slug}/index.html`, `/${pubB.slug}/index.html`].sort());

    // Descartar A tira ele do ar; C entra junto com B
    await app.inject({ method: "POST", url: `/api/samples/${a.id}/discard`, headers: auth() });
    await env.settle();
    expect(env.publisher.lastPaths()).toEqual([`/${pubB.slug}/index.html`]);
    const pubC = (await app.inject({ method: "POST", url: `/api/samples/${c.id}/publish`, headers: auth() })).json();
    expect(env.publisher.lastPaths().sort()).toEqual([`/${pubB.slug}/index.html`, `/${pubC.slug}/index.html`].sort());
    expect(env.publisher.deploys.at(-1)!.find((f) => f.path.startsWith(`/${pubC.slug}`))!.content).toContain("<html");
  });

  it("sem Netlify: 503; erro do Netlify não grava a pasta; arte não se publica", async () => {
    const lead = await createLead();
    const site = await readySample(lead.id);
    env.ctx.publisher = null;
    const res = await app.inject({ method: "POST", url: `/api/samples/${site.id}/publish`, headers: auth() });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/NETLIFY_AUTH_TOKEN/);

    env.ctx.publisher = env.publisher;
    env.publisher.failNext = "Netlify fora do ar";
    expect((await app.inject({ method: "POST", url: `/api/samples/${site.id}/publish`, headers: auth() })).statusCode).toBe(502);
    expect((await getSample(site.id)).slug).toBeNull();

    await app.inject({ method: "POST", url: `/api/samples/${site.id}/discard`, headers: auth() });
    const image = await readySample(lead.id, { kind: "image" });
    expect((await app.inject({ method: "POST", url: `/api/samples/${image.id}/publish`, headers: auth() })).statusCode).toBe(400);
  });

  it("enviar site: publica, manda legenda + link pelo WhatsApp, marca enviada e você assume a conversa", async () => {
    const lead = await createLead();
    await env.ctx.db.update(leads).set({ chatMode: "bot", unreadCount: 2 }).where(eq(leads.id, lead.id));
    const sample = await readySample(lead.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/samples/${sample.id}/send`,
      headers: auth(),
      payload: { caption: "  Oi Ana! Olha a prévia do site:  " },
    });
    expect(res.statusCode).toBe(200);
    const sent = res.json();
    expect(sent).toMatchObject({ status: "sent", caption: "Oi Ana! Olha a prévia do site:" });
    expect(sent.publicUrl).toMatch(/^https:\/\/demo\.test\/padaria-pao-de-acucar-[0-9a-f]{10}\/$/);
    expect(env.wa.sent.at(-1)).toMatchObject({ phone: lead.phone, text: `Oi Ana! Olha a prévia do site:\n\n${sent.publicUrl}` });

    const [msg] = await env.ctx.db.select().from(messages).where(eq(messages.leadId, lead.id));
    expect(msg).toMatchObject({ direction: "out", author: "agent", status: "sent", mediaType: "text" });
    const [fresh] = await env.ctx.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(fresh).toMatchObject({ chatMode: "human", unreadCount: 0 });
    expect(fresh!.lastMessageAt).not.toBeNull();
    expect(env.publisher.deploys).toHaveLength(1);
  });

  it("enviar arte: manda a imagem com legenda e registra a mensagem como imagem", async () => {
    const lead = await createLead();
    const sample = await readySample(lead.id, { kind: "image" });
    const res = await app.inject({
      method: "POST",
      url: `/api/samples/${sample.id}/send`,
      headers: auth(),
      payload: { caption: "Fiz essa arte para vocês!" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("sent");
    const out = env.wa.sent.at(-1)!;
    expect(out).toMatchObject({ phone: lead.phone, text: "Fiz essa arte para vocês!" });
    expect(out.image).toMatchObject({ mimeType: "image/png" });
    expect(out.image!.bytes).toBeGreaterThan(1000);
    const [msg] = await env.ctx.db.select().from(messages).where(eq(messages.leadId, lead.id));
    expect(msg).toMatchObject({ mediaType: "image", body: "[imagem] Fiz essa arte para vocês!", status: "sent", author: "agent" });
    expect(env.publisher.deploys).toHaveLength(0);
  });

  it("falha no WhatsApp: a amostra continua pronta e a mensagem fica como falha", async () => {
    const lead = await createLead();
    const sample = await readySample(lead.id, { kind: "image" });
    env.wa.failNext = "desconectado";
    const res = await app.inject({ method: "POST", url: `/api/samples/${sample.id}/send`, headers: auth(), payload: { caption: "" } });
    expect(res.statusCode).toBe(502);
    expect((await getSample(sample.id)).status).toBe("ready");
    const [msg] = await env.ctx.db.select().from(messages).where(eq(messages.leadId, lead.id));
    expect(msg).toMatchObject({ status: "failed", body: "[imagem]", mediaType: "image" });
  });

  it("provedor sem envio de imagem: 400 explicando", async () => {
    const lead = await createLead();
    const sample = await readySample(lead.id, { kind: "image" });
    (env.wa as { sendImage?: unknown }).sendImage = undefined;
    const res = await app.inject({ method: "POST", url: `/api/samples/${sample.id}/send`, headers: auth(), payload: { caption: "x" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/não envia imagens/);
  });

  it("descartar durante a geração: o resultado que chegar depois é ignorado", async () => {
    const lead = await createLead();
    let finish: (v: unknown) => void = () => {};
    env.claude.handlers.sample_site = () =>
      new Promise((resolve) => (finish = resolve)).then(() => {
        throw new AiError("tarde demais");
      });
    const res = await request(lead.id);
    await new Promise((r) => setTimeout(r, 20));
    const discarded = await app.inject({ method: "POST", url: `/api/samples/${res.json().sample.id}/discard`, headers: auth() });
    expect(discarded.json().status).toBe("discarded");
    finish(null);
    await env.settle();
    expect(await getSample(res.json().sample.id)).toMatchObject({ status: "discarded", error: null });
    // Amostra descartada não se envia
    const send = await app.inject({ method: "POST", url: `/api/samples/${res.json().sample.id}/send`, headers: auth(), payload: { caption: "x" } });
    expect(send.statusCode).toBe(409);
  });

  it("slug sem acentos nem símbolos", () => {
    expect(slugify("  Padaria Pão & Café — Centro!  ")).toBe("padaria-pao-cafe-centro");
    expect(slugify("***")).toBe("demo");
  });
});
