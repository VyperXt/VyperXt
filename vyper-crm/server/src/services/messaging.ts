import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { leads, messages, type Lead, type Message, type MessageAuthor } from "../db/schema.js";
import { normalizePhone, phoneVariants } from "../lib/phone.js";
import { getSettings } from "../settings.js";
import {
  isNotOnWhatsAppError,
  mediaPlaceholder,
  NOT_ON_WHATSAPP_ERROR,
  WhatsAppNumberNotFoundError,
  type IncomingMessage,
  type OutgoingImage,
  type StatusUpdate,
} from "../whatsapp/types.js";
import { scheduleLeadAi } from "./ai-flows.js";
import { onOutboundSent, stopEnrollments } from "./automation.js";
import { addActivity, findOrCreateLeadByContact, getLead, HttpError } from "./leads.js";

/**
 * Classifica se um erro de envio é passageiro (provedor fora, timeout, conexão fechada, 5xx, etc.)
 * ou permanente (número sem WhatsApp, opt-out, mensagem vazia, lead sem telefone).
 */
export function isTransientSendError(err: unknown): boolean {
  if (!err) return false;
  if (isNotOnWhatsAppError(err)) return false;
  if (err instanceof WhatsAppNumberNotFoundError) return false;
  if (err instanceof HttpError) {
    if (err.statusCode === 400 || err.statusCode === 404 || err.statusCode === 409 || err.statusCode === 422) {
      return false;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes(NOT_ON_WHATSAPP_ERROR) || msg.includes("não tem WhatsApp")) return false;
  if (msg.includes("pediu para não receber mensagens") || msg.includes("optedOut")) return false;
  if (msg.includes("mensagem está vazia") || msg.includes("vazia")) return false;
  if (msg.includes("não tem telefone") || msg.includes("sem telefone")) return false;
  return true;
}

export interface SendOptions {
  author: Exclude<MessageAuthor, "lead" | "phone">;
  userId?: number | null;
  /** Mensagem do lead que esta resposta responde (usado pelo bot) */
  replyToId?: number | null;
  /** Se true, falhas passageiras não deixam mensagem 'failed' gravada na conversa */
  deleteOnTransientError?: boolean;
}

/** Para onde mandar: o telefone ou, para contatos que só têm LID, o próprio LID. */
export function whatsAppTarget(lead: Pick<Lead, "phone" | "waJid">): string | null {
  return lead.phone ?? lead.waJid ?? null;
}

/** Envia uma mensagem de WhatsApp para o lead e registra no histórico. */
export async function sendToLead(ctx: AppContext, leadId: number, body: string, opts: SendOptions): Promise<Message> {
  const text = body.trim();
  if (!text) throw new HttpError(400, "A mensagem está vazia.");
  return deliverToLead(ctx, leadId, text, "text", (to) => ctx.wa.sendText(to, text), opts);
}

/**
 * Envia uma imagem (ex.: amostra em PNG) com legenda opcional e registra no histórico.
 * O texto gravado segue o formato das imagens recebidas ("[imagem] legenda"), o que também
 * permite reconhecer o eco do próprio envio que volta pelo webhook.
 */
export async function sendImageToLead(
  ctx: AppContext,
  leadId: number,
  image: OutgoingImage,
  opts: SendOptions,
): Promise<Message> {
  const sendImage = ctx.wa.sendImage?.bind(ctx.wa);
  if (!sendImage) throw new HttpError(400, "Este provedor de WhatsApp não envia imagens pelo CRM.");
  const caption = image.caption?.trim();
  const body = caption ? `${mediaPlaceholder("image")} ${caption}` : mediaPlaceholder("image");
  return deliverToLead(ctx, leadId, body, "image", (to) => sendImage(to, { ...image, caption: caption || undefined }), opts);
}

async function deliverToLead(
  ctx: AppContext,
  leadId: number,
  text: string,
  mediaType: string,
  send: (to: string) => Promise<{ externalId?: string }>,
  opts: SendOptions,
): Promise<Message> {
  const lead = await getLead(ctx.db, leadId);
  const to = whatsAppTarget(lead);
  if (!to) throw new HttpError(400, "Este lead não tem telefone de WhatsApp.");
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
      mediaType,
      status: "pending",
      userId: opts.userId ?? null,
      replyToId: opts.replyToId ?? null,
      createdAt: ctx.now(),
    })
    .returning();

  let saved: Message;
  try {
    const { externalId } = await send(to);
    // Pode ser que o webhook do próprio envio já tenha gravado este id; nesse caso não duplicamos
    const [updated] = await ctx.db
      .update(messages)
      .set({ status: "sent", externalId: externalId ?? null })
      .where(eq(messages.id, pending!.id))
      .returning()
      .catch(async () => ctx.db.update(messages).set({ status: "sent" }).where(eq(messages.id, pending!.id)).returning());
    saved = updated!;
  } catch (err) {
    if (opts.deleteOnTransientError && isTransientSendError(err)) {
      await ctx.db.delete(messages).where(eq(messages.id, pending!.id));
      throw err;
    }

    // Número sem WhatsApp: texto amigável na conversa (o painel mostra um aviso), a resposta crua só no log
    const notOnWhatsApp = isNotOnWhatsAppError(err);
    if (notOnWhatsApp) {
      ctx.log.warn({ leadId, detail: (err as { detail?: string }).detail }, "envio recusado: número sem WhatsApp");
    }
    const [failed] = await ctx.db
      .update(messages)
      .set({ status: "failed", error: notOnWhatsApp ? NOT_ON_WHATSAPP_ERROR : (err as Error).message.slice(0, 500) })
      .where(eq(messages.id, pending!.id))
      .returning();
    ctx.events.emit("message.status", { message: failed! });
    if (notOnWhatsApp) {
      throw new HttpError(422, `${NOT_ON_WHATSAPP_ERROR} Confira o número na ficha do lead.`);
    }
    throw new HttpError(502, `Falha ao enviar pelo WhatsApp: ${(err as Error).message}`);
  }

  // GREATEST: se o lead escreveu enquanto o envio acontecia, lastMessageAt não volta para trás
  // (senão ele sairia de "Aguardando você" mesmo esperando resposta)
  await ctx.db
    .update(leads)
    .set({ lastMessageAt: laterOf(leads.lastMessageAt, saved.createdAt), updatedAt: ctx.now() })
    .where(eq(leads.id, leadId));
  ctx.events.emit("message.sent", { message: saved, lead: { id: lead.id, name: lead.name, phone: lead.phone } });
  await onOutboundSent(ctx, lead, saved);
  return saved;
}

