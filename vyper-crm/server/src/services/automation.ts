import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { enrollments, leads, scheduledMessages, sequences, type Lead, type Message, type Sequence } from "../db/schema.js";
import { getSettings, type AppSettings } from "../settings.js";
import { composeFollowup } from "./ai-flows.js";
import { addActivity, getLead, HttpError } from "./leads.js";
import { sendToLead } from "./messaging.js";

const MINUTE = 60_000;

/** Passos reservados há mais de 15 min sem terminar são considerados abandonados. */
function staleClaimCutoff(ctx: AppContext): Date {
  return new Date(ctx.now().getTime() - 15 * MINUTE);
}

/** Coloca o lead numa cadência de follow-up (se já estiver ativo nela, reinicia a contagem). */
export async function enroll(ctx: AppContext, leadId: number, sequenceId: number, reason = "manual"): Promise<void> {
  const [seq] = await ctx.db.select().from(sequences).where(eq(sequences.id, sequenceId));
  if (!seq) throw new HttpError(404, "Automação não encontrada.");
  if (seq.steps.length === 0) throw new HttpError(400, "Esta automação não tem passos.");
  const lead = await getLead(ctx.db, leadId);
  if (lead.optedOut) throw new HttpError(409, "O lead pediu para não receber mensagens automáticas.");
  const nextRunAt = new Date(ctx.now().getTime() + seq.steps[0]!.delayMinutes * MINUTE);

  const [active] = await ctx.db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.sequenceId, sequenceId), eq(enrollments.leadId, leadId), eq(enrollments.status, "active")));
  if (active) {
    await ctx.db
      .update(enrollments)
      .set({ stepIndex: 0, nextRunAt, updatedAt: ctx.now() })
      .where(eq(enrollments.id, active.id));
    return;
  }
  await ctx.db.insert(enrollments).values({ sequenceId, leadId, nextRunAt });
  // "sem resposta" reinicia a cada mensagem nossa — não poluímos a linha do tempo com isso
  if (seq.trigger !== "no_reply") {
    await addActivity(ctx.db, leadId, "enrolled", `Entrou na automação "${seq.name}" (${reason})`, { sequenceId });
  }
}

export async function stopEnrollments(
  ctx: AppContext,
  leadId: number,
  reason: string,
  opts: { onlyStopOnReply?: boolean; enrollmentId?: number } = {},
): Promise<number> {
  const active = await ctx.db
    .select({ e: enrollments, s: sequences })
    .from(enrollments)
    .innerJoin(sequences, eq(sequences.id, enrollments.sequenceId))
    .where(and(eq(enrollments.leadId, leadId), eq(enrollments.status, "active")));
  const ids = active
    .filter(({ e, s }) => (!opts.onlyStopOnReply || s.stopOnReply) && (!opts.enrollmentId || e.id === opts.enrollmentId))
    .map(({ e }) => e.id);
  if (ids.length === 0) return 0;
  await ctx.db
    .update(enrollments)
    .set({ status: "stopped", stopReason: reason, nextRunAt: null, updatedAt: ctx.now() })
    .where(inArray(enrollments.id, ids));
  return ids.length;
}

async function activeSequences(ctx: AppContext, trigger: Sequence["trigger"]): Promise<Sequence[]> {
  return ctx.db
    .select()
    .from(sequences)
    .where(and(eq(sequences.active, true), eq(sequences.trigger, trigger)));
}

/** Gatilho "lead criado": vale para leads de formulário, n8n, importação e cadastro manual. */
export async function onLeadCreated(ctx: AppContext, lead: Lead): Promise<void> {
  if (lead.source === "whatsapp" || !lead.phone || lead.optedOut) return;
  for (const seq of await activeSequences(ctx, "lead_created")) {
    if (seq.steps.length) await enroll(ctx, lead.id, seq.id, "lead criado").catch(() => {});
  }
}

/** Gatilho "sem resposta": cada mensagem nossa (bot ou vendedor) inicia/reinicia a contagem. */
export async function onOutboundSent(ctx: AppContext, lead: Lead, message: Message): Promise<void> {
  if (message.author === "automation" || lead.optedOut) return;
  for (const seq of await activeSequences(ctx, "no_reply")) {
    if (seq.steps.length) await enroll(ctx, lead.id, seq.id, "aguardando resposta").catch(() => {});
  }
}

