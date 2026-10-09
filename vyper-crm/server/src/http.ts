import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
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
