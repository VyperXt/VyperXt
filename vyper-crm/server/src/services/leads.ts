import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { isInsecureAdminPassword } from "../config.js";
import type { AppContext } from "../context.js";
import type { Db } from "../db/client.js";
import {
  activities,
  copilotInsights,
  enrollments,
  leads,
  messages,
  scheduledMessages,
  sequences,
  stages,
  users,
  type Lead,
  type Stage,
} from "../db/schema.js";
import { normalizePhone, phoneVariants } from "../lib/phone.js";
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
  opts: { userId?: number | null; waJid?: string | null },
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
      waJid: opts.waJid ?? null,
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
    .onConflictDoNothing() // mesmo telefone ou mesmo LID
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

/** Contato do WhatsApp: telefone (já normalizado) e/ou LID ("123...@lid"). */
export interface WhatsAppContact {
  phone: string | null;
  jid?: string | null;
}

/** Versões antigas do CRM gravavam o LID (só os dígitos) no campo telefone. */
const lidDigits = (jid: string) => jid.split("@")[0]!;

async function findLegacyLidLead(db: Db, jid: string): Promise<Lead | undefined> {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.phone, lidDigits(jid)), isNull(leads.waJid)));
  return lead;
}

async function findLeadByContact(db: Db, contact: WhatsAppContact): Promise<Lead | undefined> {
  if (contact.phone) {
    const byPhone = await findLeadByPhone(db, contact.phone);
    if (byPhone) return byPhone;
  }
  if (!contact.jid) return undefined;
  return (await findLeadByJid(db, contact.jid)) ?? (await findLegacyLidLead(db, contact.jid));
}

/** Atualiza o lead; se outro lead já tiver o mesmo telefone/LID, só registra e segue. */
async function tryUpdate(ctx: AppContext, lead: Lead, values: Partial<typeof leads.$inferInsert>): Promise<Lead> {
  try {
    const [updated] = await ctx.db.update(leads).set(values).where(eq(leads.id, lead.id)).returning();
    return updated ?? lead;
  } catch (err) {
    ctx.log.warn({ err: String(err), leadId: lead.id }, "não foi possível completar o telefone/LID do lead");
    return lead;
  }
}

/**
 * Completa o telefone/LID que faltava no lead. Se o LID estava num outro lead que só tinha o LID
 * (o contato escreveu antes sem mostrar o número), os dois viram um só.
 */
async function linkContact(ctx: AppContext, lead: Lead, contact: WhatsAppContact): Promise<Lead> {
  // Lead antigo com o LID no lugar do telefone: o LID vai para wa_jid e o telefone fica com o número real
  if (contact.jid && !lead.waJid && lead.phone === lidDigits(contact.jid)) {
    return tryUpdate(ctx, lead, { waJid: contact.jid, phone: contact.phone ?? null });
  }
  let current = lead;
  if (contact.phone && !current.phone) current = await tryUpdate(ctx, current, { phone: contact.phone });
  if (contact.jid && !current.waJid) {
    const other = (await findLeadByJid(ctx.db, contact.jid)) ?? (await findLegacyLidLead(ctx.db, contact.jid));
    const lidOnly = other && other.id !== current.id && (!other.phone || other.phone === lidDigits(contact.jid));
    current = lidOnly
      ? await mergeLeadInto(ctx, current, other, { waJid: contact.jid })
      : await tryUpdate(ctx, current, { waJid: contact.jid });
  }
  return current;
}

const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * Junta dois leads do mesmo contato: conversa, linha do tempo, análises do copiloto, agendamentos e
 * automações passam para `keep`; campos vazios de `keep` são completados com os de `drop`, que é apagado.
 */
