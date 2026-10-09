import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { sessionUser, type SessionClaims } from "../http.js";

/** Eventos em tempo real para o painel (Server-Sent Events). O token vai na query porque EventSource não envia headers. */
export async function eventRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/events", async (req, reply) => {
    const token = (req.query as { token?: string }).token ?? "";
    try {
      await sessionUser(ctx, app.jwt.verify<SessionClaims>(token));
    } catch {
      return reply.code(401).send({ error: "Token inválido." });
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`event: ready\ndata: {}\n\n`);

    const unsubscribe = ctx.events.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
}
