import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copilotInsights, leads, messages } from "../src/db/schema.js";
import { handleIncoming, sendToLead } from "../src/services/messaging.js";
import { updateSettings } from "../src/settings.js";
import { setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env.close();
});

const inbound = (body: string, extra: Partial<Parameters<typeof handleIncoming>[1]> = {}) =>
  handleIncoming(env.ctx, {
    phone: "5511999990001",
    name: "Maria (WhatsApp)",
    body,
    mediaType: "text",
    fromMe: false,
    externalId: `ext-${Math.random()}`,
    ...extra,
  });

async function theLead() {
  const [lead] = await env.ctx.db.select().from(leads).where(eq(leads.phone, "5511999990001"));
  return lead!;
}

describe("mensagem recebida no WhatsApp", () => {
  it("cria o lead, salva a mensagem e ignora duplicadas", async () => {
    await inbound("Oi, quero saber o preço", { externalId: "abc" });
    await inbound("Oi, quero saber o preço", { externalId: "abc" });
    await env.settle();

    const lead = await theLead();
    expect(lead.source).toBe("whatsapp");
    expect(lead.waName).toBe("Maria (WhatsApp)");
    expect(lead.unreadCount).toBe(1);
    const msgs = await env.ctx.db.select().from(messages).where(eq(messages.leadId, lead.id));
    expect(msgs.filter((m) => m.direction === "in")).toHaveLength(1);
    expect(env.eventsOf("lead.created")).toHaveLength(1);
    expect(env.eventsOf("message.received")).toHaveLength(1);
  });

  it("modo bot: a IA responde sozinha e qualifica o lead", async () => {
    env.ai.handlers.qualify = () => ({
      name: "Maria Souza",
      email: "maria@exemplo.com",
      company: "",
      interest: "Plano anual",
      budget: "R$ 2.000",
      timeline: "este mês",
      score: 130, // fora do intervalo → corrigido para 100
      temperature: "quente",
      summary: "Quer fechar o plano anual este mês.",
      suggestedStage: "Proposta",
      tags: ["Plano-Anual"],
    });
    await inbound("Oi, sou a Maria, quero o plano anual ainda este mês");
    await env.settle();

    expect(env.wa.sent).toHaveLength(1);
    expect(env.wa.sent[0]!.text).toBe("Olá! Como posso te ajudar?");
    const lead = await theLead();
    expect(lead.name).toBe("Maria Souza");
    expect(lead.email).toBe("maria@exemplo.com");
    expect(lead.score).toBe(100);
    expect(lead.temperature).toBe("quente");
    expect(lead.tags).toContain("plano-anual");
    const stage = (await env.ctx.db.query.stages.findFirst({ where: (s, { eq }) => eq(s.id, lead.stageId!) }))!;
    expect(stage.name).toBe("Proposta");
    expect(env.eventsOf("lead.hot")).toHaveLength(1);
    expect(env.eventsOf("lead.stage_changed")).toHaveLength(1);
    const out = await env.ctx.db.select().from(messages).where(eq(messages.direction, "out"));
    expect(out[0]!.author).toBe("bot");
    expect(env.errors).toEqual([]);
  });

  it("a IA nunca move o lead para trás nem para Ganho/Perdido", async () => {
    env.ai.handlers.qualify = () => ({
      name: "",
      email: "",
      company: "",
      interest: "",
      budget: "",
      timeline: "",
      score: 90,
      temperature: "quente",
      summary: "x",
      suggestedStage: "Ganho",
      tags: [],
    });
    await inbound("Fechado, pode mandar o boleto");
    await env.settle();
    const lead = await theLead();
    const stage = (await env.ctx.db.query.stages.findFirst({ where: (s, { eq }) => eq(s.id, lead.stageId!) }))!;
    expect(stage.name).toBe("Novo");
  });

  it("agrupa mensagens seguidas e responde uma vez só", async () => {
    env.ctx.aiDelayOverrideMs = 30;
    await inbound("Oi");
    await inbound("tudo bem?");
    await inbound("queria um orçamento");
    await env.settle();
    expect(env.wa.sent).toHaveLength(1);
    const prompt = env.ai.callsOf("reply")[0]!.prompt;
    expect(prompt).toContain("queria um orçamento");
  });

  it("handoff: passa para humano, avisa o n8n e o copiloto assume", async () => {
    env.ai.handlers.reply = () => ({
      reply: "Vou chamar alguém da equipe para te atender!",
      handoff: true,
      handoffReason: "Lead quer negociar desconto",
    });
    await inbound("Consegue um desconto de 30%?");
    await env.settle();

    const lead = await theLead();
    expect(lead.chatMode).toBe("human");
    expect(env.wa.sent).toHaveLength(1);
    expect(env.eventsOf("lead.handoff")[0]!.body.data.reason).toBe("Lead quer negociar desconto");
    const insights = await env.ctx.db.select().from(copilotInsights);
    expect(insights).toHaveLength(1);
  });

  it("modo humano: o copiloto só sugere e NUNCA envia mensagem", async () => {
    await updateSettings(env.ctx.db, { bot: { defaultMode: "human" } });
    await inbound("Achei caro, vou pensar");
    await env.settle();

    expect(env.wa.sent).toHaveLength(0);
    expect(env.ai.callsOf("reply")).toHaveLength(0);
    expect(env.ai.callsOf("copilot")).toHaveLength(1);
    const [insight] = await env.ctx.db.select().from(copilotInsights);
    expect((insight!.data as { paths: unknown[] }).paths).toHaveLength(2);
    const out = await env.ctx.db.select().from(messages).where(eq(messages.direction, "out"));
    expect(out).toHaveLength(0);
  });

  it("quando você responde pelo celular, a IA pausa e vira copiloto", async () => {
    await inbound("Oi");
    await env.settle();
    expect((await theLead()).chatMode).toBe("bot");

    await inbound("Oi Maria, aqui é o João!", { fromMe: true, name: undefined });
    await env.settle();
    expect((await theLead()).chatMode).toBe("human");

    await inbound("Oi João!");
    await env.settle();
    expect(env.wa.sent).toHaveLength(1); // só a primeira resposta do bot
    expect(env.ai.callsOf("copilot")).toHaveLength(1);
  });

  it("eco de mensagem enviada pelo CRM não duplica o histórico", async () => {
    await inbound("Oi");
    await env.settle();
    const lead = await theLead();
    await sendToLead(env.ctx, lead.id, "Mensagem do painel", { author: "agent" });
    const sentId = env.wa.sent.at(-1)!.externalId;
    await inbound("Mensagem do painel", { fromMe: true, externalId: sentId });

    // Provedor que não devolve o id no envio: o eco é vinculado pela mensagem recente igual
    await sendToLead(env.ctx, lead.id, "Segunda mensagem", { author: "agent" });
    await env.ctx.db.update(messages).set({ externalId: null }).where(eq(messages.body, "Segunda mensagem"));
    await inbound("Segunda mensagem", { fromMe: true, externalId: "id-do-eco" });

    const out = await env.ctx.db.select().from(messages).where(eq(messages.direction, "out"));
    expect(out.filter((m) => m.body === "Mensagem do painel")).toHaveLength(1);
    const second = out.filter((m) => m.body === "Segunda mensagem");
    expect(second).toHaveLength(1);
    expect(second[0]!.externalId).toBe("id-do-eco");
    expect((await theLead()).chatMode).toBe("bot");
  });

  it("opt-out: lead pede para sair → confirma, marca e o bot para", async () => {
    await inbound("SAIR!");
    await env.settle();
    const lead = await theLead();
    expect(lead.optedOut).toBe(true);
    expect(lead.chatMode).toBe("human");
    expect(env.wa.sent).toHaveLength(1);
    expect(env.wa.sent[0]!.text).toContain("não vai mais receber");
    expect(env.ai.callsOf("reply")).toHaveLength(0);
    expect(env.eventsOf("lead.opted_out")).toHaveLength(1);
    await expect(sendToLead(env.ctx, lead.id, "promo", { author: "automation" })).rejects.toThrow(/não receber/);
  });

  it("descarta a resposta do bot se o lead mandou outra mensagem enquanto a IA pensava", async () => {
    let first = true;
    env.ai.handlers.reply = async () => {
      if (first) {
        first = false;
        await inbound("ah, e também queria saber do prazo");
      }
      return { reply: "resposta", handoff: false, handoffReason: "" };
    };
    await inbound("qual o preço?");
    await env.settle();
    // 1ª resposta descartada, 2ª enviada (já considerando as duas mensagens)
    expect(env.wa.sent).toHaveLength(1);
    expect(env.ai.callsOf("reply")).toHaveLength(2);
    expect(env.ai.callsOf("reply")[1]!.prompt).toContain("prazo");
  });
});
