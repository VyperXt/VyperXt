import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aiProviderKind } from "../ai/provider.js";
import type { AppContext } from "../context.js";
import { HttpError, parse } from "../http.js";
import { normalizePhone } from "../lib/phone.js";
import { handleIncoming } from "../services/messaging.js";
import { researchProvider } from "../services/prospecting.js";
import { getSettings, settingsPatchSchema, updateSettings } from "../settings.js";
import { evolutionWebhookUrl } from "../whatsapp/index.js";

export async function settingsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/settings", async () => {
    const settings = await getSettings(ctx.db);
    const base = ctx.config.PUBLIC_URL.replace(/\/$/, "");
    return {
      settings,
      system: {
        aiEnabled: ctx.ai.enabled,
        aiModel: ctx.ai.model,
        // IA principal em uso e se há quem pesquise na web (prospecção: Claude Code, ou a principal se pesquisar)
        aiProvider: aiProviderKind(ctx.ai),
        aiResearch: Boolean(researchProvider(ctx)),
        // Claude Code (assinatura): prospecção e amostras
        claudeCode: { enabled: Boolean(ctx.claude), model: ctx.claude?.model ?? "" },
        // Onde os sites demo são publicados (null = não publica)
        publisher: ctx.publisher?.name ?? null,
        whatsappProvider: ctx.wa.name,
        n8nWebhookFromEnv: Boolean(ctx.config.N8N_WEBHOOK_URL),
        integrationApiEnabled: Boolean(ctx.config.CRM_API_KEY),
        timezone: ctx.config.APP_TIMEZONE,
        webhooks: {
          evolution: evolutionWebhookUrl(ctx.config),
          meta: `${base}/api/webhooks/meta`,
        },
      },
    };
  });

  app.put("/api/settings", async (req) => {
    if ((req.user as { role?: string }).role !== "admin") throw new HttpError(403, "Apenas administradores.");
    const patch = parse(settingsPatchSchema, req.body);
    return { settings: await updateSettings(ctx.db, patch) };
  });

  app.post("/api/settings/notify/test", async () => {
    const settings = await getSettings(ctx.db);
    const raw = settings.notify.handoffPhone.trim();
    if (!raw) {
      throw new HttpError(400, "Telefone de aviso não configurado.");
    }
    const phone = normalizePhone(raw);
    if (!phone) {
      throw new HttpError(400, "Telefone de aviso inválido.");
    }
    await ctx.wa.sendText(phone, "✅ Teste de aviso do CRM");
    return { ok: true };
  });

  // ---- WhatsApp ----
  app.get("/api/whatsapp/status", async () => ctx.wa.status());

  app.post("/api/whatsapp/connect", async () => {
    try {
      return await ctx.wa.connect();
    } catch (err) {
      throw new HttpError(502, `Não foi possível falar com o provedor de WhatsApp: ${(err as Error).message}`);
    }
  });

  app.post("/api/whatsapp/disconnect", async () => {
    await ctx.wa.disconnect();
    return { ok: true };
  });

  // Injeta uma mensagem como se o lead tivesse mandado — ótimo para testar bot e copiloto
  app.post("/api/whatsapp/simulate", async (req) => {
    // Só no modo simulador: com WhatsApp real, isso faria o bot responder um número de verdade
    if (ctx.wa.name !== "simulator") {
      throw new HttpError(403, "A simulação só funciona com WHATSAPP_PROVIDER=simulator.");
    }
    const body = parse(
      z.object({
        phone: z.string().min(8),
        name: z.string().optional(),
        body: z.string().trim().min(1).max(4096),
        fromMe: z.boolean().default(false),
      }),
      req.body,
    );
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, "Telefone inválido.");
    const message = await handleIncoming(ctx, {
      phone,
      name: body.name,
      body: body.body,
      mediaType: "text",
      fromMe: body.fromMe,
      externalId: `simin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return { message };
  });
}
