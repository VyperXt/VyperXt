import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { isInsecureAdminPassword } from "../config.js";
import type { AppContext } from "../context.js";
import type { Db } from "../db/client.js";
import { activities, leads, sequences, stages, users, type Lead, type Stage } from "../db/schema.js";
import { normalizePhone } from "../lib/phone.js";
import { hashPassword } from "../lib/password.js";
import { getSettings } from "../settings.js";
import { onLeadCreated } from "./automation.js";

export const DEFAULT_STAGES: Array<Pick<Stage, "name" | "color" | "kind">> = [
  { name: "Novo", color: "#3b82f6", kind: "open" },
  { name: "Qualificando", color: "#8b5cf6", kind: "open" },
  { name: "Proposta", color: "#f59e0b", kind: "open" },
  { name: "Negociação", color: "#f97316", kind: "open" },
  { name: "Ganho", color: "#22c55e", kind: "won" },
  { name: "Perdido", color: "#ef4444", kind: "lost" },
];

/** Cria etapas padrão, o usuário admin e exemplos de automação na primeira execução. */
export async function ensureDefaultData(ctx: AppContext): Promise<void> {
  const { db, config } = ctx;
  const [stageCount] = await db.select({ n: sql<number>`count(*)::int` }).from(stages);
  if (!stageCount?.n) {
    await db.insert(stages).values(DEFAULT_STAGES.map((s, i) => ({ ...s, position: i })));
  }
  const [userCount] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  if (!userCount?.n) {
    if (config.NODE_ENV === "production" && isInsecureAdminPassword(config.ADMIN_PASSWORD)) {
      throw new Error(
        "ADMIN_PASSWORD está com o valor de exemplo ou tem menos de 8 caracteres. Defina uma senha forte no .env antes da primeira execução.",
      );
    }
    await db.insert(users).values({
      name: config.ADMIN_NAME,
      email: config.ADMIN_EMAIL.toLowerCase(),
      passwordHash: await hashPassword(config.ADMIN_PASSWORD),
      role: "admin",
    });
    ctx.log.info({ email: config.ADMIN_EMAIL }, "usuário administrador criado");
  }
  const [seqCount] = await db.select({ n: sql<number>`count(*)::int` }).from(sequences);
  if (!seqCount?.n) {
    await db.insert(sequences).values([
      {
        name: "Reengajar quem parou de responder",
        description: "Quando o lead não responde depois da nossa última mensagem, a IA manda follow-ups.",
        trigger: "no_reply",
        active: false,
        steps: [
          { delayMinutes: 60 * 24, mode: "ai", message: "Retomar a conversa de forma leve, lembrando do interesse do lead." },
          { delayMinutes: 60 * 24 * 3, mode: "ai", message: "Último contato: perguntar se ainda faz sentido conversar, sem pressão." },
        ],
      },
      {
        name: "Boas-vindas (formulário/site)",
        description: "Para leads que chegam pelo formulário ou n8n: apresenta a empresa e puxa conversa.",
        trigger: "lead_created",
        active: false,
        steps: [
          {
            delayMinutes: 0,
            mode: "text",
            message: "Oi {{primeiro_nome}}, tudo bem? Aqui é da {{empresa_nome}}! Vi que você se interessou por {{interesse}}. Posso te ajudar com alguma dúvida?",
          },
        ],
      },
    ]);
  }
}

export async function getDefaultStageId(db: Db): Promise<number | null> {
  const [first] = await db.select().from(stages).where(eq(stages.kind, "open")).orderBy(asc(stages.position)).limit(1);
  return first?.id ?? null;
}

export function displayName(lead: Pick<Lead, "name" | "waName" | "phone" | "email">): string {
  return lead.name || lead.waName || lead.phone || lead.email || "Sem nome";
}

export async function addActivity(
  db: Db,
  leadId: number,
  type: string,
  description: string,
  data?: Record<string, unknown>,
  userId?: number | null,
): Promise<void> {
  await db.insert(activities).values({ leadId, type, description, data: data ?? null, userId: userId ?? null });
}

