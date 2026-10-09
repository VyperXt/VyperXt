import { z } from "zod";

// Todas as configurações vêm de variáveis de ambiente (veja .env.example).
const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  // postgres://usuario:senha@host:5432/banco  ou  pglite://./data/pglite (banco embutido, sem Docker)
  DATABASE_URL: z.string().default("pglite://./data/pglite"),
  JWT_SECRET: z.string().min(16).default("troque-este-segredo-jwt-agora"),
  ADMIN_NAME: z.string().default("Administrador"),
  ADMIN_EMAIL: z.string().default("admin@crm.local"),
  ADMIN_PASSWORD: z.string().default("admin123"),
  // Chave que o n8n (ou qualquer sistema externo) usa no header x-api-key
  CRM_API_KEY: z.string().default(""),
  // Token secreto que vai na URL dos webhooks de WhatsApp (?token=...)
  WEBHOOK_SECRET: z.string().default(""),
  // URL pela qual o provedor de WhatsApp alcança este servidor (ex.: http://crm:3000 dentro do Docker)
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  APP_TIMEZONE: z.string().default("America/Sao_Paulo"),

  WHATSAPP_PROVIDER: z.enum(["simulator", "evolution", "meta"]).default("simulator"),
  EVOLUTION_API_URL: z.string().default("http://localhost:8080"),
  EVOLUTION_API_KEY: z.string().default(""),
  EVOLUTION_INSTANCE: z.string().default("crm"),
  META_ACCESS_TOKEN: z.string().default(""),
  META_PHONE_NUMBER_ID: z.string().default(""),
  META_VERIFY_TOKEN: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  META_GRAPH_VERSION: z.string().default("v23.0"),

  ANTHROPIC_API_KEY: z.string().default(""),
  AI_MODEL: z.string().default("claude-opus-5-5"),

  // Para onde o CRM envia eventos (lead.created, message.received...) — normalmente um Webhook do n8n
  N8N_WEBHOOK_URL: z.string().default(""),
  N8N_WEBHOOK_SECRET: z.string().default(""),

  // Intervalo do agendador de automações (ms)
  SCHEDULER_INTERVAL_MS: z.coerce.number().default(30_000),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  return parsed.data;
}
