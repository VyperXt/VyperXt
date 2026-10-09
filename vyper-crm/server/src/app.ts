import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyBaseLogger, type FastifyError } from "fastify";
import { AiRefusalError, AiUnavailableError } from "./ai/provider.js";
import type { AppContext } from "./context.js";
import { HttpError } from "./http.js";
import { authRoutes, publicAuthRoutes } from "./routes/auth.js";
import { automationRoutes } from "./routes/automations.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { eventRoutes } from "./routes/events.js";
import { integrationRoutes } from "./routes/integrations.js";
import { leadRoutes } from "./routes/leads.js";
import { settingsRoutes } from "./routes/settings.js";
import { webhookRoutes } from "./routes/webhooks.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: number; role: "admin" | "agent"; name: string };
    user: { sub: number; role: "admin" | "agent"; name: string };
  }
}

/** Esconde segredos que viajam na URL (token do SSE e do webhook). */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|hub\.verify_token)=)[^&]*/gi, "$1***");
}

export interface BuildOptions {
  logger?: FastifyBaseLogger | boolean;
  webDist?: string;
}

export async function buildApp(ctx: AppContext, opts: BuildOptions = {}) {
  const app = Fastify({
    ...(typeof opts.logger === "object" ? { loggerInstance: opts.logger } : { logger: opts.logger ?? false }),
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
    // Logamos as requisições nós mesmos (abaixo) para esconder tokens que vão na URL
    disableRequestLogging: true,
  });

  app.addHook("onResponse", async (req, reply) => {
    const url = redactUrl(req.url);
    const quiet = url.startsWith("/api/webhooks/") || url.startsWith("/api/events") || url.startsWith("/assets/");
    const entry = { method: req.method, url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) };
    if (reply.statusCode >= 500) req.log.error(entry, "requisição");
    else if (!quiet) req.log.info(entry, "requisição");
  });

  // Guarda o corpo bruto (necessário para validar a assinatura dos webhooks da Meta)
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(400, "JSON inválido."), undefined);
    }
  });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { global: false });
  await app.register(jwt, { secret: ctx.config.JWT_SECRET });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof AiUnavailableError) return reply.code(503).send({ error: err.message });
    if (err instanceof AiRefusalError) return reply.code(422).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error({ err }, "erro inesperado");
    return reply.code(500).send({ error: "Erro interno. Veja os logs do servidor." });
  });

  app.get("/api/health", async () => ({ ok: true, whatsapp: ctx.wa.name, ai: ctx.ai.enabled }));

  // Rotas públicas (login, webhooks do WhatsApp, eventos com token na URL)
  await app.register(async (pub) => {
    await publicAuthRoutes(pub, ctx);
    await webhookRoutes(pub, ctx);
    await eventRoutes(pub, ctx);
  });

  // API para n8n e outros sistemas (x-api-key)
  await app.register(async (integ) => integrationRoutes(integ, ctx));

  // Rotas do painel (precisam de login)
  await app.register(async (priv) => {
    priv.addHook("onRequest", async (req) => {
      try {
        await req.jwtVerify();
      } catch {
        throw new HttpError(401, "Faça login novamente.");
      }
    });
    await authRoutes(priv, ctx);
    await leadRoutes(priv, ctx);
    await automationRoutes(priv, ctx);
    await dashboardRoutes(priv, ctx);
    await settingsRoutes(priv, ctx);
  });

  // Painel web (build do React)
  if (opts.webDist && existsSync(join(opts.webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: opts.webDist });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0]!;
      if (path.startsWith("/api/") || /\.\w+$/.test(path)) return reply.code(404).send({ error: "Rota não encontrada." });
      return reply.type("text/html").sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: "Rota não encontrada." }));
  }

  return app;
}