export function renderTemplate(template: string, lead: Lead, settings: AppSettings): string {
  // Sem nome conhecido, a variável fica vazia (nunca cumprimentamos pelo número de telefone)
  const name = (lead.name || lead.waName || "").trim();
  const vars: Record<string, string> = {
    nome: name,
    primeiro_nome: name.split(/\s+/)[0] ?? "",
    empresa: lead.company ?? "",
    interesse: lead.interest ?? "nossos serviços",
    empresa_nome: settings.business.name,
    telefone: lead.phone ?? "",
    email: lead.email ?? "",
  };
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key.toLowerCase()] ?? "")
    .replace(/[ \t]+([,.!?;:])/g, "$1") // "Oi , tudo bem?" → "Oi, tudo bem?"
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function isWithinSendWindow(settings: AppSettings, now: Date, timezone: string): boolean {
  const a = settings.automation;
  if (!a.sendWindowEnabled) return true;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const current = Number(parts.hour) * 60 + Number(parts.minute);
  const start = minutesOf(a.sendWindowStart);
  const end = minutesOf(a.sendWindowEnd);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

async function runEnrollmentStep(ctx: AppContext, enrollmentId: number, settings: AppSettings): Promise<void> {
  const [row] = await ctx.db
    .select({ e: enrollments, s: sequences, l: leads })
    .from(enrollments)
    .innerJoin(sequences, eq(sequences.id, enrollments.sequenceId))
    .innerJoin(leads, eq(leads.id, enrollments.leadId))
    .where(eq(enrollments.id, enrollmentId));
  if (!row || row.e.status !== "active") return;
  const { e, s, l } = row;

  const stop = (reason: string) =>
    ctx.db
      .update(enrollments)
      .set({ status: "stopped", stopReason: reason, nextRunAt: null, updatedAt: ctx.now() })
      .where(eq(enrollments.id, e.id));

  if (!s.active) return void (await stop("automação desativada"));
  if (l.optedOut) return void (await stop("lead pediu para sair"));
  if (!l.phone) return void (await stop("lead sem telefone"));
  const step = s.steps[e.stepIndex];
  if (!step) {
    await ctx.db.update(enrollments).set({ status: "completed", nextRunAt: null, updatedAt: ctx.now() }).where(eq(enrollments.id, e.id));
    return;
  }

  // Reserva o passo (nextRunAt = null): evita envio duplo se duas rodadas se sobrepuserem
  const [claimed] = await ctx.db
    .update(enrollments)
    .set({ nextRunAt: null, updatedAt: ctx.now() })
    .where(
      and(
        eq(enrollments.id, e.id),
        eq(enrollments.status, "active"),
        eq(enrollments.stepIndex, e.stepIndex),
        or(isNotNull(enrollments.nextRunAt), lt(enrollments.updatedAt, staleClaimCutoff(ctx))),
      ),
    )
    .returning({ id: enrollments.id });
  if (!claimed) return;

  // Ainda vale? O lead pode ter respondido (ou alguém falou com ele) enquanto a IA escrevia.
  const stillDue = async () => {
    const [cur] = await ctx.db.select().from(enrollments).where(eq(enrollments.id, e.id));
    return cur?.status === "active" && cur.stepIndex === e.stepIndex && cur.nextRunAt === null;
  };

  try {
    let text = "";
    if (step.mode === "ai") {
      const out = await composeFollowup(ctx, l.id, step.message);
      if (!out.send) {
        await stop(`IA decidiu não enviar: ${out.reason}`);
        await addActivity(ctx.db, l.id, "followup_skipped", `Follow-up "${s.name}" não enviado: ${out.reason}`);
        return;
      }
      text = out.message;
    } else {
      text = renderTemplate(step.message, l, settings);
    }
    if (!(await stillDue())) return;
    await sendToLead(ctx, l.id, text, { author: "automation" });
    await addActivity(ctx.db, l.id, "followup_sent", `Follow-up "${s.name}" — passo ${e.stepIndex + 1} enviado`);
  } catch (err) {
    ctx.log.warn({ err: String(err), enrollmentId: e.id }, "falha ao executar passo da automação");
    await addActivity(ctx.db, l.id, "followup_failed", `Falha no follow-up "${s.name}": ${(err as Error).message}`);
  }

  const nextIndex = e.stepIndex + 1;
  const next = s.steps[nextIndex];
  await ctx.db
    .update(enrollments)
    .set(
      next
        ? { stepIndex: nextIndex, nextRunAt: new Date(ctx.now().getTime() + next.delayMinutes * MINUTE), updatedAt: ctx.now() }
        : { stepIndex: nextIndex, status: "completed", nextRunAt: null, updatedAt: ctx.now() },
    )
    .where(and(eq(enrollments.id, e.id), eq(enrollments.status, "active"), isNull(enrollments.nextRunAt)));
}

async function runScheduledMessage(ctx: AppContext, id: number): Promise<void> {
  const [sm] = await ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id));
  if (!sm || sm.status !== "pending") return;
  try {
    await sendToLead(ctx, sm.leadId, sm.body, { author: "agent", userId: sm.createdBy });
    await ctx.db.update(scheduledMessages).set({ status: "sent" }).where(eq(scheduledMessages.id, id));
  } catch (err) {
    await ctx.db
      .update(scheduledMessages)
      .set({ status: "failed", error: (err as Error).message.slice(0, 500) })
      .where(eq(scheduledMessages.id, id));
  }
}

/** Uma rodada do agendador: dispara follow-ups e mensagens agendadas que já venceram. */
export async function runSchedulerTick(ctx: AppContext): Promise<{ steps: number; scheduled: number }> {
  const settings = await getSettings(ctx.db);
  const now = ctx.now();
  if (!isWithinSendWindow(settings, now, ctx.config.APP_TIMEZONE)) return { steps: 0, scheduled: 0 };

  const dueScheduled = await ctx.db
    .select({ id: scheduledMessages.id })
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.status, "pending"), lte(scheduledMessages.sendAt, now)))
    .orderBy(asc(scheduledMessages.sendAt))
    .limit(50);
  for (const { id } of dueScheduled) await runScheduledMessage(ctx, id);

  const due = await ctx.db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.status, "active"),
        or(
          lte(enrollments.nextRunAt, now),
          // reserva abandonada (o processo caiu no meio do envio)
          and(isNull(enrollments.nextRunAt), lt(enrollments.updatedAt, staleClaimCutoff(ctx))),
        ),
      ),
    )
    .orderBy(asc(enrollments.nextRunAt))
    .limit(50);
  for (const { id } of due) await runEnrollmentStep(ctx, id, settings);

  return { steps: due.length, scheduled: dueScheduled.length };
}

export function startScheduler(ctx: AppContext, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runSchedulerTick(ctx);
    } catch (err) {
      ctx.log.error({ err: String(err) }, "erro no agendador de automações");
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
