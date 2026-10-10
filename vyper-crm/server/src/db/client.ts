import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Abre o banco e aplica as migrações.
 * - postgres://...      → PostgreSQL de verdade (produção / Docker)
 * - pglite://./pasta    → PostgreSQL embutido em arquivo (desenvolvimento sem Docker)
 * - pglite://memory     → em memória (testes)
 */
export async function openDatabase(url: string): Promise<DbHandle> {
  if (url.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const target = url.slice("pglite://".length);
    let client;
    if (target === "memory") {
      client = new PGlite();
    } else {
      mkdirSync(target, { recursive: true });
      client = new PGlite(target);
    }
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => client.close() };
  }

  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const client = postgres(url, { max: 10, onnotice: () => {} });
  // No Docker o banco pode demorar alguns segundos para aceitar conexões
  for (let attempt = 1; ; attempt++) {
    try {
      await client`select 1`;
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.warn(`Banco indisponível (tentativa ${attempt}/30): ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.end() };
}
