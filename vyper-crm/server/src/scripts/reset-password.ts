// Redefine (ou cria) um usuário administrador.
//   Docker: docker compose exec crm node dist/scripts/reset-password.js email@exemplo.com NovaSenha
//   Local:  npm --prefix server run reset-password -- email@exemplo.com NovaSenha
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashPassword } from "../lib/password.js";

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 6) {
  console.error("Uso: reset-password <email> <nova-senha (mín. 6 caracteres)>");
  process.exit(1);
}
const config = loadConfig();
const { db, close } = await openDatabase(config.DATABASE_URL);
const normalized = email.trim().toLowerCase();
const [user] = await db.select().from(users).where(eq(users.email, normalized));
if (user) {
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, user.id));
  console.log(`Senha de ${normalized} redefinida.`);
} else {
  await db.insert(users).values({ name: "Administrador", email: normalized, passwordHash: await hashPassword(password), role: "admin" });
  console.log(`Usuário administrador ${normalized} criado.`);
}
await close();
