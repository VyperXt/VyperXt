import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { enrollments, leads, playbooks, scheduledMessages, sequences } from "../db/schema.js";
import { HttpError, idParam, parse, requireChanges } from "../http.js";
import { getQueueState, getSettings, setQueueState } from "../settings.js";
import { nextSendWindowStart } from "../services/automation.js";
import { nextScheduledDate } from "../services/outreach.js";

const stepSchema = z.object({
  delayMinutes: z.number().int().min(0).max(60 * 24 * 90),
  mode: z.enum(["text", "ai"]),
  message: z.string().trim().min(1).max(4096),
});

// Sem .default() aqui: o PATCH usa .partial() e, no Zod 4, um default dentro de partial()
// preencheria o campo ausente (ex.: ligar/desligar a automação zerava o gatilho para "manual").
const sequenceFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullish(),
  active: z.boolean(),
  trigger: z.enum(["manual", "lead_created", "no_reply"]),
  stopOnReply: z.boolean(),
  steps: z.array(stepSchema).max(20),
});

export const sequenceSchema = sequenceFields.extend({
  active: sequenceFields.shape.active.default(true),
  trigger: sequenceFields.shape.trigger.default("manual"),
  stopOnReply: sequenceFields.shape.stopOnReply.default(true),
});
export const sequencePatchSchema = sequenceFields.partial();

