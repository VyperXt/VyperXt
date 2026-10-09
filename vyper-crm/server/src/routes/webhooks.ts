import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";
import { HttpError } from "../http.js";
import { safeEqual } from "../lib/password.js";
import { applyStatusUpdate, handleIncoming } from "../services/messaging.js";
import { parseEvolutionWebhook } from "../whatsapp/evolution.js";
import { parseMetaWebhook, verifyMetaSignature } from "../whatsapp/meta.js";
import type { ParsedWebhook } from "../whatsapp/types.js";

async function processParsed(ctx: AppContext, parsed: ParsedWebhook) {
  for (const msg of parsed.messages) {
    try {
      await handleIncoming(ctx, msg);
    } catch (err) {
      ctx.log.error({ err: String(err), externalId: msg.externalId }, "erro ao processar mensagem recebida");
    }
  }
  for (const st of parsed.statuses) await applyStatusUpdate(ctx, st).catch(() => {});
  if (parsed.connection) ctx.events.emit("whatsapp.connection", parsed.connection);
  if (parsed.qrCode) ctx.events.emit("whatsapp.qrcode", parsed.qrCode);
  if (parsed.skipped?.length) ctx.log.warn({ skipped: parsed.skipped }, "mensagens ignoradas no webhook");
}

/**
 * Webhooks públicos chamados pelos provedores de WhatsApp.
 * Fecham por padrão: só o provedor configurado responde, e sempre com segredo.
 */
export async function webhookRoutes(app: FastifyInstance, ctx: AppContext) {
  const provider = ctx.config.WHATSAPP_PROVIDER;

  const checkToken = (req: FastifyRequest) => {
    const secret = ctx.config.WEBHOOK_SECRET;
    if (!secret) throw new HttpError(503, "Defina WEBHOOK_SECRET no .env para receber o webhook da Evolution API.");
    const token = (req.query as { token?: string }).token ?? (req.headers["x-webhook-token"] as string | undefined);
    if (!token || !safeEqual(token, secret)) throw new HttpError(401, "Token do webhook inválido.");
  };

  // Evolution API (byEvents=false manda tudo aqui; byEvents=true acrescenta /nome-do-evento)
  const evolutionHandler = async (req: FastifyRequest) => {
    if (provider !== "evolution") throw new HttpError(404, "Rota não encontrada.");
    checkToken(req);
    await processParsed(ctx, parseEvolutionWebhook(req.body as Record<string, unknown>));
    return { ok: true };
  };
  app.post("/api/webhooks/evolution", evolutionHandler);
  app.post("/api/webhooks/evolution/:event", evolutionHandler);

  // Meta Cloud API: verificação (GET) e eventos (POST)
  app.get("/api/webhooks/meta", async (req, reply) => {
    if (provider !== "meta") throw new HttpError(404, "Rota não encontrada.");
    const q = req.query as Record<string, string | undefined>;
    if (
      q["hub.mode"] === "subscribe" &&
      ctx.config.META_VERIFY_TOKEN &&
      q["hub.verify_token"] &&
      safeEqual(q["hub.verify_token"], ctx.config.META_VERIFY_TOKEN)
    ) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send({ error: "Token de verificação inválido." });
  });

  app.post("/api/webhooks/meta", async (req) => {
    if (provider !== "meta") throw new HttpError(404, "Rota não encontrada.");
    // Sem o segredo do app não há como saber se o POST veio mesmo da Meta: recusa
    if (!ctx.config.META_APP_SECRET) throw new HttpError(503, "Defina META_APP_SECRET no .env para receber o webhook da Meta.");
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyMetaSignature(raw, sig, ctx.config.META_APP_SECRET)) throw new HttpError(401, "Assinatura inválida.");
    await processParsed(ctx, parseMetaWebhook(req.body as Record<string, unknown>));
    return { ok: true };
  });
}
