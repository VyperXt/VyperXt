import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { currentUserId, idParam, parse } from "../http.js";
import {
  discardSample,
  getSample,
  listLeadSamples,
  publishSample,
  requestSample,
  sampleDetail,
  sendSample,
  summarizeSample,
} from "../services/samples.js";

export async function sampleRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/leads/:id/samples", async (req) => listLeadSamples(ctx, idParam(req)));

  app.post(
    "/api/leads/:id/samples",
    // Cada amostra gasta minutos do Claude (e o limite da assinatura): freio contra cliques repetidos
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const body = parse(
        z.object({
          kind: z.enum(["site", "image"]).optional(),
          instruction: z.string().trim().max(1000).optional(),
        }),
        req.body,
      );
      const sample = await requestSample(ctx, idParam(req), {
        kind: body.kind,
        trigger: "manual",
        instruction: body.instruction,
        userId: currentUserId(req),
      });
      return reply.code(202).send({ sample: summarizeSample(sample) });
    },
  );

  app.get("/api/samples/:id", async (req) => sampleDetail(await getSample(ctx, idParam(req))));

  app.post("/api/samples/:id/publish", async (req) => summarizeSample(await publishSample(ctx, idParam(req))));

  app.post("/api/samples/:id/send", async (req) => {
    const body = parse(z.object({ caption: z.string().max(1000).default("") }), req.body);
    return summarizeSample(await sendSample(ctx, idParam(req), { caption: body.caption, userId: currentUserId(req) }));
  });

  app.post("/api/samples/:id/discard", async (req) => summarizeSample(await discardSample(ctx, idParam(req))));
}
