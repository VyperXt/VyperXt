import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client.js";
import { settings } from "./db/schema.js";

const timeRe = /^\d{2}:\d{2}$/;

// Tudo que dá para ajustar pela tela de Configurações
export const appSettingsSchema = z.object({
  business: z.object({
    name: z.string().default("Minha Empresa"),
    description: z.string().default(""),
    products: z.string().default(""),
    faq: z.string().default(""),
    tone: z.string().default("Simpático, direto e profissional. Mensagens curtas, como no WhatsApp."),
    rules: z.string().default(""),
  }),
  bot: z.object({
    enabled: z.boolean().default(true),
    // Modo das conversas novas: bot (IA responde) ou human (só copiloto)
    defaultMode: z.enum(["bot", "human"]).default("bot"),
    // Espera o lead terminar de digitar antes de responder (segundos)
    replyDelaySeconds: z.number().min(0).max(120).default(6),
    qualificationGoals: z
      .string()
      .default("Descobrir o nome, o que a pessoa procura, orçamento aproximado e prazo para decidir."),
    handoffRules: z
      .string()
      .default(
        "Passe para um humano quando: o lead pedir para falar com uma pessoa, quiser fechar/pagar, pedir desconto especial, fizer reclamação ou perguntar algo que você não sabe.",
      ),
    // Quando você responde (pelo painel ou pelo celular), a IA para de responder aquela conversa
    pauseOnPhoneReply: z.boolean().default(true),
  }),
  copilot: z.object({
    enabled: z.boolean().default(true),
    goal: z.string().default("Conduzir o lead até o fechamento ou agendamento de uma reunião."),
  }),
  ai: z.object({
    autoQualify: z.boolean().default(true),
    // Move o lead para frente no funil quando a IA tiver certeza (nunca para Ganho/Perdido)
    autoMoveStage: z.boolean().default(true),
  }),
  automation: z.object({
    // Follow-ups e mensagens agendadas só saem dentro deste horário
    sendWindowEnabled: z.boolean().default(true),
    sendWindowStart: z.string().regex(timeRe).default("08:00"),
    sendWindowEnd: z.string().regex(timeRe).default("20:00"),
    optOutKeywords: z.array(z.string()).default(["sair", "parar", "pare", "stop", "descadastrar", "cancelar mensagens"]),
    optOutReply: z
      .string()
      .default("Tudo bem! Você não vai mais receber mensagens automáticas. Se precisar, é só chamar. 👍"),
  }),
  n8n: z.object({
    // Se vazio, usa a variável N8N_WEBHOOK_URL
    webhookUrl: z.string().default(""),
  }),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const SETTINGS_KEY = "app";

function withDefaults(value: unknown): AppSettings {
  const v = (value ?? {}) as Record<string, unknown>;
  return appSettingsSchema.parse({
    business: v.business ?? {},
    bot: v.bot ?? {},
    copilot: v.copilot ?? {},
    ai: v.ai ?? {},
    automation: v.automation ?? {},
    n8n: v.n8n ?? {},
  });
}

export async function getSettings(db: Db): Promise<AppSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY));
  return withDefaults(row?.value);
}

export const settingsPatchSchema = z.object({
  business: appSettingsSchema.shape.business.partial().optional(),
  bot: appSettingsSchema.shape.bot.partial().optional(),
  copilot: appSettingsSchema.shape.copilot.partial().optional(),
  ai: appSettingsSchema.shape.ai.partial().optional(),
  automation: appSettingsSchema.shape.automation.partial().optional(),
  n8n: appSettingsSchema.shape.n8n.partial().optional(),
});

export async function updateSettings(db: Db, patch: z.infer<typeof settingsPatchSchema>): Promise<AppSettings> {
  const current = await getSettings(db);
  const merged = withDefaults({
    business: { ...current.business, ...patch.business },
    bot: { ...current.bot, ...patch.bot },
    copilot: { ...current.copilot, ...patch.copilot },
    ai: { ...current.ai, ...patch.ai },
    automation: { ...current.automation, ...patch.automation },
    n8n: { ...current.n8n, ...patch.n8n },
  });
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY, value: merged })
    .onConflictDoUpdate({ target: settings.key, set: { value: merged, updatedAt: new Date() } });
  return merged;
}
