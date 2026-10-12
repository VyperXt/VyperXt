import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup, login, type TestEnv } from "./helpers.js";
import { getQueueState, setQueueState, updateSettings } from "../src/settings.js";
import { leads, messages, playbooks, scheduledMessages } from "../src/db/schema.js";
import { runSchedulerTick, resetLastAutomationSendAtForTest } from "../src/services/automation.js";
import { SimulatorProvider } from "../src/whatsapp/simulator.js";
import { eq, inArray } from "drizzle-orm";

let env: TestEnv;
let app: Awaited<ReturnType<TestEnv["app"]>>;
let token: string;

beforeEach(async () => {
  resetLastAutomationSendAtForTest();
  env = await setup();
  app = await env.app();
  token = await login(app);
});

afterEach(async () => {
  await app.close();
  await env.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe("Roteiros (Playbooks) e Notificação de Handoff", () => {
  it("CRUD de playbooks", async () => {
    // 1. Lista vazia
    const empty = await app.inject({ method: "GET", url: "/api/playbooks", headers: auth() });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    // 2. Criação
    const createRes = await app.inject({
      method: "POST",
      url: "/api/playbooks",
      headers: auth(),
      payload: {
        name: "Roteiro Eletricistas",
        goal: "Fazer o eletricista criar conta grátis no OrcaEasy",
        offer: "App OrcaEasy gratuito para orçamentos",
        instructions: "Focar em agilidade no WhatsApp",
        handoffRules: "Quando pedir desconto no plano pro",
        firstMessage: "Oi {primeiro_nome}, tudo bem com a {empresa}?",
      },
    });
    expect(createRes.statusCode).toBe(200);
    const pb = createRes.json();
    expect(pb.id).toBeTypeOf("number");
    expect(pb.name).toBe("Roteiro Eletricistas");
    expect(pb.leadCount).toBe(0);

    // 3. Cria lead associado
    const leadRes = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: auth(),
      payload: { name: "Marcos Eletricista", phone: "11988880001", playbookId: pb.id },
    });
    expect(leadRes.statusCode).toBe(200);
    expect(leadRes.json().playbookId).toBe(pb.id);

    // 4. Lista deve conter leadCount = 1
    const listRes = await app.inject({ method: "GET", url: "/api/playbooks", headers: auth() });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(pb.id);
    expect(list[0].leadCount).toBe(1);

    // 5. Atualização parcial (PATCH)
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/playbooks/${pb.id}`,
      headers: auth(),
      payload: { name: "Roteiro Eletricistas VIP" },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().name).toBe("Roteiro Eletricistas VIP");
    expect(patchRes.json().leadCount).toBe(1);

    // 6. Exclusão (DELETE)
    const delRes = await app.inject({ method: "DELETE", url: `/api/playbooks/${pb.id}`, headers: auth() });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json()).toEqual({ ok: true });

    // 7. O lead perde a referência (on delete set null)
    const getLeadRes = await app.inject({ method: "GET", url: `/api/leads/${leadRes.json().id}`, headers: auth() });
    expect(getLeadRes.statusCode).toBe(200);
    expect(getLeadRes.json().lead.playbookId).toBeNull();
  });

  it("filtro de GET /api/leads por source e playbookId (none ou id)", async () => {
    // Cria playbook
    const pbRes = await app.inject({
      method: "POST",
      url: "/api/playbooks",
      headers: auth(),
      payload: { name: "Roteiro Teste" },
    });
    const pbId = pbRes.json().id;

    // Lead 1: manual, sem roteiro
    const l1 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead 1", phone: "11911110001", source: "manual" },
      })
    ).json();

    // Lead 2: prospeccao-ia, sem roteiro
    const l2 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead 2", phone: "11911110002", source: "prospeccao-ia" },
      })
    ).json();

    // Lead 3: prospeccao-ia, com roteiro
    const l3 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead 3", phone: "11911110003", source: "prospeccao-ia", playbookId: pbId },
      })
    ).json();

    // Filtro por source
    const bySource = (await app.inject({ method: "GET", url: "/api/leads?source=prospeccao-ia", headers: auth() })).json();
    const bySourceIds = bySource.items.map((i: { id: number }) => i.id);
    expect(bySourceIds).toContain(l2.id);
    expect(bySourceIds).toContain(l3.id);
    expect(bySourceIds).not.toContain(l1.id);

    // Filtro por playbookId=none
    const byNone = (await app.inject({ method: "GET", url: "/api/leads?playbookId=none", headers: auth() })).json();
    const byNoneIds = byNone.items.map((i: { id: number }) => i.id);
    expect(byNoneIds).toContain(l1.id);
    expect(byNoneIds).toContain(l2.id);
    expect(byNoneIds).not.toContain(l3.id);

    // Filtro por playbookId=id
    const byPb = (await app.inject({ method: "GET", url: `/api/leads?playbookId=${pbId}`, headers: auth() })).json();
    const byPbIds = byPb.items.map((i: { id: number }) => i.id);
    expect(byPbIds).toEqual([l3.id]);

    // Combinado: source=prospeccao-ia e playbookId=none
    const combined = (
      await app.inject({ method: "GET", url: "/api/leads?source=prospeccao-ia&playbookId=none", headers: auth() })
    ).json();
    const combinedIds = combined.items.map((i: { id: number }) => i.id);
    expect(combinedIds).toEqual([l2.id]);
  });

  it("bulk atribui + agenda envios com variáveis substituídas + pula optedOut/sem telefone", async () => {
    const pbRes = await app.inject({
      method: "POST",
      url: "/api/playbooks",
      headers: auth(),
      payload: { name: "Roteiro Massa", firstMessage: "Oi {primeiro_nome}, como vai a {empresa}?" },
    });
    const pbId = pbRes.json().id;

    // Lead elegível 1: com nome e empresa
    const l1 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Gabriel Santos", company: "Santos Instalações", phone: "11922220001" },
      })
    ).json();

    // Lead elegível 2: só nome no WhatsApp (waName), sem empresa
    const l2 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Roberto", phone: "11922220002" },
      })
    ).json();

    // Lead pulado 1: sem telefone
    const l3 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Sem Telefone", email: "semtel@email.com" },
      })
    ).json();

    // Lead pulado 2: optedOut
    const l4 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Bloqueado", phone: "11922220004", optedOut: true },
      })
    ).json();

    const bulkRes = await app.inject({
      method: "POST",
      url: "/api/leads/bulk/playbook",
      headers: auth(),
      payload: {
        leadIds: [l1.id, l2.id, l3.id, l4.id],
        playbookId: pbId,
        chatMode: "bot",
        firstMessage: {
          send: true,
          text: "Olá {primeiro_nome}, vi que você é da {empresa}. Tudo bem?",
        },
      },
    });

    expect(bulkRes.statusCode).toBe(200);
    const bulkData = bulkRes.json();
    expect(bulkData.updated).toBe(4);
    expect(bulkData.queued).toBe(2);
    expect(bulkData.skipped).toEqual([
      { leadId: l3.id, reason: "sem telefone" },
      { leadId: l4.id, reason: "pediu para não receber mensagens" },
    ]);

    // Verifica que todos receberam o playbook e chatMode
    for (const id of [l1.id, l2.id, l3.id, l4.id]) {
      const getL = (await app.inject({ method: "GET", url: `/api/leads/${id}`, headers: auth() })).json();
      expect(getL.lead.playbookId).toBe(pbId);
      expect(getL.lead.chatMode).toBe("bot");
      // Activity registrada
      expect(getL.activities.some((a: { type: string }) => a.type === "playbook")).toBe(true);
    }

    // Dispara o agendador: 1º envio imediato
    resetLastAutomationSendAtForTest();
    await runSchedulerTick(env.ctx);
    expect(env.wa.sent).toHaveLength(1);

    // 2º envio após intervalo e throttle de 60s
    env.advanceMinutes(2);
    await runSchedulerTick(env.ctx);
    expect(env.wa.sent).toHaveLength(2);
    const sent1 = env.wa.sent.find((s) => s.phone === "5511922220001");
    expect(sent1?.text).toBe("Olá Gabriel, vi que você é da Santos Instalações. Tudo bem?");

    const sent2 = env.wa.sent.find((s) => s.phone === "5511922220002");
    // Sem empresa, usa nome se houver ou limpa limpo
    expect(sent2?.text).toBe("Olá Roberto, vi que você é da Roberto. Tudo bem?");
  });

  it("substituição de variáveis: sem nome nem empresa remove espaços e pontuação limpos", async () => {
    const pbRes = await app.inject({
      method: "POST",
      url: "/api/playbooks",
      headers: auth(),
      payload: { name: "Roteiro Sem Nome" },
    });
    const pbId = pbRes.json().id;

    // Lead sem nome e sem empresa
    const l1 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { phone: "11933330001" },
      })
    ).json();

    const bulkRes = await app.inject({
      method: "POST",
      url: "/api/leads/bulk/playbook",
      headers: auth(),
      payload: {
        leadIds: [l1.id],
        playbookId: pbId,
        firstMessage: {
          send: true,
          text: "Olá {primeiro_nome}, tudo bem?",
        },
      },
    });

    expect(bulkRes.statusCode).toBe(200);
    resetLastAutomationSendAtForTest();
    await runSchedulerTick(env.ctx);

    expect(env.wa.sent).toHaveLength(1);
    expect(env.wa.sent[0].text).toBe("Olá, tudo bem?");
  });

  it("prompt do reply contém o roteiro", async () => {
    const pbRes = await app.inject({
      method: "POST",
      url: "/api/playbooks",
      headers: auth(),
      payload: {
        name: "Roteiro Painel Solar",
        goal: "Agendar visita técnica para orçamento solar",
        offer: "Economia de até 90% na conta de luz",
        instructions: "Pergunte a média de consumo em kWh ou o valor da fatura",
        handoffRules: "Passe para humano se o lead pedir desconto à vista",
      },
    });
    const pb = pbRes.json();

    const leadRes = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: auth(),
      payload: { name: "Claudio", phone: "11944440001", playbookId: pb.id, chatMode: "bot" },
    });
    const lead = leadRes.json();

    // Simula mensagem do lead
    await app.inject({
      method: "POST",
      url: "/api/whatsapp/simulate",
      headers: auth(),
      payload: { phone: lead.phone, body: "Quero saber sobre os painéis solares." },
    });

    await env.ctx.jobs.drain();

    const replyCall = env.ai.calls.find((c) => c.task === "reply");
    expect(replyCall).toBeDefined();
    expect(replyCall!.system).toContain("Roteiro desta conversa:");
    expect(replyCall!.system).toContain("Nome: Roteiro Painel Solar");
    expect(replyCall!.system).toContain("Agendar visita técnica para orçamento solar");
    expect(replyCall!.system).toContain("Economia de até 90% na conta de luz");
    expect(replyCall!.system).toContain("Pergunte a média de consumo em kWh ou o valor da fatura");
    expect(replyCall!.system).toContain("Passe para humano se o lead pedir desconto à vista");
  });

  it("handoff envia aviso para o WhatsApp do dono (e não envia quando desligado)", async () => {
    // Configura notificação ligada
    await updateSettings(env.ctx.db, {
      notify: { handoffEnabled: true, handoffPhone: "11955550000" },
    });

    const pbRes = await app.inject({
      method: "POST",
      url: "/api/playbooks",
      headers: auth(),
      payload: { name: "Roteiro Barbearia" },
    });
    const pb = pbRes.json();

    const leadRes = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: auth(),
      payload: { name: "Renato", phone: "11955550001", playbookId: pb.id, chatMode: "bot" },
    });
    const lead = leadRes.json();

    // Força a IA a pedir handoff
    env.ai.handlers.reply = () => ({
      reply: "Vou chamar o gerente para você.",
      handoff: true,
      handoffReason: "cliente quer desconto especial",
    });

    await app.inject({
      method: "POST",
      url: "/api/whatsapp/simulate",
      headers: auth(),
      payload: { phone: lead.phone, body: "Consegue me dar um desconto?" },
    });

    await env.ctx.jobs.drain();

    // Mensagem de aviso deve ter sido enviada para o telefone do dono (5511955550000)
    const notifySent = env.wa.sent.find((s) => s.phone === "5511955550000");
    expect(notifySent).toBeDefined();
    expect(notifySent!.text).toContain("🔔 Lead precisa de você");
    expect(notifySent!.text).toContain("Renato");
    expect(notifySent!.text).toContain("Roteiro: Roteiro Barbearia");
    expect(notifySent!.text).toContain("Motivo: cliente quer desconto especial");
    expect(notifySent!.text).toContain(`/inbox?lead=${lead.id}`);

    // Agora desliga a notificação
    await updateSettings(env.ctx.db, {
      notify: { handoffEnabled: false },
    });
    env.wa.sent.length = 0;

    const lead2Res = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: auth(),
      payload: { name: "Lucas", phone: "11955550002", chatMode: "bot" },
    });
    const lead2 = lead2Res.json();

    await app.inject({
      method: "POST",
      url: "/api/whatsapp/simulate",
      headers: auth(),
      payload: { phone: lead2.phone, body: "Quero falar com um humano" },
    });

    await env.ctx.jobs.drain();

    const notifySent2 = env.wa.sent.find((s) => s.phone === "5511955550000");
    expect(notifySent2).toBeUndefined();
  });

  it("webhook ignora mensagens do número de aviso (não vira lead)", async () => {
    await updateSettings(env.ctx.db, {
      notify: { handoffEnabled: true, handoffPhone: "11966660000" },
    });

    // Envia mensagem simualda a partir do número do dono
    const simRes = await app.inject({
      method: "POST",
      url: "/api/whatsapp/simulate",
      headers: auth(),
      payload: { phone: "11966660000", body: "Olá CRM" },
    });
    expect(simRes.statusCode).toBe(200);
    expect(simRes.json().message).toBeNull();

    // Confere que nenhum lead com esse telefone foi criado
    const listRes = await app.inject({ method: "GET", url: "/api/leads?search=966660000", headers: auth() });
    expect(listRes.json().items).toHaveLength(0);
  });

  it("POST /api/settings/notify/test envia teste ou devolve 400 se vazio", async () => {
    // 1. Vazio dá 400
    await updateSettings(env.ctx.db, { notify: { handoffPhone: "" } });
    const resBad = await app.inject({ method: "POST", url: "/api/settings/notify/test", headers: auth() });
    expect(resBad.statusCode).toBe(400);

    // 2. Preenchido envia mensagem de teste
    await updateSettings(env.ctx.db, { notify: { handoffPhone: "11977770000" } });
    env.wa.sent.length = 0;
    const resOk = await app.inject({ method: "POST", url: "/api/settings/notify/test", headers: auth() });
    expect(resOk.statusCode).toBe(200);
    expect(resOk.json()).toEqual({ ok: true });

    const sent = env.wa.sent.find((s) => s.phone === "5511977770000");
    expect(sent).toBeDefined();
    expect(sent!.text).toBe("✅ Teste de aviso do CRM");
  });

  it("bulk com intervalMinutes personalizado e lastSendAt calculado", async () => {
    const pbRes = await app.inject({
      method: "POST",
      url: "/api/playbooks",
      headers: auth(),
      payload: { name: "Roteiro Intervalo", firstMessage: "Oi" },
    });
    const pbId = pbRes.json().id;

    const l1 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead Interval 1", phone: "11933330001" },
      })
    ).json();

    const l2 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead Interval 2", phone: "11933330002" },
      })
    ).json();

    // 15:00 UTC = 12:00 São Paulo (dentro da janela)
    env.setNow(new Date("2026-10-09T15:00:00.000Z"));

    const bulkRes = await app.inject({
      method: "POST",
      url: "/api/leads/bulk/playbook",
      headers: auth(),
      payload: {
        leadIds: [l1.id, l2.id],
        playbookId: pbId,
        firstMessage: {
          send: true,
          text: "Olá {primeiro_nome}!",
          intervalMinutes: 10,
        },
      },
    });

    expect(bulkRes.statusCode).toBe(200);
    const data = bulkRes.json();
    expect(data.updated).toBe(2);
    expect(data.queued).toBe(2);
    expect(data.lastSendAt).toBeDefined();

    // Com 10 min de intervalo e ±15% de variação:
    // O 1º envio é imediato (15:00:00Z)
    // O 2º envio (lastSendAt) deve ser 15:00:00Z + [8.5 min .. 11.5 min]
    const lastSendTime = new Date(data.lastSendAt).getTime();
    const baseTime = new Date("2026-10-09T15:00:00.000Z").getTime();
    const minExpected = baseTime + 8.5 * 60_000;
    const maxExpected = baseTime + 11.5 * 60_000;
    expect(lastSendTime).toBeGreaterThanOrEqual(minExpected);
    expect(lastSendTime).toBeLessThanOrEqual(maxExpected);
  });

  it("bulk fora da janela de envio empurra para o início da próxima janela mantendo espaçamento", async () => {
    await updateSettings(env.ctx.db, {
      automation: {
        sendWindowEnabled: true,
        sendWindowStart: "08:00",
        sendWindowEnd: "20:00",
      },
    });

    const pbRes = await app.inject({
      method: "POST",
      url: "/api/playbooks",
      headers: auth(),
      payload: { name: "Roteiro Janela", firstMessage: "Oi" },
    });
    const pbId = pbRes.json().id;

    const l1 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead Janela 1", phone: "11933330011" },
      })
    ).json();

    const l2 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead Janela 2", phone: "11933330012" },
      })
    ).json();

    // 23:30 UTC = 20:30 em São Paulo (fora da janela 08:00–20:00)
    env.setNow(new Date("2026-10-09T23:30:00.000Z"));

    const bulkRes = await app.inject({
      method: "POST",
      url: "/api/leads/bulk/playbook",
      headers: auth(),
      payload: {
        leadIds: [l1.id, l2.id],
        playbookId: pbId,
        firstMessage: {
          send: true,
          text: "Olá {primeiro_nome}!",
          intervalMinutes: 5,
        },
      },
    });

    expect(bulkRes.statusCode).toBe(200);
    const data = bulkRes.json();
    expect(data.queued).toBe(2);

    // Próxima janela começa às 08:00 de 2026-10-10 em São Paulo = 11:00:00.000Z UTC
    // Lead 1 é empurrado para 11:00:00.000Z
    // Lead 2 (lastSendAt) fica a 5 min (±15%) de 11:00:00.000Z: [11:04:15Z .. 11:05:45Z]
    const lastSendTime = new Date(data.lastSendAt).getTime();
    const nextWindowStart = new Date("2026-10-10T11:00:00.000Z").getTime();
    const minExpected = nextWindowStart + (5 * 60_000 * 0.85);
    const maxExpected = nextWindowStart + (5 * 60_000 * 1.15);

    expect(lastSendTime).toBeGreaterThanOrEqual(minExpected);
    expect(lastSendTime).toBeLessThanOrEqual(maxExpected);
  });

  it("bulk sem envio ou sem leads elegíveis retorna lastSendAt null", async () => {
    const l1 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead Sem Msg", phone: "11933330021" },
      })
    ).json();

    const bulkRes = await app.inject({
      method: "POST",
      url: "/api/leads/bulk/playbook",
      headers: auth(),
      payload: {
        leadIds: [l1.id],
        playbookId: null,
        firstMessage: {
          send: false,
          text: "",
        },
      },
    });

    expect(bulkRes.statusCode).toBe(200);
    expect(bulkRes.json().queued).toBe(0);
    expect(bulkRes.json().lastSendAt).toBeNull();
  });

  it("intervalMinutes inválido (< 1 ou > 120) retorna 400", async () => {
    const resLow = await app.inject({
      method: "POST",
      url: "/api/leads/bulk/playbook",
      headers: auth(),
      payload: {
        leadIds: [1],
        playbookId: null,
        firstMessage: { send: true, text: "Oi", intervalMinutes: 0 },
      },
    });
    expect(resLow.statusCode).toBe(400);

    const resHigh = await app.inject({
      method: "POST",
      url: "/api/leads/bulk/playbook",
      headers: auth(),
      payload: {
        leadIds: [1],
        playbookId: null,
        firstMessage: { send: true, text: "Oi", intervalMinutes: 121 },
      },
    });
    expect(resHigh.statusCode).toBe(400);
  });

  it("bulk cria linhas em scheduled_messages com sendAt espaçado e author automation; tick envia e optedOut cancela", async () => {
    resetLastAutomationSendAtForTest();

    const pbRes = await app.inject({
      method: "POST",
      url: "/api/playbooks",
      headers: auth(),
      payload: { name: "Roteiro Persistente", firstMessage: "Oi" },
    });
    const pbId = pbRes.json().id;

    const l1 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Cliente A", phone: "11988880001" },
      })
    ).json();

    const l2 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Cliente B", phone: "11988880002" },
      })
    ).json();

    const l3 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Cliente C", phone: "11988880003" },
      })
    ).json();

    // 15:00 UTC = 12:00 São Paulo (dentro da janela)
    env.setNow(new Date("2026-10-09T15:00:00.000Z"));

    const bulkRes = await app.inject({
      method: "POST",
      url: "/api/leads/bulk/playbook",
      headers: auth(),
      payload: {
        leadIds: [l1.id, l2.id, l3.id],
        playbookId: pbId,
        firstMessage: {
          send: true,
          text: "Olá {primeiro_nome}!",
          intervalMinutes: 2,
        },
      },
    });

    expect(bulkRes.statusCode).toBe(200);
    expect(bulkRes.json().queued).toBe(3);

    // 1. Confere linhas criadas no banco com sendAt espaçado e author 'automation'
    const rows = await env.ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.author, "automation"))
      .orderBy(scheduledMessages.sendAt);

    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.author).toBe("automation");
      expect(r.status).toBe("pending");
      expect(r.createdBy).toBeDefined();
    }

    // Linha 1: horário planejado = agora (15:00:00Z)
    expect(rows[0]!.sendAt.getTime()).toBe(new Date("2026-10-09T15:00:00.000Z").getTime());

    // Linha 2: espaçada por 2 minutos (±15%)
    const diff1to2 = rows[1]!.sendAt.getTime() - rows[0]!.sendAt.getTime();
    expect(diff1to2).toBeGreaterThanOrEqual(2 * 60_000 * 0.85);
    expect(diff1to2).toBeLessThanOrEqual(2 * 60_000 * 1.15);

    // Linha 3: espaçada por mais 2 minutos (±15%)
    const diff2to3 = rows[2]!.sendAt.getTime() - rows[1]!.sendAt.getTime();
    expect(diff2to3).toBeGreaterThanOrEqual(2 * 60_000 * 0.85);
    expect(diff2to3).toBeLessThanOrEqual(2 * 60_000 * 1.15);

    // 2. Tick envia a 1ª mensagem (no máximo 1 automation por tick)
    env.wa.sent.length = 0;
    const tick1 = await runSchedulerTick(env.ctx);
    expect(tick1.scheduled).toBe(1);
    expect(env.wa.sent).toHaveLength(1);
    expect(env.wa.sent[0]!.phone).toBe("5511988880001");

    // Mesmo tick ou rodar de novo imediatamente não manda a 2ª (respeita o throttle de 60s)
    const tickImmediate = await runSchedulerTick(env.ctx);
    expect(tickImmediate.scheduled).toBe(0);
    expect(env.wa.sent).toHaveLength(1);

    // 3. Cliente B pede para não receber mensagens antes da vez dele (optedOut)
    await app.inject({
      method: "PATCH",
      url: `/api/leads/${l2.id}`,
      headers: auth(),
      payload: { optedOut: true },
    });

    // Avança o relógio além de sendAt da linha 2: linha 2 venceu, mas o lead está optedOut → cancela
    env.setNow(new Date(rows[1]!.sendAt.getTime() + 1000));
    await runSchedulerTick(env.ctx);

    const [row2] = await env.ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, rows[1]!.id));
    expect(row2!.status).toBe("canceled");
    expect(row2!.error).toBe("pediu para não receber mensagens");

    // Avança o relógio além de sendAt da linha 3: linha 3 venceu e é enviada com sucesso
    env.setNow(new Date(rows[2]!.sendAt.getTime() + 1000));
    await runSchedulerTick(env.ctx);

    const [row3] = await env.ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, rows[2]!.id));
    expect(row3!.status).toBe("sent");

    // Total de envios reais no WhatsApp: 2 (Cliente A e Cliente C; Cliente B foi cancelado)
    expect(env.wa.sent).toHaveLength(2);
    expect(env.wa.sent.map((s) => s.phone)).toEqual(["5511988880001", "5511988880003"]);
  });

  it("batchId igual no mesmo disparo e diferente entre disparos", async () => {
    const l1 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead Batch 1", phone: "11988881111" },
      })
    ).json();
    const l2 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead Batch 2", phone: "11988882222" },
      })
    ).json();
    const l3 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead Batch 3", phone: "11988883333" },
      })
    ).json();

    // Disparo 1: leads 1 e 2
    const res1 = await app.inject({
      method: "POST",
      url: "/api/leads/bulk/playbook",
      headers: auth(),
      payload: {
        leadIds: [l1.id, l2.id],
        playbookId: null,
        firstMessage: { send: true, text: "Olá {primeiro_nome}!" },
      },
    });
    expect(res1.statusCode).toBe(200);

    const rows1 = await env.ctx.db
      .select()
      .from(scheduledMessages)
      .where(inArray(scheduledMessages.leadId, [l1.id, l2.id]));
    expect(rows1).toHaveLength(2);
    expect(rows1[0]!.batchId).toBeTruthy();
    expect(rows1[1]!.batchId).toBeTruthy();
    // Mesmo batchId para todas as linhas daquele disparo
    expect(rows1[0]!.batchId).toBe(rows1[1]!.batchId);

    // Disparo 2: lead 3
    const res2 = await app.inject({
      method: "POST",
      url: "/api/leads/bulk/playbook",
      headers: auth(),
      payload: {
        leadIds: [l3.id],
        playbookId: null,
        firstMessage: { send: true, text: "Oi {primeiro_nome}!" },
      },
    });
    expect(res2.statusCode).toBe(200);

    const [row3] = await env.ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.leadId, l3.id));
    expect(row3!.batchId).toBeTruthy();
    // Batches diferentes entre disparos distintos
    expect(row3!.batchId).not.toBe(rows1[0]!.batchId);
  });

  it("GET /api/scheduled devolve pendentes ASC e não pendentes DESC limitadas a 100 com todos os campos", async () => {
    const pbRes = await app.inject({
      method: "POST",
      url: "/api/playbooks",
      headers: auth(),
      payload: { name: "Roteiro Agendamento" },
    });
    const pbId = pbRes.json().id;

    const leadPb = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead Com Roteiro", phone: "11977771111", playbookId: pbId },
      })
    ).json();

    const leadSemPb = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead Sem Roteiro", phone: "11977772222" },
      })
    ).json();

    // Insere 2 pendentes com horários diferentes
    const [p1] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: leadPb.id,
        body: "Pendente 14h",
        sendAt: new Date("2026-10-15T14:00:00Z"),
        status: "pending",
        author: "automation",
        batchId: "batch-1",
      })
      .returning();

    const [p2] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: leadSemPb.id,
        body: "Pendente 12h",
        sendAt: new Date("2026-10-15T12:00:00Z"),
        status: "pending",
        author: "agent",
      })
      .returning();

    // Insere 2 não pendentes com horários diferentes
    const [npSent] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: leadPb.id,
        body: "Enviada 10h",
        sendAt: new Date("2026-10-15T10:00:00Z"),
        status: "sent",
        author: "automation",
      })
      .returning();

    const [npCanceled] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: leadSemPb.id,
        body: "Cancelada 16h",
        sendAt: new Date("2026-10-15T16:00:00Z"),
        status: "canceled",
        error: "cancelada por você",
        author: "agent",
      })
      .returning();

    const res = await app.inject({ method: "GET", url: "/api/scheduled", headers: auth() });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(Array.isArray(list)).toBe(true);

    // As pendentes devem vir primeiro ordenadas por sendAt ASC (12h depois 14h)
    const pendingIds = list.filter((i: { status: string }) => i.status === "pending").map((i: { id: number }) => i.id);
    expect(pendingIds).toEqual([p2!.id, p1!.id]);

    // As não pendentes vêm em seguida ordenadas por sendAt DESC (16h depois 10h)
    const nonPendingIds = list.filter((i: { status: string }) => i.status !== "pending").map((i: { id: number }) => i.id);
    expect(nonPendingIds).toEqual([npCanceled!.id, npSent!.id]);

    // Verifica formato exato dos campos de um item
    const itemPb = list.find((i: { id: number }) => i.id === p1!.id);
    expect(itemPb).toMatchObject({
      id: p1!.id,
      body: "Pendente 14h",
      status: "pending",
      error: null,
      author: "automation",
      batchId: "batch-1",
      leadId: leadPb.id,
      leadName: "Lead Com Roteiro",
      leadPhone: "5511977771111",
      playbookName: "Roteiro Agendamento",
    });
    expect(itemPb.sendAt).toBeDefined();
    expect(itemPb.createdAt).toBeDefined();

    const itemSemPb = list.find((i: { id: number }) => i.id === p2!.id);
    expect(itemSemPb).toMatchObject({
      id: p2!.id,
      body: "Pendente 12h",
      status: "pending",
      author: "agent",
      batchId: null,
      leadId: leadSemPb.id,
      leadName: "Lead Sem Roteiro",
      leadPhone: "5511977772222",
      playbookName: null,
    });
  });

  it("POST /api/scheduled/cancel cancela por ids, batchId ou all e valida opções", async () => {
    const l1 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead C1", phone: "11966661111" },
      })
    ).json();
    const l2 = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead C2", phone: "11966662222" },
      })
    ).json();

    // 1. Validações de erro 400
    // Vazio
    const bad1 = await app.inject({ method: "POST", url: "/api/scheduled/cancel", headers: auth(), payload: {} });
    expect(bad1.statusCode).toBe(400);

    // Múltiplas opções juntas
    const bad2 = await app.inject({
      method: "POST",
      url: "/api/scheduled/cancel",
      headers: auth(),
      payload: { ids: [1], batchId: "xyz" },
    });
    expect(bad2.statusCode).toBe(400);

    // all: false
    const bad3 = await app.inject({
      method: "POST",
      url: "/api/scheduled/cancel",
      headers: auth(),
      payload: { all: false },
    });
    expect(bad3.statusCode).toBe(400);

    // 2. Cancel por ids
    const [msg1] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l1.id,
        body: "Msg 1",
        sendAt: new Date("2026-10-16T12:00:00Z"),
        status: "pending",
      })
      .returning();
    const [msg2] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l2.id,
        body: "Msg 2",
        sendAt: new Date("2026-10-16T13:00:00Z"),
        status: "pending",
      })
      .returning();

    const cancelIdsRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/cancel",
      headers: auth(),
      payload: { ids: [msg1!.id] },
    });
    expect(cancelIdsRes.statusCode).toBe(200);
    expect(cancelIdsRes.json()).toEqual({ canceled: 1 });

    const [msg1After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msg1!.id));
    expect(msg1After!.status).toBe("canceled");
    expect(msg1After!.error).toBe("cancelada por você");

    const [msg2After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msg2!.id));
    expect(msg2After!.status).toBe("pending");

    // 3. Cancel por batchId
    const batchTarget = "batch-alvo-123";
    const [msgBatch1] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l1.id,
        body: "Batch 1",
        sendAt: new Date("2026-10-16T14:00:00Z"),
        status: "pending",
        batchId: batchTarget,
      })
      .returning();
    const [msgBatch2] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l2.id,
        body: "Batch 2",
        sendAt: new Date("2026-10-16T15:00:00Z"),
        status: "pending",
        batchId: batchTarget,
      })
      .returning();

    const cancelBatchRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/cancel",
      headers: auth(),
      payload: { batchId: batchTarget },
    });
    expect(cancelBatchRes.statusCode).toBe(200);
    expect(cancelBatchRes.json()).toEqual({ canceled: 2 });

    const batchRows = await env.ctx.db
      .select()
      .from(scheduledMessages)
      .where(inArray(scheduledMessages.id, [msgBatch1!.id, msgBatch2!.id]));
    for (const r of batchRows) {
      expect(r.status).toBe("canceled");
      expect(r.error).toBe("cancelada por você");
    }

    // 4. Cancel all
    // Restou msg2 como pending
    const cancelAllRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/cancel",
      headers: auth(),
      payload: { all: true },
    });
    expect(cancelAllRes.statusCode).toBe(200);
    expect(cancelAllRes.json().canceled).toBeGreaterThanOrEqual(1);

    const [msg2Final] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msg2!.id));
    expect(msg2Final!.status).toBe("canceled");
    expect(msg2Final!.error).toBe("cancelada por você");

    // Cancel all de novo quando não há mais pendentes
    const cancelAllEmpty = await app.inject({
      method: "POST",
      url: "/api/scheduled/cancel",
      headers: auth(),
      payload: { all: true },
    });
    expect(cancelAllEmpty.json()).toEqual({ canceled: 0 });
  });

  it("falha passageira: mantém pending, pausa a fila por 30 min, empurra pendentes e não duplica failed no histórico", async () => {
    // Leads
    const [l1] = await env.ctx.db
      .insert(leads)
      .values({ name: "Lead Passageiro 1", phone: "11977770001", source: "manual" })
      .returning();
    const [l2] = await env.ctx.db
      .insert(leads)
      .values({ name: "Lead Passageiro 2", phone: "11977770002", source: "manual" })
      .returning();

    // 15:00 UTC = 12:00 São Paulo (dentro da janela)
    const baseTime = new Date("2026-10-09T15:00:00Z");
    (env.ctx as any).now = () => baseTime;

    const [sm1] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l1!.id,
        body: "Olá L1",
        sendAt: new Date("2026-10-09T15:00:00Z"),
        author: "automation",
        status: "pending",
      })
      .returning();

    const [sm2] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l2!.id,
        body: "Olá L2",
        sendAt: new Date("2026-10-09T15:05:00Z"),
        author: "automation",
        status: "pending",
      })
      .returning();

    // Simula erro de desconexão da Evolution
    (env.ctx.wa as SimulatorProvider).failNext =
      "Evolution API POST /message/sendText/crm -> 400: {\"error\": \"Connection Closed\"}";

    const tickRes = await runSchedulerTick(env.ctx);
    expect(tickRes.scheduled).toBe(0);

    // 1. sm1 deve continuar pending com mensagem amigável de erro contendo HH:MM (12:30 no fuso de SP)
    const [sm1After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, sm1!.id));
    expect(sm1After!.status).toBe("pending");
    expect(sm1After!.error).toContain("WhatsApp desconectado; nova tentativa às 12:30");
    // sendAt de sm1 empurrado para 15:30 UTC
    expect(sm1After!.sendAt.toISOString()).toBe("2026-10-09T15:30:00.000Z");

    // 2. sm2 deve ter sido empurrado mantendo a ordem: 15:05 + 30m = 15:35 UTC
    const [sm2After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, sm2!.id));
    expect(sm2After!.status).toBe("pending");
    expect(sm2After!.sendAt.toISOString()).toBe("2026-10-09T15:35:00.000Z");

    // 3. Fila deve estar pausada por 30 min
    const qState = await getQueueState(env.ctx.db);
    expect(qState.pausedUntil).toBe("2026-10-09T15:30:00.000Z");
    expect(qState.reason).toBeTruthy();

    const statusApi = await app.inject({ method: "GET", url: "/api/scheduled/status", headers: auth() });
    expect(statusApi.statusCode).toBe(200);
    expect(statusApi.json().pausedUntil).toBe("2026-10-09T15:30:00.000Z");

    // 4. Não deve haver mensagem gravada como failed na tabela messages
    const msgsL1 = await env.ctx.db.select().from(messages).where(eq(messages.leadId, l1!.id));
    expect(msgsL1).toHaveLength(0);

    // 5. Durante a pausa, o scheduler tick não envia nada
    const midTime = new Date("2026-10-09T15:15:00Z");
    (env.ctx as any).now = () => midTime;
    const tickMid = await runSchedulerTick(env.ctx);
    expect(tickMid).toEqual({ steps: 0, scheduled: 0 });
    expect((env.ctx.wa as SimulatorProvider).sent).toHaveLength(0);

    // 6. Resume limpa a pausa
    const resumeRes = await app.inject({ method: "POST", url: "/api/scheduled/resume", headers: auth() });
    expect(resumeRes.statusCode).toBe(200);
    expect(resumeRes.json()).toEqual({ pausedUntil: null, reason: null });

    const qStateAfterResume = await getQueueState(env.ctx.db);
    expect(qStateAfterResume.pausedUntil).toBeNull();

    // 7. Após o horário empurrado e sem erro, o envio ocorre com sucesso
    const afterTime = new Date("2026-10-09T15:31:00Z");
    (env.ctx as any).now = () => afterTime;
    const tickAfter = await runSchedulerTick(env.ctx);
    expect(tickAfter.scheduled).toBe(1);

    const [sm1Final] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, sm1!.id));
    expect(sm1Final!.status).toBe("sent");
    expect(sm1Final!.error).toBeNull();
  });

  it("pre-flight check: WhatsApp desconectado pausa a fila sem tentar enviar", async () => {
    const [l] = await env.ctx.db
      .insert(leads)
      .values({ name: "Lead Preflight", phone: "11977770003", source: "manual" })
      .returning();

    const now = new Date("2026-10-09T15:00:00Z");
    (env.ctx as any).now = () => now;

    const [sm] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l!.id,
        body: "Preflight test",
        sendAt: now,
        author: "automation",
        status: "pending",
      })
      .returning();

    // Simula WhatsApp desconectado no provedor
    (env.ctx.wa as SimulatorProvider).connected = false;

    const tickRes = await runSchedulerTick(env.ctx);
    expect(tickRes).toEqual({ steps: 0, scheduled: 0 });
    expect((env.ctx.wa as SimulatorProvider).sent).toHaveLength(0);

    const [smAfter] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, sm!.id));
    expect(smAfter!.status).toBe("pending");
    expect(smAfter!.error).toContain("WhatsApp desconectado; nova tentativa às 12:30");

    const qState = await getQueueState(env.ctx.db);
    expect(qState.pausedUntil).toBe("2026-10-09T15:30:00.000Z");
  });

  it("falha permanente: número sem WhatsApp vira failed, grava na conversa e não pausa a fila", async () => {
    const [l] = await env.ctx.db
      .insert(leads)
      .values({ name: "Lead Sem WA", phone: "11977770004", source: "manual" })
      .returning();

    const now = new Date("2026-10-09T15:00:00Z");
    (env.ctx as any).now = () => now;

    const [sm] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l!.id,
        body: "Perm test",
        sendAt: now,
        author: "automation",
        status: "pending",
      })
      .returning();

    (env.ctx.wa as SimulatorProvider).missingNumbers.add("11977770004");

    const tickRes = await runSchedulerTick(env.ctx);
    expect(tickRes.scheduled).toBe(0);

    const [smAfter] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, sm!.id));
    expect(smAfter!.status).toBe("failed");
    expect(smAfter!.error).toContain("Este número não tem WhatsApp");

    // Fila não foi pausada
    const qState = await getQueueState(env.ctx.db);
    expect(qState.pausedUntil).toBeNull();

    // Mensagem de falha gravada no histórico
    const msgs = await env.ctx.db.select().from(messages).where(eq(messages.leadId, l!.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.status).toBe("failed");
  });

  it("POST /api/scheduled/retry: validações e reagendamento espaçado mantendo batchId", async () => {
    const [l1] = await env.ctx.db
      .insert(leads)
      .values({ name: "Lead Retry 1", phone: "11977770005", source: "manual" })
      .returning();
    const [l2] = await env.ctx.db
      .insert(leads)
      .values({ name: "Lead Retry 2", phone: "11977770006", source: "manual" })
      .returning();
    const [lOpt] = await env.ctx.db
      .insert(leads)
      .values({ name: "Lead Opted", phone: "11977770007", source: "manual", optedOut: true })
      .returning();

    const pastDate1 = new Date("2026-10-09T13:00:00Z");
    const pastDate2 = new Date("2026-10-09T13:05:00Z");
    const pastDate3 = new Date("2026-10-09T13:10:00Z");

    const batch = "batch-retry-test";

    const [sm1] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l1!.id,
        body: "Retry 1",
        sendAt: pastDate1,
        author: "automation",
        status: "failed",
        error: "Falha de rede",
        batchId: batch,
      })
      .returning();

    const [smOpt] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: lOpt!.id,
        body: "Retry Opt",
        sendAt: pastDate2,
        author: "automation",
        status: "failed",
        error: "Falha antiga",
        batchId: batch,
      })
      .returning();

    const [sm2] = await env.ctx.db
      .insert(scheduledMessages)
      .values({
        leadId: l2!.id,
        body: "Retry 2",
        sendAt: pastDate3,
        author: "automation",
        status: "failed",
        error: "Timeout",
        batchId: batch,
      })
      .returning();

    // 1. Validação de body: erro se passar os dois ou nenhum
    const bad1 = await app.inject({ method: "POST", url: "/api/scheduled/retry", headers: auth(), payload: {} });
    expect(bad1.statusCode).toBe(400);

    const bad2 = await app.inject({
      method: "POST",
      url: "/api/scheduled/retry",
      headers: auth(),
      payload: { ids: [sm1!.id], all: true },
    });
    expect(bad2.statusCode).toBe(400);

    // 2. Retry com all: true e intervalMinutes = 5
    const now = new Date("2026-10-09T15:00:00Z");
    (env.ctx as any).now = () => now;

    const retryRes = await app.inject({
      method: "POST",
      url: "/api/scheduled/retry",
      headers: auth(),
      payload: { all: true, intervalMinutes: 5 },
    });
    expect(retryRes.statusCode).toBe(200);
    const retryData = retryRes.json();
    // Reenfileirou 2 (o lead optedOut foi pulado)
    expect(retryData.requeued).toBe(2);
    expect(retryData.lastSendAt).toBeTypeOf("string");

    // sm1 deve estar pending, sem erro, sendAt = now + 1 min (15:01 UTC)
    const [sm1After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, sm1!.id));
    expect(sm1After!.status).toBe("pending");
    expect(sm1After!.error).toBeNull();
    expect(sm1After!.batchId).toBe(batch);
    expect(sm1After!.sendAt.toISOString()).toBe("2026-10-09T15:01:00.000Z");

    // smOpt continua failed
    const [smOptAfter] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, smOpt!.id));
    expect(smOptAfter!.status).toBe("failed");

    // sm2 deve estar pending, espaçado em torno de 5 min após sm1 (entre 4m15s e 5m45s)
    const [sm2After] = await env.ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, sm2!.id));
    expect(sm2After!.status).toBe("pending");
    expect(sm2After!.error).toBeNull();
    expect(sm2After!.batchId).toBe(batch);
    const diffMs = sm2After!.sendAt.getTime() - sm1After!.sendAt.getTime();
    expect(diffMs).toBeGreaterThanOrEqual(5 * 60_000 * 0.85);
    expect(diffMs).toBeLessThanOrEqual(5 * 60_000 * 1.15);

    expect(retryData.lastSendAt).toBe(sm2After!.sendAt.toISOString());
  });
});
