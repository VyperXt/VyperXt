import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashPassword } from "../lib/password.js";

/**
 * Redefine a senha (ou cria o usuário como administrador). Usado pelo script reset-password.
 * tokenVersion + 1 derruba os logins abertos com a senha antiga (ex.: se ela vazou).
 */
export async function resetUserPassword(db: Db, email: string, password: string): Promise<"reset" | "created"> {
  const normalized = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalized));
  if (user) {
    await db
      .update(users)
      .set({ passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, user.id));
    return "reset";
  }
  await db.insert(users).values({ name: "Administrador", email: normalized, passwordHash, role: "admin" });
  return "created";
}
