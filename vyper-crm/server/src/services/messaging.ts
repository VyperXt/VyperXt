import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { leads, messages, type Lead, type Message, type MessageAuthor } from "../db/schema.js";
import { getSettings } from "../settings.js";
import type { IncomingMessage, StatusUpdate } from "../whatsapp/types.js";
import { scheduleLeadAi } from "./ai-flows.js";
import { onOutboundSent, stopEnrollments } from "./automation.js";
import { addActivity, createLead, findLeadByPhone, getLead, HttpError } from "./leads.js";

export interface SendOptions {
  author: Exclude<MessageAuthor, "lead" | "phone">;
  userId?: number | null;
}

/** Envia uma mensagem de WhatsApp para o lead e registra no histórico. */
export async function sendToLead(ctx: AppContext, leadId: number, body: string, opts: SendOptions): Promise<Message> {
  const text = body.trim();
  if (!text) throw new HttpError(400, "A mensagem está vazia.");
  const lead = await getLead(ctx.db, leadId);
  if (!lead.phone) throw new HttpError(400, "Este lead não tem telefone de WhatsApp.");
  if (lead.optedOut && (opts.author === "bot" || opts.author === "automation")) {
    throw new HttpError(409, "O lead pediu para não receber mensagens automáticas.");
  }

  const [pending] = await ctx.db
    .insert(messages)
    .values({
      leadId,
      direction: "out",
      author: opts.author,
      body: text,
      status: "pending",
      userId: opts.userId ?? null,
      createdAt: ctx.now(),
    })
    .returning();

  let saved: Message;
  try {
    const { externalId } = await ctx.wa.sendText(lead.phone, text);
    // Pode ser que o webhook do próprio envio já tenha gravado este id; nesse caso não duplicamos
    const [updated] = await ctx.db
      .update(messages)
      .set({ status: "sent", externalId: externalId ?? null })
      .where(eq(messages.id, pending!.id))
      .returning()
      .catch(async () => ctx.db.update(messages).set({ status: "sent" }).where(eq(messages.id, pending!.id)).returning());
    saved = updated!;
  } catch (err) {
    const [failed] = await ctx.db
      .update(messages)
      .set({ status: "failed", error: (err as Error).message.slice(0, 500) })
      .where(eq(messages.id, pending!.id))
      .returning();
    ctx.events.emit("message.status", { message: failed! });
    throw new HttpError(502, `Falha ao enviar pelo WhatsApp: ${(err as Error).message}`);
  }

  await ctx.db.update(leads).set({ lastMessageAt: saved.createdAt, updatedAt: ctx.now() }).where(eq(leads.id, leadId));
  ctx.events.emit("message.sent", { message: saved, lead: { id: lead.id, name: lead.name, phone: lead.phone } });
  await onOutboundSent(ctx, lead, saved);
  return saved;
}

function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isOptOut(body: string, keywords: string[]): boolean {
  const text = normalizeText(body);
  return keywords.some((k) => normalizeText(k) === text);
}

/**
 * Ponto central de entrada: toda mensagem que chega do WhatsApp passa por aqui.
 * Cria o lead se for novo, salva a mensagem e dispara a IA (bot ou copiloto).
 */
