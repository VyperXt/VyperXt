import type { z } from "zod";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { copilotInsights, leads, messages, type Lead, type Message } from "../db/schema.js";
import { AiRateLimitError } from "../ai/errors.js";
import * as P from "../ai/prompts.js";
import {
  copilotAskSchema,
  copilotSchema,
  extractSchema,
  followupSchema,
  qualifySchema,
  replySchema,
  type CopilotAskOutput,
  type CopilotOutput,
  type ExtractOutput,
  type FollowupOutput,
} from "../ai/schemas.js";
import { asPhoneInput, normalizePhone } from "../lib/phone.js";
import { getSettings, type AppSettings } from "../settings.js";
import { addActivity, getLead, HttpError, listStages, stageOf, updateLead } from "./leads.js";
import { getConversation, sendToLead } from "./messaging.js";

function ensureAi(ctx: AppContext) {
  if (!ctx.ai.enabled) throw new HttpError(503, "IA desativada: configure ANTHROPIC_API_KEY ou OPENROUTER_API_KEY no .env e reinicie.");
}

/**
 * Chamado a cada mensagem recebida. Espera o lead terminar de digitar (debounce)
 * e então roda, por lead e em série: qualificação + (resposta automática OU copiloto).
 */
export function scheduleLeadAi(ctx: AppContext, lead: Lead, settings: AppSettings): void {
  if (!ctx.ai.enabled) return;
  const botActive = lead.chatMode === "bot" && settings.bot.enabled && !lead.optedOut;
  const delay = ctx.aiDelayOverrideMs ?? (botActive ? settings.bot.replyDelaySeconds * 1000 : 1500);
  ctx.jobs.schedule(`lead:${lead.id}`, delay, () => processLeadAi(ctx, lead.id));
}

export async function processLeadAi(ctx: AppContext, leadId: number): Promise<void> {
  const settings = await getSettings(ctx.db);
  const lead = await getLead(ctx.db, leadId);
  const tasks: Promise<unknown>[] = [];
  if (settings.ai.autoQualify) tasks.push(runQualification(ctx, leadId));
  if (lead.chatMode === "bot" && settings.bot.enabled && !lead.optedOut) {
    tasks.push(runAutoReply(ctx, leadId));
  } else if (settings.copilot.enabled) {
    tasks.push(runCopilot(ctx, leadId));
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") ctx.log.error({ err: String(r.reason), leadId }, "falha em tarefa de IA");
  }
}

/**
 * A última mensagem do lead que ainda está sem resposta (ou undefined).
 * Qualquer mensagem nossa depois dela conta como resposta, menos a do bot que respondia uma mensagem
 * anterior (o lead escreveu de novo enquanto o bot enviava; essa nova ainda precisa de resposta).
 */
export function unansweredInbound(history: Message[]): Message | undefined {
  const lastIn = history.findLast((m) => m.direction === "in");
  if (!lastIn) return undefined;
  const answered = history.some(
    (m) =>
      m.id > lastIn.id &&
      m.direction === "out" &&
      !(m.author === "bot" && m.replyToId != null && m.replyToId < lastIn.id),
  );
  return answered ? undefined : lastIn;
}

