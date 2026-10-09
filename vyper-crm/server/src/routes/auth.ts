import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { users } from "../db/schema.js";
import { claimsOf, currentUserId, HttpError, idParam, parse } from "../http.js";
import { hashPassword, verifyPassword } from "../lib/password.js";

const publicUser = (u: typeof users.$inferSelect) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

export async function publicAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const body = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string() }), req.body);
      const [user] = await ctx.db.select().from(users).where(eq(users.email, body.email));
      if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
        throw new HttpError(401, "E-mail ou senha incorretos.");
      }
      const token = app.jwt.sign(claimsOf(user), { expiresIn: "7d" });
      return { token, user: publicUser(user) };
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
