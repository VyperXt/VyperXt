import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").$type<"admin" | "agent">().notNull().default("agent"),
  // Sobe a cada troca de senha: invalida os logins (JWT) emitidos antes
  tokenVersion: integer("token_version").notNull().default(0),
  createdAt: createdAt(),
});

// Etapas do funil (colunas do kanban)
export const stages = pgTable("stages", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  color: text("color").notNull().default("#64748b"),
  kind: text("kind").$type<"open" | "won" | "lost">().notNull().default("open"),
});

export const playbooks = pgTable("playbooks", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  goal: text("goal").notNull().default(""),
  offer: text("offer").notNull().default(""),
  instructions: text("instructions").notNull().default(""),
  handoffRules: text("handoff_rules").notNull().default(""),
  firstMessage: text("first_message").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type ChatMode = "bot" | "human";
export type Temperature = "frio" | "morno" | "quente";

export const leads = pgTable(
  "leads",
  {
    id: serial("id").primaryKey(),
    name: text("name"),
    // Nome que aparece no perfil do WhatsApp (pushName)
    waName: text("wa_name"),
    // Apenas dígitos, com DDI (ex.: 5511999998888)
    phone: text("phone").unique(),
    // Id interno do WhatsApp (ex.: 123456789@lid) quando o contato chega sem o número de telefone
    waJid: text("wa_jid").unique(),
    email: text("email"),
    company: text("company"),
    source: text("source").notNull().default("manual"),
    stageId: integer("stage_id").references(() => stages.id, { onDelete: "set null" }),
    playbookId: integer("playbook_id").references(() => playbooks.id, { onDelete: "set null" }),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: "set null" }),
    value: doublePrecision("value"),
    score: integer("score").notNull().default(0),
    temperature: text("temperature").$type<Temperature>().notNull().default("frio"),
    interest: text("interest"),
    budget: text("budget"),
    timeline: text("timeline"),
    aiSummary: text("ai_summary"),
    notes: text("notes"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    // bot = IA responde sozinha; human = você conversa e a IA só sugere (copiloto)
    chatMode: text("chat_mode").$type<ChatMode>().notNull().default("bot"),
    unreadCount: integer("unread_count").notNull().default(0),
    optedOut: boolean("opted_out").notNull().default(false),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("leads_stage_idx").on(t.stageId),
    index("leads_last_message_idx").on(t.lastMessageAt),
    index("leads_playbook_idx").on(t.playbookId),
  ],
);

export type MessageAuthor = "lead" | "agent" | "bot" | "automation" | "phone";
export type MessageStatus = "received" | "pending" | "sent" | "delivered" | "read" | "failed";

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    direction: text("direction").$type<"in" | "out">().notNull(),
    author: text("author").$type<MessageAuthor>().notNull(),
    body: text("body").notNull(),
    mediaType: text("media_type").notNull().default("text"),
    externalId: text("external_id").unique(),
    status: text("status").$type<MessageStatus>().notNull().default("sent"),
    error: text("error"),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    // Respostas do bot: id da última mensagem do lead que a IA considerou ao escrever
    replyToId: integer("reply_to_id"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_lead_idx").on(t.leadId, t.createdAt)],
);

// Linha do tempo do lead (mudança de etapa, notas, ações da IA...)
export const activities = pgTable(
  "activities",
  {
    id: serial("id").primaryKey(),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    description: text("description").notNull(),
    data: jsonb("data"),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("activities_lead_idx").on(t.leadId, t.createdAt)],
);

// Sugestões do copiloto ("direcionador de conversa")
export const copilotInsights = pgTable(
  "copilot_insights",
  {
    id: serial("id").primaryKey(),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    lastMessageId: integer("last_message_id"),
    data: jsonb("data").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("copilot_lead_idx").on(t.leadId, t.createdAt)],
);

export type SequenceTrigger = "manual" | "lead_created" | "no_reply";
export interface SequenceStep {
  delayMinutes: number;
  // text = envia o texto (com variáveis); ai = a IA escreve a mensagem seguindo a instrução
  mode: "text" | "ai";
  message: string;
}

// Cadências de follow-up automático
export const sequences = pgTable("sequences", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  trigger: text("trigger").$type<SequenceTrigger>().notNull().default("manual"),
  stopOnReply: boolean("stop_on_reply").notNull().default(true),
  steps: jsonb("steps").$type<SequenceStep[]>().notNull().default([]),
  createdAt: createdAt(),
});

