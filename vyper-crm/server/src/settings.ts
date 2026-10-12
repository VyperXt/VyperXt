import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client.js";
import { settings } from "./db/schema.js";

const timeRe = /^\d{2}:\d{2}$/;

// Tudo que dá para ajustar pela tela de Configurações.
// Os campos não têm .default(): os padrões ficam em DEFAULTS. Assim um PUT parcial
// (ex.: { bot: { enabled: false } }) não reescreve os outros campos da seção com o padrão.
const sections = {
  business: z.object({
    name: z.string(),
    description: z.string(),
    products: z.string(),
    faq: z.string(),
    tone: z.string(),
    rules: z.string(),
  }),
  bot: z.object({
    enabled: z.boolean(),
    // Modo das conversas novas: bot (IA responde) ou human (só copiloto)
    defaultMode: z.enum(["bot", "human"]),
    // Espera o lead terminar de digitar antes de responder (segundos)
    replyDelaySeconds: z.number().min(0).max(120),
    qualificationGoals: z.string(),
    handoffRules: z.string(),
    // Quando você responde (pelo painel ou pelo celular), a IA para de responder aquela conversa
    pauseOnPhoneReply: z.boolean(),
  }),
  copilot: z.object({
    enabled: z.boolean(),
    goal: z.string(),
  }),
  ai: z.object({
    autoQualify: z.boolean(),
    // Move o lead para frente no funil quando a IA tiver certeza (nunca para Ganho/Perdido)
    autoMoveStage: z.boolean(),
  }),
  automation: z.object({
    // Follow-ups e mensagens agendadas só saem dentro deste horário
    sendWindowEnabled: z.boolean(),
    sendWindowStart: z.string().regex(timeRe),
    sendWindowEnd: z.string().regex(timeRe),
    optOutKeywords: z.array(z.string()),
    optOutReply: z.string(),
  }),
  n8n: z.object({
    // Se vazio, usa a variável N8N_WEBHOOK_URL
    webhookUrl: z.string(),
  }),
  // Amostras feitas pelo Claude Code (site demo ou arte) quando o lead esquenta
  samples: z.object({
    // Gera sozinho quando o lead fica quente / é passado para você (o envio é sempre manual)
    autoGenerate: z.boolean(),
    onHot: z.boolean(),
    onHandoff: z.boolean(),
    defaultKind: z.enum(["site", "image"]),
    // Suas orientações para todas as amostras (estilo, o que destacar, o que evitar)
    instructions: z.string(),
  }),
  // Aviso quando a IA passa para você
  notify: z.object({
    handoffEnabled: z.boolean(),
    handoffPhone: z.string(),
  }),
};

export const appSettingsSchema = z.object(sections);
export type AppSettings = z.infer<typeof appSettingsSchema>;
type SectionName = keyof AppSettings;

export const DEFAULT_SETTINGS: AppSettings = {
  business: {
    name: "Minha Empresa",
    description: "",
    products: "",
    faq: "",
    tone: "Simpático, direto e profissional. Mensagens curtas, como no WhatsApp.",
    rules: "",
  },
  bot: {
    enabled: true,
    defaultMode: "bot",
    replyDelaySeconds: 6,
    qualificationGoals: "Descobrir o nome, o que a pessoa procura, orçamento aproximado e prazo para decidir.",
    handoffRules:
      "Passe para um humano quando: o lead pedir para falar com uma pessoa, quiser fechar/pagar, pedir desconto especial, fizer reclamação ou perguntar algo que você não sabe.",
    pauseOnPhoneReply: true,
  },
  copilot: {
    enabled: true,
    goal: "Conduzir o lead até o fechamento ou agendamento de uma reunião.",
  },
  ai: { autoQualify: true, autoMoveStage: true },
  automation: {
    sendWindowEnabled: true,
    sendWindowStart: "08:00",
    sendWindowEnd: "20:00",
    optOutKeywords: ["sair", "parar", "pare", "stop", "descadastrar", "cancelar mensagens"],
    optOutReply: "Tudo bem! Você não vai mais receber mensagens automáticas. Se precisar, é só chamar. 👍",
  },
  n8n: { webhookUrl: "" },
  samples: { autoGenerate: true, onHot: true, onHandoff: true, defaultKind: "site", instructions: "" },
  notify: { handoffEnabled: false, handoffPhone: "" },
};

const SECTION_NAMES = Object.keys(sections) as SectionName[];
const SETTINGS_KEY = "app";

/** Remove chaves com valor undefined (para não apagar o valor atual num merge). */
function defined(obj: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined));
}

/** Completa o que estiver faltando com os padrões; uma seção inválida volta inteira para o padrão. */
function withDefaults(value: unknown): AppSettings {
  const stored = (value ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const result = {} as Record<SectionName, unknown>;
  for (const name of SECTION_NAMES) {
    const parsed = sections[name].safeParse({ ...DEFAULT_SETTINGS[name], ...defined(stored[name]) });
    result[name] = parsed.success ? parsed.data : DEFAULT_SETTINGS[name];
  }
  return result as AppSettings;
}

export async function getSettings(db: Db): Promise<AppSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY));
  return withDefaults(row?.value);
}

export const settingsPatchSchema = z.object({
  business: sections.business.partial().optional(),
  bot: sections.bot.partial().optional(),
  copilot: sections.copilot.partial().optional(),
  ai: sections.ai.partial().optional(),
  automation: sections.automation.partial().optional(),
  n8n: sections.n8n.partial().optional(),
  samples: sections.samples.partial().optional(),
  notify: sections.notify.partial().optional(),
});

export async function updateSettings(db: Db, patch: z.infer<typeof settingsPatchSchema>): Promise<AppSettings> {
  const current = await getSettings(db);
  const merged = {} as Record<SectionName, unknown>;
  for (const name of SECTION_NAMES) {
    merged[name] = sections[name].parse({ ...current[name], ...defined(patch[name]) });
  }
  const value = merged as AppSettings;
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  return value;
}

export interface QueueState {
  pausedUntil: string | null;
  reason: string | null;
}

const QUEUE_SETTINGS_KEY = "queue";

export async function getQueueState(db: Db): Promise<QueueState> {
  const [row] = await db.select().from(settings).where(eq(settings.key, QUEUE_SETTINGS_KEY));
  const val = row?.value as Record<string, unknown> | undefined;
  return {
    pausedUntil: typeof val?.pausedUntil === "string" ? val.pausedUntil : null,
    reason: typeof val?.reason === "string" ? val.reason : null,
  };
}

export async function setQueueState(db: Db, state: QueueState): Promise<QueueState> {
  const value: QueueState = {
    pausedUntil: state.pausedUntil ?? null,
    reason: state.reason ?? null,
  };
  await db
    .insert(settings)
    .values({ key: QUEUE_SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  return value;
}