/** Bot: responde o lead sozinho e, quando necessário, passa a conversa para um humano. */
export async function runAutoReply(ctx: AppContext, leadId: number): Promise<{ sent: boolean; handoff: boolean }> {
  const settings = await getSettings(ctx.db);
  const lead = await getLead(ctx.db, leadId);
  const history = await getConversation(ctx, leadId);
  // Só responde se a última mensagem do lead ainda não tiver resposta
  const target = unansweredInbound(history);
  if (!target) return { sent: false, handoff: false };

  let output: z.infer<typeof replySchema>;
  try {
    output = await ctx.ai.generate({
      task: "reply",
      system: P.replySystem(settings),
      prompt: P.replyPrompt(lead, await stageOf(ctx.db, lead), P.buildTranscript(history, ctx.config.APP_TIMEZONE)),
      schema: replySchema,
      effort: "low",
    });
  } catch (err) {
    // Acabou o limite de uso da IA (ex.: plano gratuito do OpenRouter): ninguém responderia o lead,
    // então a conversa passa para um humano, com aviso no painel
    if (!(err instanceof AiRateLimitError)) throw err;
    const current = await getLead(ctx.db, leadId);
    if (current.chatMode !== "bot") return { sent: false, handoff: false };
    await handoffToHuman(ctx, leadId, "limite de uso da IA atingido — responda você");
    return { sent: false, handoff: true };
  }

  // Enquanto a IA pensava: o lead mandou outra mensagem (a próxima rodada responde tudo junto),
  // alguém respondeu ou assumiu a conversa? Então descarta.
  const since = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.leadId, leadId), gte(messages.id, target.id)))
    .orderBy(asc(messages.id));
  const current = await getLead(ctx.db, leadId);
  if (unansweredInbound(since)?.id !== target.id || current.chatMode !== "bot" || current.optedOut) {
    return { sent: false, handoff: false };
  }

  let sent = false;
  if (output.reply.trim()) {
    try {
      await sendToLead(ctx, leadId, output.reply, { author: "bot", replyToId: target.id });
      sent = true;
    } catch (err) {
      // A falha fica registrada na conversa; a transferência para humano abaixo acontece mesmo assim
      ctx.log.warn({ err: String(err), leadId }, "falha ao enviar resposta do bot");
    }
  }
  if (output.handoff) {
    await handoffToHuman(ctx, leadId, output.handoffReason);
    if (settings.copilot.enabled) await runCopilot(ctx, leadId).catch(() => {});
  }
  return { sent, handoff: output.handoff };
}

async function handoffToHuman(ctx: AppContext, leadId: number, reason: string): Promise<void> {
  await updateLead(ctx, leadId, { chatMode: "human" }, { reason: "handoff" });
  await addActivity(ctx.db, leadId, "handoff", `IA passou a conversa para um humano: ${reason || "sem motivo"}`);
  ctx.events.emit("lead.handoff", { lead: await getLead(ctx.db, leadId), reason });
}

/** Atualiza a ficha do lead (nome, interesse, nota, temperatura...) a partir da conversa. */
export async function runQualification(ctx: AppContext, leadId: number): Promise<Lead> {
  ensureAi(ctx);
  const settings = await getSettings(ctx.db);
  const lead = await getLead(ctx.db, leadId);
  const stages = await listStages(ctx.db);
  const history = await getConversation(ctx, leadId, 60);
  const transcript = P.buildTranscript(history, ctx.config.APP_TIMEZONE);
  const extra = lead.notes ? `\n\nAnotações: ${lead.notes}` : "";

  const out = await ctx.ai.generate({
    task: "qualify",
    system: P.qualifySystem(settings, stages),
    prompt: P.qualifyPrompt(lead, stages.find((s) => s.id === lead.stageId), transcript + extra),
    schema: qualifySchema,
    effort: "low",
  });

  const score = Math.max(0, Math.min(100, Math.round(out.score)));
  const patch: Partial<typeof leads.$inferInsert> = {
    score,
    temperature: out.temperature,
    aiSummary: out.summary || lead.aiSummary,
    updatedAt: ctx.now(),
  };
  // Dados pessoais: só preenche o que está vazio (não sobrescreve o que você digitou)
  if (!lead.name && out.name.trim()) patch.name = out.name.trim();
  if (!lead.email && out.email.includes("@")) patch.email = out.email.trim().toLowerCase();
  if (!lead.company && out.company.trim()) patch.company = out.company.trim();
  if (out.interest.trim()) patch.interest = out.interest.trim();
  if (out.budget.trim()) patch.budget = out.budget.trim();
  if (out.timeline.trim()) patch.timeline = out.timeline.trim();
  const tags = out.tags.map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 5);
  if (tags.length) patch.tags = [...new Set([...lead.tags, ...tags])].slice(0, 20);

  await ctx.db.update(leads).set(patch).where(eq(leads.id, leadId));

  if (out.temperature === "quente" && lead.temperature !== "quente") {
    await addActivity(ctx.db, leadId, "hot", `🔥 IA marcou o lead como quente (nota ${score})`, { summary: out.summary });
    ctx.events.emit("lead.hot", { lead: await getLead(ctx.db, leadId), summary: out.summary, score });
  }

  // Avança no funil quando a IA tiver certeza — só para frente e nunca para Ganho/Perdido
  if (settings.ai.autoMoveStage && out.suggestedStage) {
    const target = stages.find((s) => s.name.toLowerCase() === out.suggestedStage.trim().toLowerCase());
    const current = stages.find((s) => s.id === lead.stageId);
    if (target && target.kind === "open" && (!current || (current.kind === "open" && target.position > current.position))) {
      await updateLead(ctx, leadId, { stageId: target.id }, { reason: "sugestão da IA" });
    }
  }

  const updated = await getLead(ctx.db, leadId);
  ctx.events.emit("lead.updated", { lead: updated });
  return updated;
}