export const leadInputSchema = z.object({
  name: z.string().trim().max(200).nullish(),
  phone: z.string().trim().max(40).nullish(),
  email: z.string().trim().max(200).nullish(),
  company: z.string().trim().max(200).nullish(),
  source: z.string().trim().max(50).optional(),
  stageId: z.number().int().nullish(),
  ownerId: z.number().int().nullish(),
  value: z.number().nullish(),
  interest: z.string().max(500).nullish(),
  budget: z.string().max(200).nullish(),
  timeline: z.string().max(200).nullish(),
  notes: z.string().max(5000).nullish(),
  tags: z.array(z.string().max(50)).max(30).optional(),
  chatMode: z.enum(["bot", "human"]).optional(),
  temperature: z.enum(["frio", "morno", "quente"]).optional(),
  score: z.number().int().min(0).max(100).optional(),
  optedOut: z.boolean().optional(),
});
export type LeadInput = z.infer<typeof leadInputSchema>;

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function clean(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** Etapa e responsável precisam existir (senão o banco recusaria com erro 500). */
async function assertReferences(db: Db, refs: { stageId?: number | null; ownerId?: number | null }): Promise<void> {
  if (refs.stageId != null) {
    const [st] = await db.select({ id: stages.id }).from(stages).where(eq(stages.id, refs.stageId));
    if (!st) throw new HttpError(400, `A etapa #${refs.stageId} não existe.`);
  }
  if (refs.ownerId != null) {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, refs.ownerId));
    if (!u) throw new HttpError(400, `O usuário #${refs.ownerId} não existe.`);
  }
}

function parsePhoneInput(value: string | null | undefined): string | null {
  if (!value) return null;
  const phone = normalizePhone(value);
  if (!phone) throw new HttpError(400, "Telefone inválido. Use DDD + número (ex.: 11999998888).");
  return phone;
}

type NewLeadInput = LeadInput & { waName?: string | null };

/**
 * Insere o lead de forma atômica: se outro processo criou o mesmo telefone ao mesmo tempo,
 * devolve null em vez de estourar a restrição única. Efeitos colaterais só para quem inseriu.
 */
async function insertLead(
  ctx: AppContext,
  input: NewLeadInput,
  phone: string | null,
  opts: { userId?: number | null },
): Promise<Lead | null> {
  await assertReferences(ctx.db, { stageId: input.stageId, ownerId: input.ownerId });
  const settings = await getSettings(ctx.db);
  const stageId = input.stageId ?? (await getDefaultStageId(ctx.db));
  const [lead] = await ctx.db
    .insert(leads)
    .values({
      name: clean(input.name),
      waName: clean(input.waName),
      phone,
      email: clean(input.email)?.toLowerCase() ?? null,
      company: clean(input.company),
      source: input.source || "manual",
      stageId,
      ownerId: input.ownerId ?? null,
      value: input.value ?? null,
      interest: clean(input.interest),
      budget: clean(input.budget),
      timeline: clean(input.timeline),
      notes: clean(input.notes),
      tags: input.tags ?? [],
      chatMode: input.chatMode ?? settings.bot.defaultMode,
      temperature: input.temperature ?? "frio",
      score: input.score ?? 0,
    })
    .onConflictDoNothing({ target: leads.phone })
    .returning();
  if (!lead) return null;
  await addActivity(ctx.db, lead.id, "created", `Lead criado (origem: ${lead.source})`, undefined, opts.userId);
  ctx.events.emit("lead.created", { lead });
  await onLeadCreated(ctx, lead);
  return lead;
}

export async function createLead(ctx: AppContext, input: NewLeadInput, opts: { userId?: number | null } = {}): Promise<Lead> {
  const phone = parsePhoneInput(input.phone);
  const duplicate = async () => {
    const existing = phone ? await findLeadByPhone(ctx.db, phone) : undefined;
    return new HttpError(409, `Já existe um lead com este telefone (#${existing?.id ?? "?"}).`);
  };
  if (phone && (await findLeadByPhone(ctx.db, phone))) throw await duplicate();
  const lead = await insertLead(ctx, input, phone, opts);
  if (!lead) throw await duplicate();
  return lead;
}

/**
 * Usado pelas mensagens do WhatsApp: acha o lead pelo telefone (já normalizado) ou cria.
 * Seguro quando chegam várias mensagens de um número novo ao mesmo tempo.
 */
