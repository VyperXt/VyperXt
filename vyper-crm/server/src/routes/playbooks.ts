import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { type Db } from "../db/client.js";
import { playbooks, type Playbook } from "../db/schema.js";
import { HttpError, idParam, parse } from "../http.js";

export interface PlaybookWithCount extends Playbook {
  leadCount: number;
}

export const createPlaybookSchema = z.object({
  name: z.string().trim().min(1, "O nome é obrigatório.").max(80, "Nome muito longo (máximo 80 caracteres)."),
  goal: z.string().optional().default(""),
  offer: z.string().optional().default(""),
  instructions: z.string().optional().default(""),
  handoffRules: z.string().optional().default(""),
  firstMessage: z.string().optional().default(""),
});

export const updatePlaybookSchema = z.object({
  name: z.string().trim().min(1, "O nome não pode ser vazio.").max(80, "Nome muito longo (máximo 80 caracteres).").optional(),
  goal: z.string().optional(),
  offer: z.string().optional(),
  instructions: z.string().optional(),
  handoffRules: z.string().optional(),
  firstMessage: z.string().optional(),
});

export async function getPlaybookWithCount(db: Db, id: number): Promise<PlaybookWithCount> {
  const [row] = await db
    .select({
      id: playbooks.id,
      name: playbooks.name,
      goal: playbooks.goal,
      offer: playbooks.offer,
      instructions: playbooks.instructions,
      handoffRules: playbooks.handoffRules,
      firstMessage: playbooks.firstMessage,
      createdAt: playbooks.createdAt,
      updatedAt: playbooks.updatedAt,
      leadCount: sql<number>`(select count(*)::int from leads where leads.playbook_id = ${playbooks.id})`,
    })
    .from(playbooks)
    .where(eq(playbooks.id, id));
  if (!row) throw new HttpError(404, "Roteiro não encontrado.");
  return row;
}

export async function playbookRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.get("/api/playbooks", async (): Promise<PlaybookWithCount[]> => {
    return db
      .select({
        id: playbooks.id,
        name: playbooks.name,
        goal: playbooks.goal,
        offer: playbooks.offer,
        instructions: playbooks.instructions,
        handoffRules: playbooks.handoffRules,
        firstMessage: playbooks.firstMessage,
        createdAt: playbooks.createdAt,
        updatedAt: playbooks.updatedAt,
        leadCount: sql<number>`(select count(*)::int from leads where leads.playbook_id = ${playbooks.id})`,
      })
      .from(playbooks)
      .orderBy(asc(playbooks.name));
  });

  app.post("/api/playbooks", async (req): Promise<PlaybookWithCount> => {
    const body = parse(createPlaybookSchema, req.body);
    const [row] = await db
      .insert(playbooks)
      .values({
        name: body.name,
        goal: body.goal ?? "",
        offer: body.offer ?? "",
        instructions: body.instructions ?? "",
        handoffRules: body.handoffRules ?? "",
        firstMessage: body.firstMessage ?? "",
      })
      .returning();
    return {
      ...row!,
      leadCount: 0,
    };
  });

  app.patch("/api/playbooks/:id", async (req): Promise<PlaybookWithCount> => {
    const id = idParam(req);
    const body = parse(updatePlaybookSchema, req.body);
    await getPlaybookWithCount(db, id);

    const values: Partial<typeof playbooks.$inferInsert> = { updatedAt: ctx.now() };
    if (body.name !== undefined) values.name = body.name;
    if (body.goal !== undefined) values.goal = body.goal;
    if (body.offer !== undefined) values.offer = body.offer;
    if (body.instructions !== undefined) values.instructions = body.instructions;
    if (body.handoffRules !== undefined) values.handoffRules = body.handoffRules;
    if (body.firstMessage !== undefined) values.firstMessage = body.firstMessage;

    await db.update(playbooks).set(values).where(eq(playbooks.id, id));
    return getPlaybookWithCount(db, id);
  });

  app.delete("/api/playbooks/:id", async (req): Promise<{ ok: boolean }> => {
    const id = idParam(req);
    await getPlaybookWithCount(db, id);
    await db.delete(playbooks).where(eq(playbooks.id, id));
    return { ok: true };
  });
}
