import { randomUUID } from "node:crypto";
import type { AppContext } from "../context.js";
import { scheduledMessages, type Lead } from "../db/schema.js";
import { getSettings, type AppSettings } from "../settings.js";
import { nextSendWindowStart } from "./automation.js";

/**
 * Calcula a data do próximo envio espaçado pelo intervalo informado com jitter ±15%,
 * garantindo mínimo de 25s quando intervalMinutes=1 e respeitando a janela de envio.
 */
export function nextScheduledDate(
  current: Date,
  intervalMinutes: number,
  settings: AppSettings,
  timezone: string,
): Date {
  const baseMs = intervalMinutes * 60_000;
  const jitter = Math.random() * 0.30 - 0.15; // ±15%
  let intervalMs = Math.round(baseMs * (1 + jitter));
  if (intervalMinutes === 1 && intervalMs < 25_000) {
    intervalMs = 25_000;
  }
  const nextTarget = new Date(current.getTime() + intervalMs);
  return nextSendWindowStart(settings, nextTarget, timezone);
}

export function renderPlaybookMessage(
  template: string,
  lead: Pick<Lead, "name" | "waName" | "company">,
): string {
  const name = (lead.name || lead.waName || "").trim();
  const firstName = name ? (name.split(/\s+/)[0] ?? "") : "";
  const company = (lead.company || lead.name || "").trim();

  const vars: Record<string, string> = {
    nome: name,
    primeiro_nome: firstName,
    empresa: company,
  };

  const EMPTY = "\uE000";
  return template
    .replaceAll(EMPTY, "")
    .replace(/\{{1,2}\s*(\w+)\s*\}{1,2}/g, (_, key: string) => {
      const val = vars[key.toLowerCase()];
      return val && val.trim() ? val.trim() : EMPTY;
    })
    .replace(/^([ \t]*)[ \t]*,?[ \t]*/gm, "$1") // ", tudo bem?" → "tudo bem?"
    .replace(/[ \t]*,?[ \t]*(?=[ \t]*[,.!?;:])/g, "") // "Oi , tudo" → "Oi, tudo"; "Oi, !" → "Oi!"
    .replace(/[ \t]*/g, "") // "Oi  tudo bem" → "Oi tudo bem"
    .trim();
}

export interface ScheduleFirstMessagesOpts {
  text: string;
  intervalMinutes?: number;
  userId?: number | null;
}

export interface ScheduleFirstMessagesResult {
  queued: number;
  skipped: Array<{ leadId: number; reason: string }>;
  lastSendAt: string | null;
}

export async function scheduleFirstMessages(
  ctx: AppContext,
  leads: Lead[],
  opts: ScheduleFirstMessagesOpts,
): Promise<ScheduleFirstMessagesResult> {
  const skipped: Array<{ leadId: number; reason: string }> = [];
  const eligibleLeads: Lead[] = [];

  for (const lead of leads) {
    if (!lead.phone) {
      skipped.push({ leadId: lead.id, reason: "sem telefone" });
      continue;
    }
    if (lead.optedOut) {
      skipped.push({ leadId: lead.id, reason: "pediu para não receber mensagens" });
      continue;
    }
    if ((ctx.wa.name === "evolution" || ctx.wa.name === "simulator") && ctx.wa.checkNumber) {
      try {
        const check = await ctx.wa.checkNumber(lead.phone);
        if (!check.exists) {
          skipped.push({ leadId: lead.id, reason: "número sem WhatsApp" });
          continue;
        }
      } catch {
        // falhas na checagem não bloqueiam o envio
      }
    }
    eligibleLeads.push(lead);
  }

  let queued = 0;
  let lastSendAt: string | null = null;

  if (eligibleLeads.length > 0) {
    const settings = await getSettings(ctx.db);
    const timezone = ctx.config.APP_TIMEZONE;
    const intervalMinutes = opts.intervalMinutes ?? 1;
    const now = ctx.now();
    let plannedDate: Date = nextSendWindowStart(settings, now, timezone);
    const batchId = randomUUID();

    for (let i = 0; i < eligibleLeads.length; i++) {
      const target = eligibleLeads[i]!;

      if (i > 0) {
        plannedDate = nextScheduledDate(plannedDate, intervalMinutes, settings, timezone);
      }

      const msgText = renderPlaybookMessage(opts.text, target);
      const [inserted] = await ctx.db
        .insert(scheduledMessages)
        .values({
          leadId: target.id,
          body: msgText,
          sendAt: plannedDate,
          author: "automation",
          batchId,
          createdBy: opts.userId ?? null,
        })
        .returning();
      queued++;
      ctx.events.emit("scheduled.updated", { leadId: target.id, id: inserted?.id });
    }

    lastSendAt = plannedDate.toISOString();
  }

  return { queued, skipped, lastSendAt };
}
