import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  activities,
  enrollments,
  leads,
  messages,
  scheduledMessages,
  sequences,
  stages,
  users,
} from "../db/schema.js";
import { currentUserId, HttpError, idParam, parse, requireChanges } from "../http.js";
import {
  askCopilot,
  extractLeadsFromText,
  latestCopilot,
  runCopilot,
  runQualification,
} from "../services/ai-flows.js";
import { enroll, stopEnrollments } from "../services/automation.js";
import { addActivity, createLead, getLead, leadInputSchema, updateLead } from "../services/leads.js";
import { getConversation, sendToLead, whatsAppTarget } from "../services/messaging.js";
import { getSettings } from "../settings.js";

export const listQuerySchema = z.object({
  search: z.string().trim().optional(),
  stageId: z.coerce.number().int().optional(),
  temperature: z.enum(["frio", "morno", "quente"]).optional(),
  source: z.string().optional(),
  chatMode: z.enum(["bot", "human"]).optional(),
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
  return where.length ? and(...where) : undefined;
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
    return row;
  });

  app.delete("/api/scheduled/:id", async (req) => {
    const id = idParam(req);
    await db
      .update(scheduledMessages)
      .set({ status: "canceled" })
      .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, "pending")));
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
      z.object({ question: z.string().trim().min(1).max(2000), draft: z.string().max(4096).optional() }),
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
