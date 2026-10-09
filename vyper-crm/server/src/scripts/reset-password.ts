// Redefine (ou cria) um usuário administrador.
//   Docker: docker compose exec crm node dist/scripts/reset-password.js email@exemplo.com NovaSenha
//   Local:  npm --prefix server run reset-password -- email@exemplo.com NovaSenha
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/client.js";
import { resetUserPassword } from "../services/users.js";

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 6) {
  console.error("Uso: reset-password <email> <nova-senha (mín. 6 caracteres)>");
  process.exit(1);
}
const config = loadConfig();
const { db, close } = await openDatabase(config.DATABASE_URL);
const normalized = email.trim().toLowerCase();
const result = await resetUserPassword(db, normalized, password);
console.log(
  result === "reset"
    ? `Senha de ${normalized} redefinida. Os logins abertos com a senha antiga foram encerrados.`
    : `Usuário administrador ${normalized} criado.`,
);
await close();
