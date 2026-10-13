import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leads, messages } from "../src/db/schema.js";
import { sendImageToLead } from "../src/services/messaging.js";
import { EvolutionProvider } from "../src/whatsapp/evolution.js";
import { MetaCloudProvider } from "../src/whatsapp/meta.js";
import { NOT_ON_WHATSAPP_ERROR, WhatsAppNumberNotFoundError } from "../src/whatsapp/types.js";
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

const start = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/conversations/start", headers: auth(), payload });

async function leadCount(): Promise<number> {
  const [row] = await env.ctx.db.select({ n: sql<number>`count(*)::int` }).from(leads);
  return row?.n ?? 0;
}

describe("nova conversa (POST /api/conversations/start)", () => {
  it("exige login", async () => {
    const res = await app.inject({ method: "POST", url: "/api/conversations/start", payload: { phone: "11999998888" } });
    expect(res.statusCode).toBe(401);
  });

  // O padrão dos leads novos é a IA responder (bot.defaultMode = "bot"); aqui quem escreve é você
  it("cria o lead em modo humano, sem enviar nada", async () => {
    const res = await start({ phone: "(11) 97777-6666", name: "  Carla  " });
    expect(res.statusCode).toBe(200);
    const { lead, created, warning } = res.json();
    expect(created).toBe(true);
    expect(warning).toBeNull();
    expect(lead).toMatchObject({ phone: "5511977776666", name: "Carla", source: "manual", chatMode: "human" });
    expect(env.wa.sent).toHaveLength(0);
    // Sem mensagens ainda: não aparece na lista de conversas
    const list = await app.inject({ method: "GET", url: "/api/conversations", headers: auth() });
    expect(list.json()).toHaveLength(0);
  });

  it("número que já é lead: devolve o existente (inclusive com/sem o 9)", async () => {
    const first = (await start({ phone: "11977776666", name: "Carla" })).json();
    expect(first.created).toBe(true);

    const again = await start({ phone: "+55 11 97777-6666", name: "Outro nome" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, lead: { id: first.lead.id, name: "Carla" } });

    // Digitado sem o 9 (formato antigo do celular)
    const without9 = (await start({ phone: "1177776666" })).json();
    expect(without9).toMatchObject({ created: false, lead: { id: first.lead.id } });

    // Lead antigo gravado sem o 9: digitar com o 9 acha o mesmo contato
    const [legacy] = await env.ctx.db.insert(leads).values({ name: "Legado", phone: "553188887777" }).returning();
    const withNine = (await start({ phone: "31988887777" })).json();
    expect(withNine).toMatchObject({ created: false, lead: { id: legacy!.id } });

    expect(await leadCount()).toBe(2);
  });

  it("telefone inválido → 400 com mensagem amigável", async () => {
    for (const phone of ["123", "abc", "", "1".repeat(16)]) {
      const res = await start({ phone });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Telefone inválido. Use DDD + número (ex.: 11999998888).");
    }
    expect((await start({})).statusCode).toBe(400);
    expect(await leadCount()).toBe(0);
  });

  it("número sem WhatsApp → 422 e nenhum lead criado", async () => {
    env.wa.missingNumbers.add("5511955554444");
    const res = await start({ phone: "11955554444", name: "Sem zap" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("Este número não tem WhatsApp.");
    expect(await leadCount()).toBe(0);
  });

  it("não deu para conferir o número (WhatsApp fora do ar): cria mesmo assim", async () => {
    const check = vi.spyOn(env.wa, "checkNumber").mockRejectedValue(new Error("instância desconectada"));
    const res = await start({ phone: "11955554444" });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(true);
    expect(check).toHaveBeenCalledWith("5511955554444");
  });

  it("corrida: o contato foi criado durante a conferência → devolve o existente", async () => {
    let raced: number | undefined;
    vi.spyOn(env.wa, "checkNumber").mockImplementation(async (phone) => {
      // Ex.: o contato mandou mensagem bem nessa hora e o webhook criou o lead
      const [row] = await env.ctx.db.insert(leads).values({ name: "Do webhook", phone }).returning();
      raced = row!.id;
      return { exists: true, jid: `${phone}@s.whatsapp.net` };
    });
    const res = await start({ phone: "11955554444" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: false, lead: { id: raced, name: "Do webhook" } });
    expect(await leadCount()).toBe(1);
  });

  it("não confere o número de quem já é lead", async () => {
    const lead = (await start({ phone: "11955554444" })).json().lead;
    // Mesmo que o contato tenha saído do WhatsApp depois, a conversa existente abre normalmente
    env.wa.missingNumbers.add("5511955554444");
    const check = vi.spyOn(env.wa, "checkNumber");
    const res = await start({ phone: "11955554444" });
    expect(res.json()).toMatchObject({ created: false, lead: { id: lead.id } });
    expect(check).not.toHaveBeenCalled();
  });

  it("depois de iniciar, enviar funciona e a conversa entra na lista", async () => {
    const { lead } = (await start({ phone: "11977776666", name: "Carla" })).json();
    const sent = await app.inject({
      method: "POST",
      url: `/api/leads/${lead.id}/messages`,
      headers: auth(),
      payload: { body: "Oi, Carla! Tudo bem?" },
    });
    expect(sent.statusCode).toBe(200);
    expect(env.wa.sent[0]).toMatchObject({ phone: "5511977776666", text: "Oi, Carla! Tudo bem?" });
    const list = (await app.inject({ method: "GET", url: "/api/conversations", headers: auth() })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ lead: { id: lead.id }, lastMessage: { body: "Oi, Carla! Tudo bem?" } });
  });

  it("API oficial da Meta: avisa quando o contato não escreveu nas últimas 24h", async () => {
    env.ctx.wa = new MetaCloudProvider({ accessToken: "t", phoneNumberId: "1", graphVersion: "v21.0" });
    const res = (await start({ phone: "11977776666" })).json();
    expect(res.created).toBe(true);
    expect(res.warning).toMatch(/template/);

    // Contato escreveu há 2h: dentro da janela, sem aviso
    const twoHoursAgo = new Date(env.ctx.now().getTime() - 2 * 60 * 60 * 1000);
    await env.ctx.db.update(leads).set({ lastInboundAt: twoHoursAgo }).where(eq(leads.id, res.lead.id));
    const again = (await start({ phone: "11977776666" })).json();
    expect(again).toMatchObject({ created: false, warning: null });
  });
});

describe("envio para número sem WhatsApp", () => {
  async function newLead(phone = "11955554444") {
    return (await start({ phone, name: "Sem zap" })).json().lead as { id: number };
  }

  it("texto: grava o erro amigável (não o JSON da Evolution) e responde 422", async () => {
    const lead = await newLead();
    // Como no caso real: o número saiu do WhatsApp depois de virar lead (o simulador falha como a Evolution)
    env.wa.missingNumbers.add("5511955554444");
    const res = await app.inject({
      method: "POST",
      url: `/api/leads/${lead.id}/messages`,
      headers: auth(),
      payload: { body: "Oi! Tudo bem?" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("Este número não tem WhatsApp (conferido com e sem o 9). Confira o número na ficha do lead.");
    expect(env.wa.sent).toHaveLength(0);
    const [msg] = await env.ctx.db.select().from(messages).where(eq(messages.leadId, lead.id));
    expect(msg).toMatchObject({ status: "failed", error: NOT_ON_WHATSAPP_ERROR, body: "Oi! Tudo bem?" });
  });

  it("imagem: mesmo tratamento", async () => {
    const lead = await newLead("11977776666");
    env.wa.missingNumbers.add("551177776666"); // gravado sem o 9: vale para as duas formas
    const err = await sendImageToLead(
      env.ctx,
      lead.id,
      { data: Buffer.from([1, 2, 3]), mimeType: "image/png", caption: "Olha" },
      { author: "agent" },
    ).catch((e: unknown) => e as { statusCode: number; message: string });
    expect(err).toMatchObject({ statusCode: 422 });
    const [msg] = await env.ctx.db.select().from(messages).where(eq(messages.leadId, lead.id));
    expect(msg).toMatchObject({ status: "failed", error: NOT_ON_WHATSAPP_ERROR, mediaType: "image" });
  });

  it("outras falhas continuam com a mensagem original (502)", async () => {
    const lead = await newLead();
    env.wa.failNext = "instância desconectada";
    const res = await app.inject({
      method: "POST",
      url: `/api/leads/${lead.id}/messages`,
      headers: auth(),
      payload: { body: "Oi" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("Falha ao enviar pelo WhatsApp: instância desconectada");
    const [msg] = await env.ctx.db.select().from(messages).where(eq(messages.leadId, lead.id));
    expect(msg).toMatchObject({ status: "failed", error: "instância desconectada" });
  });
});

function evolution(respond: (url: string, body: unknown) => Response) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url, body });
    return respond(url, body);
  }) as unknown as typeof fetch;
  const wa = new EvolutionProvider({
    baseUrl: "http://evo.test/",
    apiKey: "k",
    instance: "crm",
    webhookUrl: "http://crm.test/api/webhooks/evolution",
    fetchImpl,
  });
  return { wa, requests };
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("EvolutionProvider: envio para número sem WhatsApp", () => {
  // Resposta real da Evolution (incidente com um lead da prospecção, número antigo de 8 dígitos)
  const notFound = () =>
    json(
      {
        status: 400,
        error: "Bad Request",
        response: { message: [{ jid: "553194235519@s.whatsapp.net", exists: false, number: "5531994235519" }] },
      },
      400,
    );

  it("sendText e sendImage: 400 com exists:false → WhatsAppNumberNotFoundError com a mensagem amigável", async () => {
    const { wa } = evolution(notFound);
    const err = await wa.sendText("5531994235519", "Oi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhatsAppNumberNotFoundError);
    expect((err as Error).message).toBe(NOT_ON_WHATSAPP_ERROR);
    expect((err as WhatsAppNumberNotFoundError).detail).toContain('"exists":false');
    await expect(
      wa.sendImage("5531994235519", { data: Buffer.from([1]), mimeType: "image/png" }),
    ).rejects.toBeInstanceOf(WhatsAppNumberNotFoundError);
  });

  it("outros erros continuam como estão", async () => {
    const other = evolution(() => json({ status: 400, error: "Bad Request", response: { message: ["text is required"] } }, 400));
    const err = await other.wa.sendText("5531994235519", "").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(WhatsAppNumberNotFoundError);
    expect((err as Error).message.startsWith("Evolution API POST /message/sendText/crm → 400: ")).toBe(true);
    // exists:true no corpo não é "sem WhatsApp"; 500 também não
    const exists = evolution(() => json({ response: { message: [{ exists: true, number: "5531994235519" }] } }, 400));
    await expect(exists.wa.sendText("5531994235519", "Oi")).rejects.not.toBeInstanceOf(WhatsAppNumberNotFoundError);
    const down = evolution(() => json({ response: { message: [{ exists: false }] } }, 500));
    await expect(down.wa.sendText("5531994235519", "Oi")).rejects.toThrow(/→ 500/);
    await expect(down.wa.sendText("5531994235519", "Oi")).rejects.not.toBeInstanceOf(WhatsAppNumberNotFoundError);
  });
});

describe("EvolutionProvider.checkNumber", () => {
  const provider = evolution;

  it("número com WhatsApp (o jid pode vir sem o 9)", async () => {
    const { wa, requests } = provider(() =>
      json([{ exists: true, jid: "551177776666@s.whatsapp.net", number: "5511977776666", name: "Carla" }]),
    );
    expect(await wa.checkNumber("5511977776666")).toEqual({ exists: true, jid: "551177776666@s.whatsapp.net" });
    expect(requests).toEqual([{ url: "http://evo.test/chat/whatsappNumbers/crm", body: { numbers: ["5511977776666"] } }]);
  });

  it("número sem WhatsApp", async () => {
    const { wa } = provider(() => json([{ exists: false, jid: "5511955554444@s.whatsapp.net", number: "5511955554444" }]));
    expect(await wa.checkNumber("5511955554444")).toEqual({ exists: false, jid: null });
  });

  it("aceita a lista dentro de { response } e escolhe o item do número pedido", async () => {
    const { wa } = provider(() =>
      json({
        response: [
          { exists: false, jid: "x", number: "5521900000000" },
          { exists: true, jid: "5511955554444@s.whatsapp.net", number: "+55 11 95555-4444" },
        ],
      }),
    );
    expect(await wa.checkNumber("5511955554444")).toMatchObject({ exists: true });
  });

  it("resposta inesperada ou erro HTTP → lança (o CRM trata como 'não deu para conferir')", async () => {
    await expect(provider(() => json([])).wa.checkNumber("5511955554444")).rejects.toThrow(/resposta inesperada/);
    await expect(provider(() => json({ ok: true })).wa.checkNumber("5511955554444")).rejects.toThrow(/resposta inesperada/);
    await expect(
      provider(() => json({ error: "Connection Closed" }, 500)).wa.checkNumber("5511955554444"),
    ).rejects.toThrow(/500/);
  });
});
