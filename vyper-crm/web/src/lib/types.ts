export type Temperature = "frio" | "morno" | "quente";
export type ChatMode = "bot" | "human";

export interface User {
  id: number;
  name: string;
  email: string;
  role: "admin" | "agent";
}

export interface Stage {
  id: number;
  name: string;
  position: number;
  color: string;
  kind: "open" | "won" | "lost";
}

export interface Lead {
  id: number;
  name: string | null;
  waName: string | null;
  phone: string | null;
  /** Id interno do WhatsApp (LID) quando o contato não mostra o número */
  waJid: string | null;
  email: string | null;
  company: string | null;
  source: string;
  stageId: number | null;
  ownerId: number | null;
  value: number | null;
  score: number;
  temperature: Temperature;
  interest: string | null;
  budget: string | null;
  timeline: string | null;
  aiSummary: string | null;
  notes: string | null;
  tags: string[];
  chatMode: ChatMode;
  unreadCount: number;
  optedOut: boolean;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: number;
  leadId: number;
  direction: "in" | "out";
  author: "lead" | "agent" | "bot" | "automation" | "phone";
  body: string;
  mediaType: string;
  status: "received" | "pending" | "sent" | "delivered" | "read" | "failed";
  error: string | null;
  createdAt: string;
}

export interface CopilotData {
  summary: string;
  intent: string;
  sentiment: "positivo" | "neutro" | "negativo";
  buyingStage: string;
  objections: string[];
  buyingSignals: string[];
  nextBestAction: string;
  paths: Array<{ title: string; strategy: string; message: string }>;
  avoid: string[];
  missingInfo: string[];
}

export interface CopilotResponse {
  insight: { id: number; leadId: number; lastMessageId: number | null; createdAt: string; data: CopilotData } | null;
  stale: boolean;
  aiEnabled: boolean;
}

export interface Activity {
  id: number;
  type: string;
  description: string;
  createdAt: string;
  userName: string | null;
}

export interface SequenceStep {
  delayMinutes: number;
  mode: "text" | "ai";
  message: string;
}

export interface Sequence {
  id: number;
  name: string;
  description: string | null;
  active: boolean;
  trigger: "manual" | "lead_created" | "no_reply";
  stopOnReply: boolean;
  steps: SequenceStep[];
  stats?: Record<string, number>;
}

export interface LeadDetail {
  lead: Lead;
  activities: Activity[];
  enrollments: Array<{
    id: number;
    status: "active" | "completed" | "stopped";
    stepIndex: number;
    nextRunAt: string | null;
    stopReason: string | null;
    sequenceId: number;
    sequenceName: string;
    totalSteps: number;
  }>;
  scheduled: Array<{ id: number; body: string; sendAt: string; status: string; error: string | null }>;
}

export interface Conversation {
  lead: Lead;
  lastMessage: Pick<Message, "body" | "direction" | "author" | "status" | "createdAt"> | null;
}

export interface Settings {
  business: { name: string; description: string; products: string; faq: string; tone: string; rules: string };
  bot: {
    enabled: boolean;
    defaultMode: ChatMode;
    replyDelaySeconds: number;
    qualificationGoals: string;
    handoffRules: string;
    pauseOnPhoneReply: boolean;
  };
  copilot: { enabled: boolean; goal: string };
  ai: { autoQualify: boolean; autoMoveStage: boolean };
  automation: {
    sendWindowEnabled: boolean;
    sendWindowStart: string;
    sendWindowEnd: string;
    optOutKeywords: string[];
    optOutReply: string;
  };
  n8n: { webhookUrl: string };
}

export interface SettingsResponse {
  settings: Settings;
  system: {
    aiEnabled: boolean;
    aiModel: string;
    whatsappProvider: "simulator" | "evolution" | "meta";
    n8nWebhookFromEnv: boolean;
    integrationApiEnabled: boolean;
    timezone: string;
    webhooks: { evolution: string; meta: string };
  };
}

export interface Dashboard {
  totals: {
    leads: number;
    newThisWeek: number;
    won: number;
    lost: number;
    conversionRate: number | null;
    pipelineValue: number;
    wonValue: number;
  };
  byStage: Array<{ stageId: number | null; n: number; value: number }>;
  byTemperature: Array<{ temperature: Temperature; n: number }>;
  bySource: Array<{ source: string; n: number }>;
  leadsPerDay: Array<{ day: string; n: number }>;
  messages24h: { received: number; sent: number; byBot: number; byAutomation: number };
  hotLeads: Lead[];
  waitingReply: Lead[];
  aiEnabled: boolean;
  whatsappProvider: string;
}

export interface CrmEvent {
  type: string;
  timestamp: string;
  data: Record<string, any>;
}
