// Sobe o backend (porta 3000) e o painel com recarga automática (porta 5173) juntos.
import { spawn } from "node:child_process";

const procs = [
  ["api", ["--prefix", "server", "run", "dev"]],
  ["web", ["--prefix", "web", "run", "dev"]],
].map(([name, args]) => {
  const p = spawn("npm", args, { stdio: ["inherit", "pipe", "pipe"], shell: process.platform === "win32" });
  const tag = name === "api" ? "\x1b[32m[api]\x1b[0m" : "\x1b[35m[web]\x1b[0m";
  const pipe = (stream, out) =>
    stream.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => out.write(`${tag} ${l}\n`)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on("exit", (code) => {
    console.log(`${tag} saiu (código ${code})`);
    procs.forEach((o) => o.kill());
    process.exit(code ?? 0);
  });
  return p;
});

process.on("SIGINT", () => procs.forEach((p) => p.kill("SIGINT")));
console.log("\nPainel: http://localhost:5173   ·   API: http://localhost:3000\n");
