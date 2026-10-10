import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { sessionUser, type SessionClaims } from "../http.js";

/** Eventos em tempo real para o painel (Server-Sent Events). O token vai na query porque EventSource não envia headers. */
export async function eventRoutes(app: FastifyInstance, ctx: AppContext) {
  const checkSession = async (token: string) => sessionUser(ctx, app.jwt.verify<SessionClaims>(token));

  app.get("/api/events", async (req, reply) => {
    const token = (req.query as { token?: string }).token ?? "";
    try {
      await checkSession(token);
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

    let open = true;
    const unsubscribe = ctx.events.subscribe((event) => {
      if (open) res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const close = () => {
      if (!open) return;
      open = false;
      clearInterval(ping);
      unsubscribe();
    };
    // A cada ping confere de novo o login: usuário removido, senha trocada ou token vencido
    // encerram a conexão (senão um token vazado continuaria recebendo tudo)
    const ping = setInterval(async () => {
      try {
        await checkSession(token);
        if (open) res.write(`: ping\n\n`);
      } catch {
        close();
        res.end();
      }
    }, ctx.sessionCheckMs ?? 15_000);
    req.raw.on("close", close);
  });
}