export async function automationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.get("/api/sequences", async () => {
    const rows = await db.select().from(sequences).orderBy(asc(sequences.id));
    const counts = await db
      .select({ sequenceId: enrollments.sequenceId, status: enrollments.status, n: sql<number>`count(*)::int` })
      .from(enrollments)
      .groupBy(enrollments.sequenceId, enrollments.status);
    return rows.map((s) => ({
      ...s,
      stats: Object.fromEntries(counts.filter((c) => c.sequenceId === s.id).map((c) => [c.status, c.n])),
    }));
  });

  app.post("/api/sequences", async (req) => {
    const body = parse(sequenceSchema, req.body);
    const [row] = await db.insert(sequences).values(body).returning();
    return row;
  });

  app.patch("/api/sequences/:id", async (req) => {
    const body = requireChanges(parse(sequencePatchSchema, req.body));
    const [row] = await db.update(sequences).set(body).where(eq(sequences.id, idParam(req))).returning();
    if (!row) throw new HttpError(404, "Automação não encontrada.");
    if (body.active === false) {
      await db
        .update(enrollments)
        .set({ status: "stopped", stopReason: "automação desativada", nextRunAt: null })
        .where(and(eq(enrollments.sequenceId, row.id), eq(enrollments.status, "active")));
    }
    return row;
  });

  app.delete("/api/sequences/:id", async (req) => {
    await db.delete(sequences).where(eq(sequences.id, idParam(req)));
    return { ok: true };
  });

  app.get("/api/sequences/:id/enrollments", async (req) => {
    return db
      .select({
        id: enrollments.id,
        status: enrollments.status,
        stepIndex: enrollments.stepIndex,
        nextRunAt: enrollments.nextRunAt,
        stopReason: enrollments.stopReason,
        createdAt: enrollments.createdAt,
        leadId: leads.id,
        leadName: sql<string>`coalesce(${leads.name}, ${leads.waName}, ${leads.phone})`,
      })
      .from(enrollments)
      .innerJoin(leads, eq(leads.id, enrollments.leadId))
      .where(eq(enrollments.sequenceId, idParam(req)))
      .orderBy(desc(enrollments.updatedAt))
      .limit(200);
  });

  app.get("/api/scheduled", async () => {
    const selectFields = {
      id: scheduledMessages.id,
      body: scheduledMessages.body,
      sendAt: scheduledMessages.sendAt,
      status: scheduledMessages.status,
      error: scheduledMessages.error,
      author: scheduledMessages.author,
      batchId: scheduledMessages.batchId,
      createdAt: scheduledMessages.createdAt,
      leadId: leads.id,
      leadName: sql<string>`coalesce(${leads.name}, ${leads.waName}, ${leads.phone})`,
      leadPhone: leads.phone,
      playbookName: playbooks.name,
    };

    const pending = await db
      .select(selectFields)
      .from(scheduledMessages)
      .innerJoin(leads, eq(leads.id, scheduledMessages.leadId))
      .leftJoin(playbooks, eq(playbooks.id, leads.playbookId))
      .where(eq(scheduledMessages.status, "pending"))
      .orderBy(asc(scheduledMessages.sendAt));

    const nonPending = await db
      .select(selectFields)
      .from(scheduledMessages)
      .innerJoin(leads, eq(leads.id, scheduledMessages.leadId))
      .leftJoin(playbooks, eq(playbooks.id, leads.playbookId))
      .where(ne(scheduledMessages.status, "pending"))
      .orderBy(desc(scheduledMessages.sendAt))
      .limit(100);

    return [...pending, ...nonPending];
  });

  app.post("/api/scheduled/cancel", async (req) => {
    const cancelBodySchema = z.object({
      ids: z.array(z.number().int()).min(1).max(500).optional(),
      batchId: z.string().trim().min(1).optional(),
      all: z.boolean().optional(),
    });
    const body = parse(cancelBodySchema, req.body);

    const hasIds = body.ids !== undefined;
    const hasBatchId = body.batchId !== undefined;
    const hasAll = body.all === true;

    const activeCount = [hasIds, hasBatchId, hasAll].filter(Boolean).length;
    if (activeCount !== 1 || (body.all !== undefined && body.all !== true)) {
      throw new HttpError(400, "Informe exatamente uma opção: ids, batchId ou all.");
    }

    const conds: SQL[] = [eq(scheduledMessages.status, "pending")];
    if (hasIds) {
      conds.push(inArray(scheduledMessages.id, body.ids!));
    } else if (hasBatchId) {
      conds.push(eq(scheduledMessages.batchId, body.batchId!));
    }

    const updated = await db
      .update(scheduledMessages)
      .set({ status: "canceled", error: "cancelada por você" })
      .where(and(...conds))
      .returning({ id: scheduledMessages.id, leadId: scheduledMessages.leadId });

    for (const row of updated) {
      ctx.events.emit("scheduled.updated", { id: row.id, leadId: row.leadId });
    }

    return { canceled: updated.length };
  });

  app.get("/api/scheduled/status", async () => {
    return getQueueState(db);
  });

  app.post("/api/scheduled/resume", async () => {
    const state = await setQueueState(db, { pausedUntil: null, reason: null });
    ctx.events.emit("scheduled.updated", {});
    return state;
  });

  app.post("/api/scheduled/retry", async (req) => {
    const retryBodySchema = z.object({
      ids: z.array(z.number().int()).min(1).max(500).optional(),
      all: z.boolean().optional(),
      intervalMinutes: z.number().int().min(1).max(120).optional(),
    });
    const body = parse(retryBodySchema, req.body);

    const hasIds = body.ids !== undefined;
    const hasAll = body.all === true;

    const activeCount = [hasIds, hasAll].filter(Boolean).length;
    if (activeCount !== 1 || (body.all !== undefined && body.all !== true)) {
      throw new HttpError(400, "Informe exatamente uma opção: ids ou all.");
    }

    const conds: SQL[] = [eq(scheduledMessages.status, "failed")];
    if (hasIds) {
      conds.push(inArray(scheduledMessages.id, body.ids!));
    }

    const rows = await db
      .select({
        id: scheduledMessages.id,
        leadId: scheduledMessages.leadId,
        sendAt: scheduledMessages.sendAt,
        batchId: scheduledMessages.batchId,
        optedOut: leads.optedOut,
      })
      .from(scheduledMessages)
      .innerJoin(leads, eq(leads.id, scheduledMessages.leadId))
      .where(and(...conds))
      .orderBy(asc(scheduledMessages.sendAt), asc(scheduledMessages.id));

    const eligible = rows.filter((r) => !r.optedOut);
    if (eligible.length === 0) {
      return { requeued: 0, lastSendAt: null };
    }

    const settings = await getSettings(db);
    const timezone = ctx.config.APP_TIMEZONE;
    const intervalMinutes = body.intervalMinutes ?? 5;
    const now = ctx.now();
    let plannedDate = nextSendWindowStart(settings, new Date(now.getTime() + 60_000), timezone);

    for (let i = 0; i < eligible.length; i++) {
      const row = eligible[i]!;

      if (i > 0) {
        plannedDate = nextScheduledDate(plannedDate, intervalMinutes, settings, timezone);
      }

      await db
        .update(scheduledMessages)
        .set({
          status: "pending",
          error: null,
          sendAt: plannedDate,
        })
        .where(eq(scheduledMessages.id, row.id));

      ctx.events.emit("scheduled.updated", { id: row.id, leadId: row.leadId });
    }

    ctx.events.emit("scheduled.updated", {});
    return { requeued: eligible.length, lastSendAt: plannedDate.toISOString() };
  });
}
