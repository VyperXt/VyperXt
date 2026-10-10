import { createHmac, randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { normalizeIP } from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { users } from "../db/schema.js";
import { claimsOf, currentUserId, HttpError, idParam, parse } from "../http.js";
import { LoginFailures } from "../lib/login-failures.js";
import { hashPassword, safeEqual, verifyPassword } from "../lib/password.js";

const publicUser = (u: typeof users.$inferSelect) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

const loginEmail = (body: unknown) =>
  String((body as { email?: unknown } | null)?.email ?? "")
    .trim()
    .toLowerCase();

/**
 * "Este navegador já entrou nesta conta": um sinal assinado (sem guardar nada no banco) que o painel
 * manda no login. Quem tem o sinal não é barrado pelo bloqueio da conta (tem um limite só seu), então
 * um atacante errando a senha de propósito não tranca para fora quem já usa o CRM.
 */
function deviceToken(secret: string, userId: number, nonce = randomBytes(12).toString("base64url")): string {
  const mac = createHmac("sha256", secret).update(`device:${userId}:${nonce}`).digest("base64url");
  return `${userId}.${nonce}.${mac}`;
}

function trustedDevice(secret: string, token: string | undefined, userId: number): string | null {
  const [id, nonce] = (token ?? "").split(".");
  if (Number(id) !== userId || !nonce) return null;
  return safeEqual(token!, deviceToken(secret, userId, nonce)) ? nonce : null;
}

export async function publicAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  const secret = ctx.config.JWT_SECRET;
  // Tentativas por conta (de qualquer IP): segura quem troca de IP a cada tentativa
  const failures = new LoginFailures({ max: 20, windowMs: 15 * 60_000 });
  // E-mails que não existem têm o mesmo limite, para a resposta não revelar quais e-mails existem
  const unknownEmails = new LoginFailures({ max: 20, windowMs: 15 * 60_000, maxKeys: 10_000 });
  // Senha falsa para conferir quando o e-mail não existe (mesmo tempo de resposta)
  const dummyHash = hashPassword(randomBytes(16).toString("hex"));

  app.post(
    "/api/auth/login",
    {
      config: {
        // Limite por IP + e-mail (preHandler: o corpo já foi lido). Atrás de um proxy sem TRUST_PROXY,
        // todo mundo tem o mesmo IP; com o e-mail na chave, um atacante não bloqueia os outros usuários.
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          hook: "preHandler",
          // IPv6 agrupado por /64 (cada cliente costuma ter uma faixa inteira), como o padrão do plugin
          keyGenerator: (req: FastifyRequest) => `${normalizeIP(req.ip)}|${loginEmail(req.body)}`,
        },
      },
    },
    async (req, reply) => {
      const body = parse(
        z.object({ email: z.string().trim().toLowerCase(), password: z.string(), device: z.string().max(300).optional() }),
        req.body,
      );
      const [user] = await ctx.db.select().from(users).where(eq(users.email, body.email));
      const device = user ? trustedDevice(secret, body.device, user.id) : null;
      // Navegador de confiança: limite próprio. Os demais dividem o limite da conta, que inclui a versão
      // do token (redefinir a senha pelo script já libera a conta).
      const store = user ? failures : unknownEmails;
      const key = !user ? body.email : device ? `device:${user.id}:${device}` : `user:${user.id}:${user.tokenVersion}`;
      const now = ctx.now().getTime();
      const wait = store.retryAfterSeconds(key, now);
      if (wait > 0) {
        reply.header("retry-after", String(wait));
        throw new HttpError(
          429,
          `Muitas tentativas erradas para este e-mail. Tente de novo em ${Math.ceil(wait / 60)} min ou entre por um navegador em que você já usou o CRM.`,
        );
      }
      // Conta a tentativa ANTES de conferir a senha: várias tentativas em paralelo também entram no limite
      store.add(key, now);
      const ok = await verifyPassword(body.password, user?.passwordHash ?? (await dummyHash));
      if (!user || !ok) throw new HttpError(401, "E-mail ou senha incorretos.");
      store.clear(key);
      const token = app.jwt.sign(claimsOf(user), { expiresIn: "7d" });
      return { token, user: publicUser(user), device: device ? body.device : deviceToken(secret, user.id) };
    },
  );
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/auth/me", async (req) => {
    const [user] = await ctx.db.select().from(users).where(eq(users.id, currentUserId(req) ?? 0));
    if (!user) throw new HttpError(401, "Sessão inválida.");
    return publicUser(user);
  });

  app.post("/api/auth/password", async (req) => {
    const body = parse(z.object({ current: z.string(), next: z.string().min(6) }), req.body);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, currentUserId(req) ?? 0));
    if (!user || !(await verifyPassword(body.current, user.passwordHash))) throw new HttpError(400, "Senha atual incorreta.");
    // Nova versão de token: derruba todos os logins antigos (ex.: se a senha vazou)
    const [updated] = await ctx.db
      .update(users)
      .set({ passwordHash: await hashPassword(body.next), tokenVersion: user.tokenVersion + 1 })
      .where(eq(users.id, user.id))
      .returning();
    // Devolve um token novo para esta sessão continuar logada
    return { ok: true, token: app.jwt.sign(claimsOf(updated!), { expiresIn: "7d" }) };
  });

  app.get("/api/users", async () => {
    const rows = await ctx.db.select().from(users).orderBy(asc(users.id));
    return rows.map(publicUser);
  });

  app.post("/api/users", async (req) => {
    if ((req.user as { role?: string }).role !== "admin") throw new HttpError(403, "Apenas administradores.");
    const body = parse(
      z.object({
        name: z.string().trim().min(1),
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(6),
        role: z.enum(["admin", "agent"]).default("agent"),
      }),
      req.body,
    );
    const [exists] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (exists) throw new HttpError(409, "Já existe um usuário com este e-mail.");
    const [user] = await ctx.db
      .insert(users)
      .values({ name: body.name, email: body.email, role: body.role, passwordHash: await hashPassword(body.password) })
      .returning();
    return publicUser(user!);
  });

  app.delete("/api/users/:id", async (req) => {
    if ((req.user as { role?: string }).role !== "admin") throw new HttpError(403, "Apenas administradores.");
    const id = idParam(req);
    if (id === currentUserId(req)) throw new HttpError(400, "Você não pode remover a si mesmo.");
    await ctx.db.delete(users).where(eq(users.id, id));
    return { ok: true };
  });
}
