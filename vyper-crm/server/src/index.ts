import { fileURLToPath } from "node:url";
import pino from "pino";
import { createAiProvider } from "./ai/provider.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { openDatabase } from "./db/client.js";
import { EventBus } from "./lib/events.js";
import { KeyedRunner } from "./lib/keyed-runner.js";
import { startScheduler } from "./services/automation.js";
import { ensureDefaultData } from "./services/leads.js";
import { getSettings } from "./settings.js";
import { createWhatsAppProvider } from "./whatsapp/index.js";

const config = loadConfig();
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const { db, close } = await openDatabase(config.DATABASE_URL);

const events = new EventBus(async () => {
  const s = await getSettings(db);
  const url = s.n8n.webhookUrl || config.N8N_WEBHOOK_URL;
  return url ? { url, secret: config.N8N_WEBHOOK_SECRET || undefined } : null;
}, logger);

const ctx: AppContext = {
  db,
  config,
  ai: createAiProvider(config.ANTHROPIC_API_KEY, config.AI_MODEL),
  wa: createWhatsAppProvider(config),
  events,
  jobs: new KeyedRunner((err, key) => logger.error({ err: String(err), key }, "falha em tarefa de IA")),
  log: logger,
  now: () => new Date(),
};

await ensureDefaultData(ctx);

const webDist = process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const app = await buildApp(ctx, { logger, webDist });
const stopScheduler = startScheduler(ctx, config.SCHEDULER_INTERVAL_MS);

if (config.NODE_ENV === "production") {
  if (config.JWT_SECRET === "troque-este-segredo-jwt-agora") logger.warn("JWT_SECRET está com o valor padrão — troque no .env!");
  if (config.ADMIN_PASSWORD === "admin123") logger.warn("ADMIN_PASSWORD está com o valor padrão — troque a senha!");
}
if (!ctx.ai.enabled) logger.warn("ANTHROPIC_API_KEY não configurada: recursos de IA desativados.");

await app.listen({ port: config.PORT, host: config.HOST });
logger.info(
  { whatsapp: ctx.wa.name, ai: ctx.ai.enabled ? config.AI_MODEL : "desativada" },
  `CRM rodando em http://localhost:${config.PORT}`,
);

const shutdown = async () => {
  stopScheduler();
  ctx.jobs.cancelAll();
  await app.close();
  await events.flush();
  await close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
