import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { enrollments, leads, scheduledMessages, sequences } from "../db/schema.js";
import { HttpError, idParam, parse } from "../http.js";

export const sequenceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullish(),
  active: z.boolean().default(true),
  trigger: z.enum(["manual", "lead_created", "no_reply"]).default("manual"),
  stopOnReply: z.boolean().default(true),
  steps: z
    .array(
      z.object({
        delayMinutes: z.number().int().min(0).max(60 * 24 * 90),
        mode: z.enum(["text", "ai"]),
        message: z.string().trim().min(1).max(4096),
      }),
    )
    .max(20),
});

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
    const body = parse(sequenceSchema.partial(), req.body);
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
    return db
      .select({
        id: scheduledMessages.id,
        body: scheduledMessages.body,
        sendAt: scheduledMessages.sendAt,
        status: scheduledMessages.status,
        error: scheduledMessages.error,
        leadId: leads.id,
        leadName: sql<string>`coalesce(${leads.name}, ${leads.waName}, ${leads.phone})`,
      })
      .from(scheduledMessages)
      .innerJoin(leads, eq(leads.id, scheduledMessages.leadId))
      .orderBy(desc(scheduledMessages.sendAt))
      .limit(200);
  });
}
