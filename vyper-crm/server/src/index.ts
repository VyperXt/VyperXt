import { fileURLToPath } from "node:url";
import pino from "pino";
import { createAiProvider } from "./ai/provider.js";
import { buildApp } from "./app.js";
import { insecureSettings, loadConfig, weakSettings } from "./config.js";
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

// Em produção, não sobe com os segredos de exemplo do .env.example
const insecure = insecureSettings(config);
if (insecure.length) {
  const msg = `Troque estes valores no .env (estão vazios ou com o texto de exemplo): ${insecure.join(", ")}. Gere segredos com: openssl rand -hex 32`;
  if (config.NODE_ENV === "production") {
    logger.fatal(msg);
    process.exit(1);
  }
  logger.warn(msg);
}
if (weakSettings(config).includes("POSTGRES_PASSWORD")) {
  logger.warn(
    "POSTGRES_PASSWORD ainda é o valor de exemplo. Para trocar sem perder dados, veja 'Trocar a senha do banco' no README.",
  );
}

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

if (!ctx.ai.enabled) logger.warn("ANTHROPIC_API_KEY não configurada: recursos de IA desativados.");

await app.listen({ port: config.PORT, host: config.HOST });
logger.info(
  { whatsapp: ctx.wa.name, ai: ctx.ai.enabled ? config.AI_MODEL : "desativada" },
  `CRM rodando em http://localhost:${config.PORT}`,
);

// Evolution: garante que o webhook aponta para a URL atual (com o WEBHOOK_SECRET atual).
// Em segundo plano e com novas tentativas, porque a Evolution pode subir depois do CRM.
void (async () => {
  if (!ctx.wa.syncWebhook) return;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const result = await ctx.wa.syncWebhook();
      if (result === "updated") return logger.info("webhook da Evolution atualizado");
      if (result === "no_instance") return; // ainda não conectou: o Conectar das Configurações grava o webhook
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 300) }, "falha ao atualizar o webhook da Evolution");
    }
    await new Promise((r) => setTimeout(r, 10_000).unref());
  }
  logger.warn("Evolution API inacessível: se trocou WEBHOOK_SECRET ou PUBLIC_URL, clique em Conectar nas Configurações.");
})();

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
