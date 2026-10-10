import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Cada teste cria e migra um banco (PGlite em memória ou PostgreSQL): em máquinas lentas/CI
    // o padrão de 5 s não basta
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