export const enrollments = pgTable(
  "enrollments",
  {
    id: serial("id").primaryKey(),
    sequenceId: integer("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull().default(0),
    status: text("status").$type<"active" | "completed" | "stopped">().notNull().default("active"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    stopReason: text("stop_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("enrollments_active_uq").on(t.sequenceId, t.leadId).where(sql`status = 'active'`),
    index("enrollments_due_idx").on(t.status, t.nextRunAt),
  ],
);

export const scheduledMessages = pgTable(
  "scheduled_messages",
  {
    id: serial("id").primaryKey(),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
    author: text("author").$type<"agent" | "automation">().notNull().default("agent"),
    status: text("status").$type<"pending" | "sent" | "failed" | "canceled">().notNull().default("pending"),
    error: text("error"),
    batchId: text("batch_id"),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("scheduled_due_idx").on(t.status, t.sendAt),
    index("scheduled_batch_idx").on(t.batchId),
  ],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

// Prospecção com IA: o que foi pedido à IA (nicho, região, porte, oferta)
export interface ProspectCriteria {
  niche: string;
  location: string;
  size: string;
  offer: string;
  quantity: number;
  extra: string;
  excludeWithWebsite?: boolean;
  requireWhatsapp?: boolean;
  requireInstagram?: boolean;
}

// Empresa encontrada na web, já tratada (telefone normalizado, duplicados marcados)
export interface ProspectResult {
  company: string;
  contactName: string;
  // Apenas dígitos, com DDI; "" quando o número achado não é válido
  phone: string;
  // Telefone como apareceu na fonte
  rawPhone: string;
  isMobile: boolean;
  email: string;
  website: string;
  instagram: string;
  bioLink?: string;
  address: string;
  city: string;
  size: string;
  fitReason: string;
  // Sugestão de primeira mensagem no WhatsApp
  approach: string;
  score: number;
  sources: string[];
  // Lead que já existia com o mesmo telefone
  duplicateLeadId: number | null;
  // Lead criado a partir deste resultado (importação)
  leadId: number | null;
  // Conferido no WhatsApp: "yes" tem, "no" não tem, null = não verificado.
  // Pesquisas antigas não têm o campo: quem lê trata ausente como null (results é jsonb, sem migração)
  whatsapp?: ProspectWhatsApp | null;
}

export type ProspectWhatsApp = "yes" | "no";

export type ProspectSearchStatus = "running" | "done" | "failed" | "canceled";

export const prospectSearches = pgTable(
  "prospect_searches",
  {
    id: serial("id").primaryKey(),
    status: text("status").$type<ProspectSearchStatus>().notNull().default("running"),
    criteria: jsonb("criteria").$type<ProspectCriteria>().notNull(),
    results: jsonb("results").$type<ProspectResult[]>().notNull().default([]),
    // Andamento enquanto a IA pesquisa (ex.: "12 buscas, 5 páginas lidas");
    // ao terminar, as observações da IA sobre a pesquisa (ex.: "poucos resultados na região")
    progress: text("progress"),
    error: text("error"),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  // Uma pesquisa por vez: o banco garante, mesmo com dois cliques ao mesmo tempo
  (t) => [uniqueIndex("prospect_searches_running_uq").on(t.status).where(sql`status = 'running'`)],
);

export type SampleKind = "site" | "image";
export type SampleStatus = "generating" | "ready" | "failed" | "sent" | "discarded";
export type SampleTrigger = "hot" | "handoff" | "manual";

// Amostras feitas pelo Claude para um lead quente: site demo (publicado no Netlify) ou arte (PNG)
export const leadSamples = pgTable(
  "lead_samples",
  {
    id: serial("id").primaryKey(),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    kind: text("kind").$type<SampleKind>().notNull(),
    status: text("status").$type<SampleStatus>().notNull().default("generating"),
    trigger: text("trigger").$type<SampleTrigger>().notNull(),
    // Pedido extra do vendedor ao refazer (ex.: "use tons de verde")
    instruction: text("instruction"),
    title: text("title"),
    // Mensagem sugerida para acompanhar a amostra no WhatsApp
    caption: text("caption"),
    // Observações do Claude para você (o que ficou genérico, o que conferir antes de enviar)
    notes: text("notes"),
    // HTML do site ou SVG da arte
    content: text("content"),
    // PNG da arte em base64 (só kind image)
    imagePng: text("image_png"),
    // Pasta do site publicado (ex.: "padaria-bom-pao-3f9a1c2b7d")
    slug: text("slug").unique(),
    publicUrl: text("public_url"),
    error: text("error"),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("lead_samples_lead_idx").on(t.leadId, t.createdAt),
    // Uma amostra sendo gerada por lead: o banco garante, mesmo com dois pedidos ao mesmo tempo
    uniqueIndex("lead_samples_generating_uq").on(t.leadId).where(sql`status = 'generating'`),
  ],
);

export type User = typeof users.$inferSelect;
export type Stage = typeof stages.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Sequence = typeof sequences.$inferSelect;
export type Enrollment = typeof enrollments.$inferSelect;
export type ProspectSearch = typeof prospectSearches.$inferSelect;
export type LeadSample = typeof leadSamples.$inferSelect;
export type Playbook = typeof playbooks.$inferSelect;
export type ScheduledMessage = typeof scheduledMessages.$inferSelect;
