import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  activities,
  enrollments,
  leads,
  messages,
  playbooks,
  scheduledMessages,
  sequences,
  stages,
  users,
  type Lead,
  type Playbook,
} from "../db/schema.js";
import { currentUserId, HttpError, idParam, parse, requireChanges } from "../http.js";
import { asPhoneInput, normalizePhone } from "../lib/phone.js";
import {
  askCopilot,
  extractLeadsFromText,
  latestCopilot,
  runCopilot,
  runQualification,
} from "../services/ai-flows.js";
import { enroll, stopEnrollments } from "../services/automation.js";
import {
  addActivity,
  createLead,
  findLeadByPhone,
  getLead,
  leadInputSchema,
  updateLead,
} from "../services/leads.js";
import { getConversation, sendToLead, whatsAppTarget } from "../services/messaging.js";
import { renderPlaybookMessage, scheduleFirstMessages } from "../services/outreach.js";
import { getSettings } from "../settings.js";

export { renderPlaybookMessage } from "../services/outreach.js";


export const listQuerySchema = z.object({
  search: z.string().trim().optional(),
  stageId: z.coerce.number().int().optional(),
  temperature: z.enum(["frio", "morno", "quente"]).optional(),
  source: z.string().optional(),
  chatMode: z.enum(["bot", "human"]).optional(),
  playbookId: z.string().optional(),
  // never = nunca recebeu mensagem nossa; queued = tem envio na fila; sent = já mandamos e ainda não respondeu; replied = já respondeu
  contact: z.enum(["never", "queued", "sent", "replied"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export function leadFilters(q: z.infer<typeof listQuerySchema>): SQL | undefined {
  const where: SQL[] = [];
  if (q.search) {
    const term = `%${q.search.replace(/[%_]/g, "")}%`;
    const digits = q.search.replace(/\D/g, "");
    const conds = [
      ilike(leads.name, term),
      ilike(leads.waName, term),
      ilike(leads.email, term),
      ilike(leads.company, term),
      ilike(leads.interest, term),
    ];
    if (digits.length >= 3) conds.push(ilike(leads.phone, `%${digits}%`));
    where.push(or(...conds)!);
  }
  if (q.stageId) where.push(eq(leads.stageId, q.stageId));
  if (q.temperature) where.push(eq(leads.temperature, q.temperature));
  if (q.source) where.push(eq(leads.source, q.source));
  if (q.chatMode) where.push(eq(leads.chatMode, q.chatMode));
  if (q.playbookId) {
    if (q.playbookId === "none") {
      where.push(isNull(leads.playbookId));
    } else {
      const pid = parseInt(q.playbookId, 10);
      if (!Number.isNaN(pid)) {
        where.push(eq(leads.playbookId, pid));
      }
    }
  }
  if (q.contact) {
    const sentOk = sql`exists (select 1 from ${messages} m where m.lead_id = ${leads.id} and m.direction = 'out' and m.status <> 'failed')`;
    const replied = sql`exists (select 1 from ${messages} m where m.lead_id = ${leads.id} and m.direction = 'in')`;
    const queued = sql`exists (select 1 from ${scheduledMessages} s where s.lead_id = ${leads.id} and s.status = 'pending')`;
    if (q.contact === "never") where.push(sql`not ${sentOk} and not ${replied} and not ${queued}`);
    if (q.contact === "queued") where.push(queued);
    if (q.contact === "sent") where.push(sql`${sentOk} and not ${replied}`);
    if (q.contact === "replied") where.push(replied);
  }
  return where.length ? and(...where) : undefined;
}

const INVALID_PHONE = "Telefone inválido. Use DDD + número (ex.: 11999998888).";
const META_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * API oficial da Meta: fora da janela de 24h desde a última mensagem do contato, só templates aprovados
 * são entregues (e o CRM envia só texto). Avisa antes de você escrever para quem não falou com você.
 */
function startWarning(ctx: AppContext, lead: Lead): string | null {
  if (ctx.wa.name !== "meta") return null;
  const last = lead.lastInboundAt?.getTime();
  if (last !== undefined && ctx.now().getTime() - last < META_WINDOW_MS) return null;
  return (
    "Pela API oficial da Meta, só dá para iniciar uma conversa com um modelo (template) aprovado. " +
    "Como este contato não te escreveu nas últimas 24h, uma mensagem de texto comum provavelmente será recusada."
  );
}

export async function leadRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.get("/api/leads", async (req) => {
    const q = parse(listQuerySchema, req.query);
    const where = leadFilters(q);
    const [rows, [count]] = await Promise.all([
      db.select().from(leads).where(where).orderBy(desc(leads.updatedAt), desc(leads.id)).limit(q.limit).offset(q.offset),
      db.select({ n: sql<number>`count(*)::int` }).from(leads).where(where),
    ]);
    return { items: rows, total: count?.n ?? 0 };
  });

  app.post("/api/leads", async (req) => {
    const body = parse(leadInputSchema, req.body);
    return createLead(ctx, body, { userId: currentUserId(req) });
  });

  app.post("/api/leads/bulk/playbook", async (req) => {
    const body = parse(
      z.object({
        leadIds: z.array(z.number().int()).min(1).max(200),
        playbookId: z.number().int().nullable(),
        chatMode: z.enum(["bot", "human"]).optional(),
        firstMessage: z
          .object({
            send: z.boolean(),
            text: z.string(),
            intervalMinutes: z.number().int().min(1).max(120).optional().default(1),
          })
          .optional(),
      }),
      req.body,
    );

    if (body.firstMessage?.send && !body.firstMessage.text.trim()) {
      throw new HttpError(400, "Escreva a primeira mensagem antes de disparar.");
    }

    let playbook: Playbook | null = null;
    if (body.playbookId != null) {
      const [pb] = await db.select().from(playbooks).where(eq(playbooks.id, body.playbookId));
      if (!pb) throw new HttpError(400, `O roteiro #${body.playbookId} não existe.`);
      playbook = pb;
    }

    const uniqueIds = [...new Set(body.leadIds)];
    const leadRows = await db.select().from(leads).where(inArray(leads.id, uniqueIds));
    const leadsMap = new Map(leadRows.map((l) => [l.id, l]));

    let updated = 0;
    const targetLeads: Lead[] = [];

    for (const id of uniqueIds) {
      const lead = leadsMap.get(id);
      if (!lead) continue;

      const patch: Partial<typeof leads.$inferInsert> = {
        playbookId: body.playbookId,
        updatedAt: ctx.now(),
      };
      if (body.chatMode) {
        patch.chatMode = body.chatMode;
      }

      const [up] = await db.update(leads).set(patch).where(eq(leads.id, id)).returning();
      if (up) {
        updated++;
        await addActivity(
          db,
          id,
          "playbook",
          playbook ? `Roteiro aplicado: ${playbook.name}` : "Roteiro removido",
          undefined,
          currentUserId(req),
        );
        ctx.events.emit("lead.updated", { lead: up });
        targetLeads.push(up);
      } else {
        targetLeads.push(lead);
      }
    }

    let queued = 0;
    let skipped: Array<{ leadId: number; reason: string }> = [];
    let lastSendAt: string | null = null;

    if (body.firstMessage?.send) {
      const scheduled = await scheduleFirstMessages(ctx, targetLeads, {
        text: body.firstMessage.text,
        intervalMinutes: body.firstMessage.intervalMinutes,
        userId: currentUserId(req),
      });
      queued = scheduled.queued;
      skipped = scheduled.skipped;
      lastSendAt = scheduled.lastSendAt;
    }

    return { updated, queued, skipped, lastSendAt };
  });

  app.get("/api/leads/:id", async (req) => {
    const id = idParam(req);
    const lead = await getLead(db, id);
    const [timeline, enrolled, scheduled] = await Promise.all([
      db
        .select({
          id: activities.id,
          type: activities.type,
          description: activities.description,
          data: activities.data,
          createdAt: activities.createdAt,
          userName: users.name,
        })
        .from(activities)
        .leftJoin(users, eq(users.id, activities.userId))
        .where(eq(activities.leadId, id))
        .orderBy(desc(activities.createdAt), desc(activities.id))
        .limit(100),
      db
        .select({
          id: enrollments.id,
          status: enrollments.status,
          stepIndex: enrollments.stepIndex,
          nextRunAt: enrollments.nextRunAt,
          stopReason: enrollments.stopReason,
          sequenceId: sequences.id,
          sequenceName: sequences.name,
          totalSteps: sql<number>`jsonb_array_length(${sequences.steps})`,
        })
        .from(enrollments)
        .innerJoin(sequences, eq(sequences.id, enrollments.sequenceId))
        .where(eq(enrollments.leadId, id))
        .orderBy(desc(enrollments.createdAt))
        .limit(20),
      db
        .select()
        .from(scheduledMessages)
        .where(eq(scheduledMessages.leadId, id))
        .orderBy(desc(scheduledMessages.sendAt))
        .limit(20),
    ]);
    return { lead, activities: timeline, enrollments: enrolled, scheduled };
  });

  app.patch("/api/leads/:id", async (req) => {
    const body = parse(leadInputSchema, req.body);
    return updateLead(ctx, idParam(req), body, { userId: currentUserId(req) });
  });

  app.delete("/api/leads/:id", async (req) => {
    const id = idParam(req);
    await getLead(db, id);
    await db.delete(leads).where(eq(leads.id, id));
    ctx.events.emit("lead.deleted", { leadId: id });
    return { ok: true };
  });

  app.post("/api/leads/:id/notes", async (req) => {
    const id = idParam(req);
    const body = parse(z.object({ text: z.string().trim().min(1).max(5000) }), req.body);
    await getLead(db, id);
    await addActivity(db, id, "note", body.text, undefined, currentUserId(req));
    return { ok: true };
  });

  app.post("/api/leads/:id/read", async (req) => {
    const id = idParam(req);
    await db.update(leads).set({ unreadCount: 0 }).where(eq(leads.id, id));
    ctx.events.emit("lead.updated", { lead: await getLead(db, id) });
    return { ok: true };
  });

  // ---- Mensagens ----
  app.get("/api/leads/:id/messages", async (req) => {
    const id = idParam(req);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    return getConversation(ctx, id, q.limit);
  });

  app.post("/api/leads/:id/messages", async (req) => {
    const id = idParam(req);
    const body = parse(z.object({ body: z.string().trim().min(1).max(4096) }), req.body);
    const msg = await sendToLead(ctx, id, body.body, { author: "agent", userId: currentUserId(req) });
    await db.update(leads).set({ unreadCount: 0 }).where(eq(leads.id, id));
    // Você respondeu → a IA pausa nesta conversa (mesma regra de quando você responde pelo celular)
    const lead = await getLead(db, id);
    if (lead.chatMode === "bot" && (await getSettings(db)).bot.pauseOnPhoneReply) {
      await updateLead(ctx, id, { chatMode: "human" }, { userId: currentUserId(req), reason: "você respondeu" });
    }
    return msg;
  });

  app.post("/api/leads/:id/schedule", async (req) => {
    const id = idParam(req);
    const body = parse(z.object({ body: z.string().trim().min(1).max(4096), sendAt: z.coerce.date() }), req.body);
    if (body.sendAt.getTime() < ctx.now().getTime() - 60_000) throw new HttpError(400, "A data precisa estar no futuro.");
    const lead = await getLead(db, id);
    if (!whatsAppTarget(lead)) throw new HttpError(400, "Este lead não tem telefone.");
    const [row] = await db
      .insert(scheduledMessages)
      .values({ leadId: id, body: body.body, sendAt: body.sendAt, createdBy: currentUserId(req) })
      .returning();
    ctx.events.emit("scheduled.updated", { leadId: id, id: row.id });
    return row;
  });

  app.delete("/api/scheduled/:id", async (req) => {
    const id = idParam(req);
    const [row] = await db
      .update(scheduledMessages)
      .set({ status: "canceled", error: "cancelada por você" })
      .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, "pending")))
      .returning();
    if (row) {
      ctx.events.emit("scheduled.updated", { leadId: row.leadId, id: row.id });
    }
    return { ok: true };
  });

  // ---- IA ----
  app.post("/api/leads/:id/qualify", async (req) => runQualification(ctx, idParam(req)));

  app.get("/api/leads/:id/copilot", async (req) => {
    const id = idParam(req);
    const insight = await latestCopilot(ctx, id);
    const [last] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.leadId, id))
      .orderBy(desc(messages.id))
      .limit(1);
    return { insight, stale: Boolean(insight && last && insight.lastMessageId !== last.id), aiEnabled: ctx.ai.enabled };
  });

  app.post("/api/leads/:id/copilot", async (req) => {
    const insight = await runCopilot(ctx, idParam(req));
    return { insight, stale: false, aiEnabled: true };
  });

  app.post("/api/leads/:id/copilot/ask", async (req) => {
    const body = parse(
      z.object({ question: z.string().trim().min(1).max(8000), draft: z.string().max(4096).optional() }),
      req.body,
    );
    return askCopilot(ctx, idParam(req), body.question, body.draft?.trim() || undefined);
  });

  // ---- Automações do lead ----
  app.post("/api/leads/:id/enroll", async (req) => {
    const body = parse(z.object({ sequenceId: z.number().int() }), req.body);
    await enroll(ctx, idParam(req), body.sequenceId, "manual");
    return { ok: true };
  });

  app.post("/api/enrollments/:id/stop", async (req) => {
    const id = idParam(req);
    const [e] = await db.select().from(enrollments).where(eq(enrollments.id, id));
    if (!e) throw new HttpError(404, "Inscrição não encontrada.");
    await stopEnrollments(ctx, e.leadId, "parado manualmente", { enrollmentId: id });
    return { ok: true };
  });

  // ---- Captador de leads com IA ----
  app.post("/api/leads/extract", async (req) => {
    const body = parse(z.object({ text: z.string().trim().min(3).max(50_000) }), req.body);
    return { leads: await extractLeadsFromText(ctx, body.text) };
  });

  app.post("/api/leads/import", async (req) => {
    const body = parse(
      z.object({
        leads: z.array(leadInputSchema).min(1).max(500),
        source: z.string().default("importacao"),
        stageId: z.number().int().optional(),
      }),
      req.body,
    );
    const created: number[] = [];
    const errors: Array<{ index: number; error: string }> = [];
    for (const [index, input] of body.leads.entries()) {
      try {
        const lead = await createLead(
          ctx,
          { ...input, source: input.source ?? body.source, stageId: input.stageId ?? body.stageId },
          { userId: currentUserId(req) },
        );
        created.push(lead.id);
      } catch (err) {
        if (!(err instanceof HttpError)) ctx.log.error({ err: String(err), index }, "erro ao importar lead");
        errors.push({ index, error: err instanceof HttpError ? err.message : "Erro inesperado ao criar este lead." });
      }
    }
    return { created: created.length, ids: created, errors };
  });

  // ---- Caixa de entrada ----
  /**
   * Nova conversa (como no WhatsApp Web): acha o lead pelo telefone ou cria um, sem enviar nada.
   * A conversa só entra na lista de conversas depois da primeira mensagem.
   */
  app.post("/api/conversations/start", async (req) => {
    const body = parse(
      // Telefone curto demais cai no normalizePhone, com a mesma mensagem amigável
      z.object({ phone: z.string().trim().max(40), name: z.string().trim().max(200).nullish() }),
      req.body,
    );
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, INVALID_PHONE);
    const userId = currentUserId(req);
    const respond = (lead: Lead, created: boolean) => ({ lead, created, warning: startWarning(ctx, lead) });

    const existing = await findLeadByPhone(db, phone);
    if (existing) return respond(existing, false);

    if (ctx.wa.checkNumber) {
      try {
        const check = await ctx.wa.checkNumber(phone);
        if (!check.exists) throw new HttpError(422, "Este número não tem WhatsApp.");
      } catch (err) {
        if (err instanceof HttpError) throw err;
        // Desconectado ou fora do ar: não dá para conferir agora, mas a conversa pode ser criada
        ctx.log.warn({ err: String(err) }, "não deu para conferir se o número tem WhatsApp");
      }
    }

    try {
      const lead = await createLead(
        ctx,
        { phone: asPhoneInput(phone), name: body.name, source: "manual", chatMode: "human" },
        { userId },
      );
      return respond(lead, true);
    } catch (err) {
      // Outra requisição (ou uma mensagem recebida) criou o mesmo contato ao mesmo tempo
      if (err instanceof HttpError && err.statusCode === 409) {
        const raced = await findLeadByPhone(db, phone);
        if (raced) return respond(raced, false);
      }
      throw err;
    }
  });

  app.get("/api/conversations", async (req) => {
    const q = parse(
      listQuerySchema.extend({
        filter: z.enum(["all", "unread", "bot", "human", "waiting"]).default("all"),
      }),
      req.query,
    );
    const where: SQL[] = [isNotNull(leads.lastMessageAt)];
    const extra = leadFilters(q);
    if (extra) where.push(extra);
    if (q.filter === "unread") where.push(sql`${leads.unreadCount} > 0`);
    if (q.filter === "bot") where.push(eq(leads.chatMode, "bot"));
    if (q.filter === "human") where.push(eq(leads.chatMode, "human"));
    // Aguardando você: última mensagem é do lead e a conversa está com humano
    if (q.filter === "waiting")
      where.push(and(eq(leads.chatMode, "human"), sql`${leads.lastInboundAt} = ${leads.lastMessageAt}`)!);
    const rows = await db
      .select()
      .from(leads)
      .where(and(...where))
      .orderBy(desc(leads.lastMessageAt))
      .limit(q.limit)
      .offset(q.offset);
    const ids = rows.map((r) => r.id);
    const lastMessages = ids.length
      ? await db
          .selectDistinctOn([messages.leadId], {
            leadId: messages.leadId,
            body: messages.body,
            direction: messages.direction,
            author: messages.author,
            status: messages.status,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(inArray(messages.leadId, ids))
          .orderBy(messages.leadId, desc(messages.id))
      : [];
    const byLead = new Map(lastMessages.map((m) => [m.leadId, m]));
    return rows.map((lead) => ({ lead, lastMessage: byLead.get(lead.id) ?? null }));
  });

  // ---- Funil ----
  app.get("/api/stages", async () => db.select().from(stages).orderBy(asc(stages.position), asc(stages.id)));

  const stageSchema = z.object({
    name: z.string().trim().min(1).max(60),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    kind: z.enum(["open", "won", "lost"]).optional(),
    position: z.number().int().optional(),
  });

  app.post("/api/stages", async (req) => {
    const body = parse(stageSchema, req.body);
    const [max] = await db.select({ p: sql<number>`coalesce(max(${stages.position}), -1)::int` }).from(stages);
    const [row] = await db
      .insert(stages)
      .values({ ...body, position: body.position ?? (max?.p ?? -1) + 1 })
      .returning();
    return row;
  });

  app.patch("/api/stages/:id", async (req) => {
    const body = requireChanges(parse(stageSchema.partial(), req.body));
    const [row] = await db.update(stages).set(body).where(eq(stages.id, idParam(req))).returning();
    if (!row) throw new HttpError(404, "Etapa não encontrada.");
    return row;
  });

  app.delete("/api/stages/:id", async (req) => {
    const id = idParam(req);
    const [used] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(eq(leads.stageId, id));
    if (used?.n) throw new HttpError(409, `Mova os ${used.n} leads desta etapa antes de excluí-la.`);
    await db.delete(stages).where(eq(stages.id, id));
    return { ok: true };
  });
}
