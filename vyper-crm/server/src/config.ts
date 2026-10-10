import { z } from "zod";

// Todas as configurações vêm de variáveis de ambiente (veja .env.example).
const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  // postgres://usuario:senha@host:5432/banco  ou  pglite://./data/pglite (banco embutido, sem Docker)
  DATABASE_URL: z.string().default("pglite://./data/pglite"),
  JWT_SECRET: z.string().min(16).default("troque-este-segredo-jwt-agora"), // ver insecureSettings()
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
  // Atrás de um proxy reverso (Caddy, Nginx, Traefik)? Use 1 (um proxy) ou o IP/CIDR dele.
  // false = usa o IP da conexão; sem isso qualquer um poderia forjar X-Forwarded-For.
  TRUST_PROXY: z.string().default("false"),

  WHATSAPP_PROVIDER: z.enum(["simulator", "evolution", "meta"]).default("simulator"),
  EVOLUTION_API_URL: z.string().default("http://localhost:8080"),
  EVOLUTION_API_KEY: z.string().default(""),
  EVOLUTION_INSTANCE: z.string().default("crm"),
  META_ACCESS_TOKEN: z.string().default(""),
  META_PHONE_NUMBER_ID: z.string().default(""),
  META_VERIFY_TOKEN: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  META_GRAPH_VERSION: z.string().default("v23.0"),

  // IA: Claude (Anthropic) e/ou OpenRouter (modelos gratuitos). Com as duas chaves, AI_PROVIDER escolhe a
  // principal e a outra fica de reserva. auto = Claude se tiver a chave, senão OpenRouter.
  AI_PROVIDER: z.preprocess(
    (v) => {
      const s = typeof v === "string" ? v.trim().toLowerCase() : "";
      return s === "claude" ? "anthropic" : s || "auto";
    },
    z.enum(["auto", "anthropic", "openrouter"]),
  ),
  ANTHROPIC_API_KEY: z.string().default(""),
  AI_MODEL: z.string().default("claude-opus-5-5"),
  OPENROUTER_API_KEY: z.string().default(""),
  // openrouter/free = escolhe entre os modelos gratuitos disponíveis no momento
  // (vazio no .env = padrão)
  OPENROUTER_MODEL: z.preprocess((v) => (typeof v === "string" && v.trim() ? v.trim() : undefined), z.string().default("openrouter/free")),
  // Outros modelos (separados por vírgula) que o OpenRouter tenta se o principal falhar
  OPENROUTER_FALLBACK_MODELS: z.string().default(""),

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

/** Converte TRUST_PROXY no formato que o Fastify entende. */
export function trustProxyValue(raw: string): boolean | string | ((address: string, hop: number) => boolean) {
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "false" || v === "0" || v === "no") return false;
  if (v === "true") return true;
  if (/^\d+$/.test(v)) {
    // N = confia nos N proxies mais próximos (mesma regra do "trust proxy" numérico do Express)
    const hops = Number(v);
    return (_address, hop) => hop < hops;
  }
  return raw.trim(); // IPs/CIDRs separados por vírgula
}

const DEFAULT_JWT_SECRET = "troque-este-segredo-jwt-agora";

/**
 * Valores que não podem ir para produção: os padrões do código e os exemplos do .env.example
 * (todos começam com "troque").
 */
export function insecureSettings(config: Config): string[] {
  const placeholder = (v: string) => /^troque/i.test(v.trim());
  const bad: string[] = [];
  if (config.JWT_SECRET === DEFAULT_JWT_SECRET || placeholder(config.JWT_SECRET)) bad.push("JWT_SECRET");
  if (placeholder(config.CRM_API_KEY)) bad.push("CRM_API_KEY");
  if (placeholder(config.WEBHOOK_SECRET)) bad.push("WEBHOOK_SECRET");
  if (config.WHATSAPP_PROVIDER === "evolution") {
    if (!config.EVOLUTION_API_KEY || placeholder(config.EVOLUTION_API_KEY)) bad.push("EVOLUTION_API_KEY");
    if (!config.WEBHOOK_SECRET) bad.push("WEBHOOK_SECRET");
  }
  if (config.WHATSAPP_PROVIDER === "meta" && !config.META_APP_SECRET) bad.push("META_APP_SECRET");
  return [...new Set(bad)];
}

/**
 * Valores de exemplo que só geram aviso: a senha do banco (no docker-compose ela vai dentro da
 * DATABASE_URL). A porta do Postgres não é publicada, e trocar a senha de um banco que já tem dados
 * exige ALTER USER (veja o README), então não impedimos o CRM de subir por causa dela.
 */
export function weakSettings(config: Config): string[] {
  return /:troque[^@]*@/i.test(config.DATABASE_URL) ? ["POSTGRES_PASSWORD"] : [];
}

/** Senha do admin inicial: só importa na primeira execução (quando ainda não há usuários). */
export function isInsecureAdminPassword(password: string): boolean {
  return password === "admin123" || /^troque/i.test(password.trim()) || password.length < 8;
}
