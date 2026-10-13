import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { currentUserId, HttpError, idParam, parse } from "../http.js";
import {
  cancelProspectSearch,
  deleteProspectResult,
  deleteProspectSearch,
  getProspectSearch,
  importProspects,
  listProspectSearches,
  prospectCriteriaSchema,
  recheckProspectsWhatsApp,
  startProspectSearch,
  updateProspectResult,
} from "../services/prospecting.js";

function indexParam(req: { params: unknown }): number {
  const index = Number((req.params as { index?: string }).index);
  if (!Number.isInteger(index) || index < 0) throw new HttpError(400, "Índice inválido.");
  return index;
}

export async function prospectingRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post(
    "/api/prospecting/searches",
    // Cada pesquisa gasta minutos de IA (e o limite da assinatura): freio contra cliques repetidos
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const criteria = parse(prospectCriteriaSchema, req.body);
      const search = await startProspectSearch(ctx, criteria, currentUserId(req));
      return reply.code(202).send({ search });
    },
  );

  app.get("/api/prospecting/searches", async () => listProspectSearches(ctx));

  app.get("/api/prospecting/searches/:id", async (req) => getProspectSearch(ctx, idParam(req)));

  app.post("/api/prospecting/searches/:id/cancel", async (req) => cancelProspectSearch(ctx, idParam(req)));

  app.delete("/api/prospecting/searches/:id", async (req) => {
    await deleteProspectSearch(ctx, idParam(req));
    return { ok: true };
  });

  // Confere de novo quem tem WhatsApp (pesquisas antigas, ou WhatsApp desconectado na hora da pesquisa)
  app.post("/api/prospecting/searches/:id/check-whatsapp", async (req) => recheckProspectsWhatsApp(ctx, idParam(req)));

  app.patch("/api/prospecting/searches/:id/results/:index", async (req) => {
    const id = idParam(req);
    const index = indexParam(req);
    const body = parse(
      z.object({
        company: z.string().optional(),
        contactName: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        website: z.string().optional(),
        instagram: z.string().optional(),
        city: z.string().optional(),
        approach: z.string().optional(),
      }),
      req.body,
    );
    return updateProspectResult(ctx, id, index, body);
  });

  app.delete("/api/prospecting/searches/:id/results/:index", async (req) => {
    const id = idParam(req);
    const index = indexParam(req);
    await deleteProspectResult(ctx, id, index);
    return { ok: true };
  });

  app.post("/api/prospecting/searches/:id/import", async (req) => {
    const id = idParam(req);
    const body = parse(
      z.object({
        indexes: z.array(z.number().int().min(0)).min(1).max(100),
        stageId: z.number().int().optional(),
        playbookId: z.number().int().nullish(),
        chatMode: z.enum(["bot", "human"]).optional(),
        firstMessage: z
          .object({
            send: z.boolean(),
            text: z.string(),
            intervalMinutes: z.number().int().min(1).max(120).optional().default(5),
          })
          .optional(),
      }),
      req.body,
    );

    if (body.firstMessage?.send && !body.firstMessage.text.trim()) {
      throw new HttpError(400, "Escreva a primeira mensagem antes de disparar.");
    }

    return importProspects(ctx, id, body.indexes, {
      stageId: body.stageId,
      userId: currentUserId(req),
      playbookId: body.playbookId,
      chatMode: body.chatMode,
      firstMessage: body.firstMessage,
    });
  });
}