export async function findOrCreateLeadByPhone(
  ctx: AppContext,
  phone: string,
  input: Omit<NewLeadInput, "phone">,
): Promise<{ lead: Lead; created: boolean }> {
  const found = await findLeadByPhone(ctx.db, phone);
  if (found) return { lead: found, created: false };
  const lead = await insertLead(ctx, input, phone, {});
  if (lead) return { lead, created: true };
  const again = await findLeadByPhone(ctx.db, phone);
  if (!again) throw new Error(`Conflito ao criar lead para ${phone}`);
  return { lead: again, created: false };
}

export async function getLead(db: Db, id: number): Promise<Lead> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  if (!lead) throw new HttpError(404, "Lead não encontrado.");
  return lead;
}

export async function updateLead(
  ctx: AppContext,
  id: number,
  patch: LeadInput,
  opts: { userId?: number | null; reason?: string } = {},
): Promise<Lead> {
  const before = await getLead(ctx.db, id);
  await assertReferences(ctx.db, { stageId: patch.stageId, ownerId: patch.ownerId });
  const values: Partial<typeof leads.$inferInsert> = { updatedAt: ctx.now() };
  if (patch.name !== undefined) values.name = clean(patch.name);
  if (patch.phone !== undefined) {
    const phone = parsePhoneInput(patch.phone);
    if (phone && phone !== before.phone) {
      const [dup] = await ctx.db.select({ id: leads.id }).from(leads).where(eq(leads.phone, phone));
      if (dup) throw new HttpError(409, `Já existe um lead com este telefone (#${dup.id}).`);
    }
    values.phone = phone;
  }
  if (patch.email !== undefined) values.email = clean(patch.email)?.toLowerCase() ?? null;
  if (patch.company !== undefined) values.company = clean(patch.company);
  if (patch.source !== undefined) values.source = patch.source;
  if (patch.stageId !== undefined) values.stageId = patch.stageId;
  if (patch.ownerId !== undefined) values.ownerId = patch.ownerId;
  if (patch.value !== undefined) values.value = patch.value;
  if (patch.interest !== undefined) values.interest = clean(patch.interest);
  if (patch.budget !== undefined) values.budget = clean(patch.budget);
  if (patch.timeline !== undefined) values.timeline = clean(patch.timeline);
  if (patch.notes !== undefined) values.notes = clean(patch.notes);
  if (patch.tags !== undefined) values.tags = [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))];
  if (patch.chatMode !== undefined) values.chatMode = patch.chatMode;
  if (patch.temperature !== undefined) values.temperature = patch.temperature;
  if (patch.score !== undefined) values.score = patch.score;
  if (patch.optedOut !== undefined) values.optedOut = patch.optedOut;

  const [lead] = await ctx.db.update(leads).set(values).where(eq(leads.id, id)).returning();

  if (patch.stageId !== undefined && patch.stageId !== before.stageId) {
    const all = await ctx.db.select().from(stages);
    const from = all.find((s) => s.id === before.stageId);
    const to = all.find((s) => s.id === patch.stageId);
    await addActivity(
      ctx.db,
      id,
      "stage_changed",
      `Etapa: ${from?.name ?? "—"} → ${to?.name ?? "—"}${opts.reason ? ` (${opts.reason})` : ""}`,
      { from: from?.id ?? null, to: to?.id ?? null },
      opts.userId,
    );
    ctx.events.emit("lead.stage_changed", {
      lead: lead!,
      from: from ? { id: from.id, name: from.name } : null,
      to: to ? { id: to.id, name: to.name, kind: to.kind } : null,
    });
  }
  if (patch.chatMode !== undefined && patch.chatMode !== before.chatMode) {
    await addActivity(
      ctx.db,
      id,
      "chat_mode",
      patch.chatMode === "bot" ? "IA assumiu a conversa" : "Conversa passou para atendimento humano",
      undefined,
      opts.userId,
    );
  }
  ctx.events.emit("lead.updated", { lead: lead! });
  return lead!;
}

export async function findLeadByPhone(db: Db, phone: string): Promise<Lead | undefined> {
  const [lead] = await db.select().from(leads).where(eq(leads.phone, phone));
  return lead;
}

export async function listStages(db: Db): Promise<Stage[]> {
  return db.select().from(stages).orderBy(asc(stages.position), asc(stages.id));
}

export async function stageOf(db: Db, lead: Lead): Promise<Stage | undefined> {
  if (!lead.stageId) return undefined;
  const [stage] = await db.select().from(stages).where(and(eq(stages.id, lead.stageId)));
  return stage;
}
