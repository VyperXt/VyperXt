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
    email: text("email"),
    company: text("company"),
    source: text("source").notNull().default("manual"),
    stageId: integer("stage_id").references(() => stages.id, { onDelete: "set null" }),
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
  (t) => [index("leads_stage_idx").on(t.stageId), index("leads_last_message_idx").on(t.lastMessageAt)],
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
    status: text("status").$type<"pending" | "sent" | "failed" | "canceled">().notNull().default("pending"),
    error: text("error"),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("scheduled_due_idx").on(t.status, t.sendAt)],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

export type User = typeof users.$inferSelect;
export type Stage = typeof stages.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Sequence = typeof sequences.$inferSelect;
export type Enrollment = typeof enrollments.$inferSelect;
