import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { playbookAssistantSystem } from "../ai/prompts.js";
import { playbookAssistantSchema } from "../ai/schemas.js";
import type { AppContext } from "../context.js";
import { type Db } from "../db/client.js";
import { playbooks, type Playbook } from "../db/schema.js";
import { HttpError, idParam, parse } from "../http.js";
import { getSettings } from "../settings.js";

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

export const playbookAssistantRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1, "Mensagem não pode ser vazia.").max(6000, "Mensagem muito longa (máximo 6000 caracteres)."),
      }),
    )
    .min(1, "Envie pelo menos uma mensagem.")
    .max(40, "Máximo de 40 mensagens.")
    .refine((msgs) => msgs[msgs.length - 1]?.role === "user", {
      message: "A última mensagem deve ser do usuário.",
    }),
  draft: z
    .object({
      name: z.string().optional(),
      goal: z.string().optional(),
      offer: z.string().optional(),
      instructions: z.string().optional(),
      handoffRules: z.string().optional(),
      firstMessage: z.string().optional(),
    })
    .optional(),
  playbookId: z.number().int().optional(),
});

export interface PlaybookAssistantResponse {
  reply: string;
  draft: {
    name: string;
    goal: string;
    offer: string;
    instructions: string;
    handoffRules: string;
    firstMessage: string;
  };
  done: boolean;
  provider: "claude-code" | "ai";
}


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

  app.post("/api/playbooks/assistant", async (req): Promise<PlaybookAssistantResponse> => {
    const body = parse(playbookAssistantRequestSchema, req.body);

    const provider = ctx.claude ?? (ctx.ai.enabled ? ctx.ai : null);
    if (!provider) {
      throw new HttpError(
        503,
        "O assistente de roteiros usa o Claude Code: defina CLAUDE_CODE_ENABLED=true no .env e reinicie o CRM.",
      );
    }
    const providerKind: "claude-code" | "ai" = ctx.claude ? "claude-code" : "ai";

    const settings = await getSettings(db);
    const existing = await db.select({ name: playbooks.name }).from(playbooks);
    const existingNames = existing.map((p) => p.name);
    const system = playbookAssistantSystem(settings, existingNames);

    const currentDraft = {
      name: body.draft?.name ?? "",
      goal: body.draft?.goal ?? "",
      offer: body.draft?.offer ?? "",
      instructions: body.draft?.instructions ?? "",
      handoffRules: body.draft?.handoffRules ?? "",
      firstMessage: body.draft?.firstMessage ?? "",
    };

    const promptParts: string[] = [
      `Rascunho atual:\n${JSON.stringify(currentDraft, null, 2)}`,
    ];

    if (body.playbookId !== undefined) {
      promptParts.push(`Ajustando o roteiro existente #${body.playbookId}`);
    }

    const transcript = body.messages
      .map((m) => `${m.role === "user" ? "Usuário" : "Assistente"}: ${m.content}`)
      .join("\n\n");
    promptParts.push(`Conversa:\n${transcript}`);
    promptParts.push("Responda à última mensagem do usuário.");

    const prompt = promptParts.join("\n\n");

    const out = await provider.generate({
      task: "playbook_assistant",
      system,
      prompt,
      schema: playbookAssistantSchema,
      effort: "medium",
      timeoutMs: 150_000,
    });

    const cleanedDraft = {
      name: (out.draft?.name ?? "").trim().slice(0, 80),
      goal: (out.draft?.goal ?? "").trim(),
      offer: (out.draft?.offer ?? "").trim(),
      instructions: (out.draft?.instructions ?? "").trim(),
      handoffRules: (out.draft?.handoffRules ?? "").trim(),
      firstMessage: (out.draft?.firstMessage ?? "").trim(),
    };

    return {
      reply: (out.reply ?? "").trim(),
      draft: cleanedDraft,
      done: Boolean(out.done),
      provider: providerKind,
    };
  });
}
