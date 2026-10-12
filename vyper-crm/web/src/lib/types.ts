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

export interface Playbook {
  id: number;
  name: string;
  goal: string;
  offer: string;
  instructions: string;
  handoffRules: string;
  firstMessage: string;
  leadCount: number;
  createdAt: string;
  updatedAt: string;
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
  playbookId: number | null;
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
  notify: {
    handoffEnabled: boolean;
    handoffPhone: string;
  };
  n8n: { webhookUrl: string };
  samples: {
    /** Gera a amostra sozinho quando o lead esquenta (o envio é sempre seu) */
    autoGenerate: boolean;
    onHot: boolean;
    onHandoff: boolean;
    defaultKind: SampleKind;
    instructions: string;
  };
}

export interface SettingsResponse {
  settings: Settings;
  system: {
    aiEnabled: boolean;
    aiModel: string;
    /** IA principal em uso */
    aiProvider: "claude-code" | "anthropic" | "openrouter" | "none";
    /** A IA consegue pesquisar na web (necessário para a prospecção) */
    aiResearch: boolean;
    /** Claude Code (assinatura): só prospecção e amostras */
    claudeCode: { enabled: boolean; model: string };
    /** Onde os sites demo são publicados (null = sem NETLIFY_AUTH_TOKEN) */
    publisher: "netlify" | null;
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

export interface ProspectCriteria {
  niche: string;
  location: string;
  size: string;
  offer: string;
  quantity: number;
  extra: string;
}

export interface ProspectResult {
  company: string;
  contactName: string;
  /** Apenas dígitos, com DDI; vazio quando o número da fonte não é válido */
  phone: string;
  /** Telefone como apareceu na fonte */
  rawPhone: string;
  isMobile: boolean;
  email: string;
  website: string;
  instagram: string;
  address: string;
  city: string;
  size: string;
  fitReason: string;
  /** Sugestão de primeira mensagem */
  approach: string;
  score: number;
  sources: string[];
  /** Já existia um lead com este telefone */
  duplicateLeadId: number | null;
  /** Lead criado a partir deste resultado */
  leadId: number | null;
  /** Conferido no WhatsApp: "yes" tem, "no" não tem, null (ou ausente, em pesquisas antigas) = não verificado */
  whatsapp?: "yes" | "no" | null;
}

export type ProspectStatus = "running" | "done" | "failed" | "canceled";

export interface ProspectSearchSummary {
  id: number;
  status: ProspectStatus;
  criteria: ProspectCriteria;
  /** Andamento (rodando) ou observações da IA (concluída) */
  progress: string | null;
  error: string | null;
  createdBy: number | null;
  createdAt: string;
  finishedAt: string | null;
  resultCount: number;
}

export interface ProspectSearch extends Omit<ProspectSearchSummary, "resultCount"> {
  results: ProspectResult[];
}

export type SampleKind = "site" | "image";
export type SampleStatus = "generating" | "ready" | "failed" | "sent" | "discarded";

/** Amostra feita pelo Claude para um lead (site demo ou arte), sem o conteúdo pesado */
export interface SampleSummary {
  id: number;
  leadId: number;
  kind: SampleKind;
  status: SampleStatus;
  trigger: "hot" | "handoff" | "manual";
  instruction: string | null;
  title: string | null;
  /** Mensagem sugerida para acompanhar a amostra */
  caption: string | null;
  /** Observações do Claude para você */
  notes: string | null;
  slug: string | null;
  publicUrl: string | null;
  error: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  sentAt: string | null;
  hasPreview: boolean;
}

/** Amostra completa: HTML/SVG em content; a arte em PNG como data URL */
export interface SampleDetail extends Omit<SampleSummary, "hasPreview"> {
  content: string | null;
  imagePng: string | null;
}

export interface CrmEvent {
  type: string;
  timestamp: string;
  data: Record<string, any>;
}