export async function mergeLeadInto(
  ctx: AppContext,
  keep: Lead,
  drop: Lead,
  extra: Partial<typeof leads.$inferInsert> = {},
): Promise<Lead> {
  const merged = await ctx.db.transaction(async (tx) => {
    // Trava o lead que vai sumir: mensagens chegando para ele ao mesmo tempo esperam o fim da junção
    const [locked] = await tx.select().from(leads).where(eq(leads.id, drop.id)).for("update");
    if (!locked) return undefined;
    await tx.update(messages).set({ leadId: keep.id }).where(eq(messages.leadId, drop.id));
    await tx.update(activities).set({ leadId: keep.id }).where(eq(activities.leadId, drop.id));
    await tx.update(copilotInsights).set({ leadId: keep.id }).where(eq(copilotInsights.leadId, drop.id));
    await tx.update(scheduledMessages).set({ leadId: keep.id }).where(eq(scheduledMessages.leadId, drop.id));
    // Automações ativas do lead duplicado param (o lead que fica segue com as dele)
    await tx
      .update(enrollments)
      .set({ status: "stopped", stopReason: "lead unificado", nextRunAt: null, updatedAt: ctx.now() })
      .where(and(eq(enrollments.leadId, drop.id), eq(enrollments.status, "active")));
    await tx.update(enrollments).set({ leadId: keep.id }).where(eq(enrollments.leadId, drop.id));
    await tx.delete(leads).where(eq(leads.id, drop.id));
    const [row] = await tx
      .update(leads)
      .set({
        name: keep.name ?? locked.name,
        waName: keep.waName ?? locked.waName,
        email: keep.email ?? locked.email,
        company: keep.company ?? locked.company,
        interest: keep.interest ?? locked.interest,
        budget: keep.budget ?? locked.budget,
        timeline: keep.timeline ?? locked.timeline,
        aiSummary: keep.aiSummary ?? locked.aiSummary,
        notes: keep.notes ?? locked.notes,
        value: keep.value ?? locked.value,
        tags: [...new Set([...keep.tags, ...locked.tags])],
        unreadCount: sql`${leads.unreadCount} + ${locked.unreadCount}`,
        optedOut: keep.optedOut || locked.optedOut,
        lastMessageAt: later(keep.lastMessageAt, locked.lastMessageAt),
        lastInboundAt: later(keep.lastInboundAt, locked.lastInboundAt),
        updatedAt: ctx.now(),
        ...extra,
      })
      .where(eq(leads.id, keep.id))
      .returning();
    return row;
  });
  if (!merged) return tryUpdate(ctx, keep, extra);
  await addActivity(ctx.db, keep.id, "merged", `Unificado com o lead #${drop.id} (mesmo contato do WhatsApp)`);
  ctx.events.emit("lead.deleted", { leadId: drop.id });
  ctx.events.emit("lead.updated", { lead: merged });
  return merged;
}

/**
 * Usado pelas mensagens do WhatsApp: acha o lead pelo telefone (ou pelo LID) ou cria.
 * Seguro quando chegam várias mensagens de um contato novo ao mesmo tempo.
 */
export async function findOrCreateLeadByContact(
  ctx: AppContext,
  contact: WhatsAppContact,
  input: Omit<NewLeadInput, "phone">,
): Promise<{ lead: Lead; created: boolean }> {
  if (!contact.phone && !contact.jid) throw new Error("Contato sem telefone e sem LID");
  const found = await findLeadByContact(ctx.db, contact);
  if (found) return { lead: await linkContact(ctx, found, contact), created: false };
  const lead = await insertLead(ctx, input, contact.phone, { waJid: contact.jid ?? null });
  if (lead) return { lead, created: true };
  const again = await findLeadByContact(ctx.db, contact);
  if (!again) throw new Error(`Conflito ao criar lead para ${contact.phone ?? contact.jid}`);
  return { lead: await linkContact(ctx, again, contact), created: false };
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
      const dup = await findLeadByPhone(ctx.db, phone, { excludeId: id });
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

export async function findLeadByPhone(db: Db, phone: string, opts: { excludeId?: number } = {}): Promise<Lead | undefined> {
  const variants = phoneVariants(phone);
  const rows = await db.select().from(leads).where(inArray(leads.phone, variants));
  const candidates = rows.filter((l) => l.id !== opts.excludeId);
  // Se o mesmo contato existe com e sem o 9 (versões antigas criavam os dois), a conversa continua
  // no lead em que o contato escreveu por último; empate → o número exatamente igual, depois o mais antigo.
  const inbound = (l: Lead) => l.lastInboundAt?.getTime() ?? -1;
  return candidates.sort(
    (a, b) => inbound(b) - inbound(a) || Number(b.phone === phone) - Number(a.phone === phone) || a.id - b.id,
  )[0];
}

export async function findLeadByJid(db: Db, jid: string): Promise<Lead | undefined> {
  const [lead] = await db.select().from(leads).where(eq(leads.waJid, jid));
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