export interface CopilotInsight {
  id: number;
  leadId: number;
  lastMessageId: number | null;
  createdAt: Date;
  data: CopilotOutput;
}

/**
 * Copiloto ("direcionador de conversa"): analisa a conversa e sugere caminhos ao VENDEDOR.
 * Esta função nunca envia mensagens — só grava sugestões que aparecem no painel.
 */
export async function runCopilot(ctx: AppContext, leadId: number): Promise<CopilotInsight> {
  ensureAi(ctx);
  const settings = await getSettings(ctx.db);
  const lead = await getLead(ctx.db, leadId);
  const history = await getConversation(ctx, leadId, 60);
  const out = await ctx.ai.generate({
    task: "copilot",
    system: P.copilotSystem(settings),
    prompt: P.copilotPrompt(lead, await stageOf(ctx.db, lead), P.buildTranscript(history, ctx.config.APP_TIMEZONE)),
    schema: copilotSchema,
    effort: "medium",
  });
  const [row] = await ctx.db
    .insert(copilotInsights)
    .values({ leadId, lastMessageId: history.at(-1)?.id ?? null, data: out, createdAt: ctx.now() })
    .returning();
  const insight = row as unknown as CopilotInsight;
  ctx.events.emit("copilot.updated", { leadId, insight });
  return insight;
}

export async function latestCopilot(ctx: AppContext, leadId: number): Promise<CopilotInsight | null> {
  const [row] = await ctx.db
    .select()
    .from(copilotInsights)
    .where(eq(copilotInsights.leadId, leadId))
    .orderBy(desc(copilotInsights.createdAt), desc(copilotInsights.id))
    .limit(1);
  return (row as unknown as CopilotInsight) ?? null;
}

/** Pergunta livre ao copiloto ("como respondo isso?", "melhora meu rascunho"). Também não envia nada. */
export async function askCopilot(
  ctx: AppContext,
  leadId: number,
  question: string,
  draft?: string,
): Promise<CopilotAskOutput> {
  ensureAi(ctx);
  const settings = await getSettings(ctx.db);
  const lead = await getLead(ctx.db, leadId);
  const history = await getConversation(ctx, leadId, 60);
  return ctx.ai.generate({
    task: "copilot_ask",
    system: P.copilotSystem(settings),
    prompt: P.copilotAskPrompt(
      lead,
      await stageOf(ctx.db, lead),
      P.buildTranscript(history, ctx.config.APP_TIMEZONE),
      question,
      draft,
    ),
    schema: copilotAskSchema,
    effort: "medium",
  });
}

/** Captador: encontra leads em qualquer texto (lista, mensagem, assinatura, planilha colada...). */
export async function extractLeadsFromText(ctx: AppContext, text: string): Promise<ExtractOutput["leads"]> {
  ensureAi(ctx);
  const out = await ctx.ai.generate({
    task: "extract",
    system: P.extractSystem(),
    prompt: `Texto:\n<texto>\n${text}\n</texto>\n\nExtraia os leads encontrados.`,
    schema: extractSchema,
    effort: "low",
  });
  // Devolve com "+" (ex.: +5511999998888): é exibido assim e, reenviado, não ganha outro 55
  return out.leads.map((l) => {
    const phone = l.phone ? normalizePhone(l.phone) : null;
    return { ...l, phone: phone ? asPhoneInput(phone) : l.phone };
  });
}

/** A IA escreve (e decide se vale a pena enviar) um follow-up para o lead. */
export async function composeFollowup(ctx: AppContext, leadId: number, instruction: string): Promise<FollowupOutput> {
  ensureAi(ctx);
  const settings = await getSettings(ctx.db);
  const lead = await getLead(ctx.db, leadId);
  const history = await getConversation(ctx, leadId, 40);
  return ctx.ai.generate({
    task: "followup",
    system: P.followupSystem(settings),
    prompt: P.followupPrompt(lead, await stageOf(ctx.db, lead), P.buildTranscript(history, ctx.config.APP_TIMEZONE), instruction),
    schema: followupSchema,
    effort: "low",
  });
}
