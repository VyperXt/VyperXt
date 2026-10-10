import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { AppContext } from "./context.js";
import { users, type User } from "./db/schema.js";
import { HttpError } from "./services/leads.js";

export { HttpError };

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join(".") || "corpo"}: ${i.message}`).join("; ");
    throw new HttpError(400, `Dados inválidos — ${msg}`);
  }
  return result.data;
}

/** PATCH sem nenhum campo conhecido: 400 em vez de um UPDATE vazio (que o banco recusaria com 500). */
export function requireChanges<T extends object>(body: T): T {
  if (!Object.values(body).some((v) => v !== undefined)) throw new HttpError(400, "Nada para atualizar.");
  return body;
}

export function idParam(req: FastifyRequest): number {
  const id = Number((req.params as { id?: string }).id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "ID inválido.");
  return id;
}

export function currentUserId(req: FastifyRequest): number | null {
  const user = req.user as { sub?: number } | undefined;
  return user?.sub ?? null;
}

export type Reply = FastifyReply;

export interface SessionClaims {
  sub: number;
  role: "admin" | "agent";
  name: string;
  /** versão do token do usuário no momento do login */
  tv: number;
}

/**
 * Confere no banco se o dono do token ainda existe e não trocou a senha depois do login.
 * O papel (admin/vendedor) vem sempre do banco, nunca do token.
 */
export async function sessionUser(ctx: AppContext, claims: Partial<SessionClaims> | undefined): Promise<User> {
  const [user] = claims?.sub ? await ctx.db.select().from(users).where(eq(users.id, claims.sub)) : [];
  if (!user || (claims?.tv ?? 0) !== user.tokenVersion) throw new HttpError(401, "Sessão expirada. Faça login novamente.");
  return user;
}

export function claimsOf(user: User): SessionClaims {
  return { sub: user.id, role: user.role, name: user.name, tv: user.tokenVersion };
}