/** greatest(coluna, data) no SQL. A data vai como texto ISO (o driver não serializa Date dentro de sql``). */
function laterOf(column: typeof leads.lastMessageAt, date: Date) {
  return sql`greatest(${column}, ${date.toISOString()}::timestamptz)`;
}

/**
 * Hora de uma mensagem que chegou: a do WhatsApp (nunca no futuro), mas sempre depois da última
 * mensagem da conversa. Assim webhooks atrasados (CRM fora do ar, reenvio) mantêm o horário real
 * sem bagunçar a ordem que o bot e a IA leem.
 */
async function arrivalTime(ctx: AppContext, leadId: number, sentAt: Date | undefined): Promise<Date> {
  const now = ctx.now();
  let at = sentAt && sentAt.getTime() < now.getTime() ? sentAt : now;
  const [latest] = await ctx.db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.leadId, leadId))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (latest && latest.createdAt.getTime() >= at.getTime()) at = new Date(latest.createdAt.getTime() + 1);
  return at;
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

export function isHandoffNotificationNumber(
  phone: string | null | undefined,
  handoffPhone: string | null | undefined,
): boolean {
  if (!phone || !handoffPhone?.trim()) return false;
  const notifyNorm = normalizePhone(handoffPhone);
  if (!notifyNorm) return false;
  const variants = phoneVariants(notifyNorm);
  const msgNorm = normalizePhone(phone);
  return variants.includes(phone) || (msgNorm ? variants.includes(msgNorm) : false);
}

/**
 * Ponto central de entrada: toda mensagem que chega do WhatsApp passa por aqui.
 * Cria o lead se for novo, salva a mensagem e dispara a IA (bot ou copiloto).
 */
export async function handleIncoming(ctx: AppContext, msg: IncomingMessage): Promise<Message | null> {
  const { db } = ctx;
  const settings = await getSettings(db);
  if (isHandoffNotificationNumber(msg.phone, settings.notify?.handoffPhone)) {
    return null;
  }

  if (msg.externalId) {
    const [dup] = await db.select({ id: messages.id }).from(messages).where(eq(messages.externalId, msg.externalId));
    if (dup) return null;
  }

  // msg.phone já vem normalizado pelo parser do provedor (com DDI); msg.jid é o LID, quando houver
  const { lead, created } = await findOrCreateLeadByContact(
    ctx,
    { phone: msg.phone, jid: msg.jid },
    {
      waName: msg.name ?? null,
      source: "whatsapp",
      // Se foi você quem puxou a conversa pelo celular, a IA não assume
      ...(msg.fromMe ? { chatMode: "human" as const } : {}),
    },
  );
  if (!created && msg.name && !msg.fromMe && msg.name !== lead.waName) {
    await db.update(leads).set({ waName: msg.name }).where(eq(leads.id, lead.id));
  }

  const createdAt = await arrivalTime(ctx, lead.id, msg.timestamp);

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
      .onConflictDoNothing({ target: messages.externalId })
      .returning();
    if (!saved) return null; // o mesmo webhook chegou duas vezes ao mesmo tempo
    const pause = lead.chatMode === "bot" && settings.bot.pauseOnPhoneReply;
    await db
      .update(leads)
      .set({
        lastMessageAt: laterOf(leads.lastMessageAt, createdAt),
        updatedAt: ctx.now(),
        ...(pause ? { chatMode: "human" as const } : {}),
      })
      .where(eq(leads.id, lead.id));
    if (pause) await addActivity(db, lead.id, "chat_mode", "Você respondeu pelo celular — a IA pausou e virou copiloto");
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
    .onConflictDoNothing({ target: messages.externalId })
    .returning();
  if (!saved) return null; // o mesmo webhook chegou duas vezes ao mesmo tempo

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
    .orderBy(desc(messages.id))
    .limit(limit);
  return rows.reverse();
}