export async function handleIncoming(ctx: AppContext, msg: IncomingMessage): Promise<Message | null> {
  const { db } = ctx;
  if (msg.externalId) {
    const [dup] = await db.select({ id: messages.id }).from(messages).where(eq(messages.externalId, msg.externalId));
    if (dup) return null;
  }

  let lead = await findLeadByPhone(db, msg.phone);
  if (!lead) {
    lead = await createLead(ctx, {
      phone: msg.phone,
      waName: msg.name ?? null,
      source: "whatsapp",
      // Se foi você quem puxou a conversa pelo celular, a IA não assume
      ...(msg.fromMe ? { chatMode: "human" as const } : {}),
    });
  } else if (msg.name && !msg.fromMe && msg.name !== lead.waName) {
    await db.update(leads).set({ waName: msg.name }).where(eq(leads.id, lead.id));
  }

  const createdAt = msg.timestamp && msg.timestamp <= ctx.now() ? msg.timestamp : ctx.now();

  if (msg.fromMe) {
    // Mensagem que VOCÊ mandou pelo celular/WhatsApp Web.
    // Se foi o eco de uma mensagem enviada pelo próprio CRM, só vinculamos o id.
    const recent = new Date(ctx.now().getTime() - 2 * 60_000);
    const [echo] = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.leadId, lead.id),
          eq(messages.direction, "out"),
          eq(messages.body, msg.body),
          gt(messages.createdAt, recent),
          or(isNull(messages.externalId), eq(messages.externalId, msg.externalId ?? "")),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (echo) {
      if (!echo.externalId && msg.externalId) {
        await db.update(messages).set({ externalId: msg.externalId }).where(eq(messages.id, echo.id));
      }
      return null;
    }
    const [saved] = await db
      .insert(messages)
      .values({
        leadId: lead.id,
        direction: "out",
        author: "phone",
        body: msg.body,
        mediaType: msg.mediaType,
        externalId: msg.externalId ?? null,
        status: "sent",
        createdAt,
      })
      .returning();
    const settings = await getSettings(db);
    const patch: Partial<typeof leads.$inferInsert> = { lastMessageAt: createdAt, updatedAt: ctx.now() };
    if (lead.chatMode === "bot" && settings.bot.pauseOnPhoneReply) {
      patch.chatMode = "human";
      await addActivity(db, lead.id, "chat_mode", "Você respondeu pelo celular — a IA pausou e virou copiloto");
    }
    await db.update(leads).set(patch).where(eq(leads.id, lead.id));
    ctx.events.emit("message.sent", { message: saved!, lead: { id: lead.id, name: lead.name, phone: lead.phone } });
    await onOutboundSent(ctx, lead, saved!);
    return saved!;
  }

  const [saved] = await db
    .insert(messages)
    .values({
      leadId: lead.id,
      direction: "in",
      author: "lead",
      body: msg.body,
      mediaType: msg.mediaType,
      externalId: msg.externalId ?? null,
      status: "received",
      createdAt,
    })
    .returning();

  await db
    .update(leads)
    .set({
      lastMessageAt: createdAt,
      lastInboundAt: createdAt,
      unreadCount: sql`${leads.unreadCount} + 1`,
      updatedAt: ctx.now(),
    })
    .where(eq(leads.id, lead.id));

  // Lead respondeu → para os follow-ups que dependem de "sem resposta"
  await stopEnrollments(ctx, lead.id, "lead respondeu", { onlyStopOnReply: true });

  const settings = await getSettings(db);
  const fresh = await getLead(db, lead.id);
  ctx.events.emit("message.received", { message: saved!, lead: fresh });

  if (!fresh.optedOut && isOptOut(msg.body, settings.automation.optOutKeywords)) {
    await handleOptOut(ctx, fresh, settings.automation.optOutReply);
    return saved!;
  }

  scheduleLeadAi(ctx, fresh, settings);
  return saved!;
}

async function handleOptOut(ctx: AppContext, lead: Lead, reply: string): Promise<void> {
  await ctx.db
    .update(leads)
    .set({ optedOut: true, chatMode: "human", updatedAt: ctx.now() })
    .where(eq(leads.id, lead.id));
  await stopEnrollments(ctx, lead.id, "lead pediu para sair");
  await addActivity(ctx.db, lead.id, "opted_out", "Lead pediu para não receber mensagens automáticas");
  ctx.events.emit("lead.opted_out", { lead: { ...lead, optedOut: true } });
  if (reply.trim()) {
    try {
      await sendToLead(ctx, lead.id, reply, { author: "agent" });
    } catch (err) {
      ctx.log.warn({ err: String(err), leadId: lead.id }, "não foi possível confirmar o opt-out");
    }
  }
}

export async function applyStatusUpdate(ctx: AppContext, update: StatusUpdate): Promise<void> {
  const order = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4, received: 0 } as const;
  const [msg] = await ctx.db.select().from(messages).where(eq(messages.externalId, update.externalId));
  if (!msg || msg.direction !== "out") return;
  if (update.status !== "failed" && order[update.status] <= order[msg.status]) return;
  const [saved] = await ctx.db
    .update(messages)
    .set({ status: update.status, error: update.error ?? msg.error })
    .where(eq(messages.id, msg.id))
    .returning();
  ctx.events.emit("message.status", { message: saved! });
}

export async function getConversation(ctx: AppContext, leadId: number, limit = 40): Promise<Message[]> {
  const rows = await ctx.db
    .select()
    .from(messages)
    .where(eq(messages.leadId, leadId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return rows.reverse();
}
