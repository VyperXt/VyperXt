import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ClaudeCodeProvider,
  type CliRunner,
  type CliRunOptions,
  type CliRunResult,
  CliAbortError,
  CliTimeoutError,
  claudeCodeEnv,
  formatResetEpoch,
  parseResetTime,
  parseResultMessage,
  resolveClaudeCommand,
  Semaphore,
  spawnCliRunner,
} from "../src/ai/claude-code.js";
import { AiError, AiRateLimitError, AiRefusalError } from "../src/ai/errors.js";
import type { ResearchProgress } from "../src/ai/provider.js";
import { replySchema } from "../src/ai/schemas.js";

const WORKDIR = path.join(os.tmpdir(), "vyper-crm-claude-test");
const NOW = Date.parse("2026-10-10T12:00:00Z");

interface Call {
  args: string[];
  stdin: string;
  opts: CliRunOptions;
}

type Reply = Partial<CliRunResult> | Error | ((call: Call) => Promise<Partial<CliRunResult>>);

/** Executor falso: devolve as respostas na ordem e guarda cada chamada (argumentos, entrada, opções). */
function fakeCli(...replies: Reply[]) {
  const calls: Call[] = [];
  const runCli: CliRunner = async (args, stdin, opts) => {
    const call = { args, stdin, opts };
    calls.push(call);
    const reply = replies.shift() ?? {};
    if (reply instanceof Error) throw reply;
    const res = typeof reply === "function" ? await reply(call) : reply;
    return { stdout: "", stderr: "", code: 0, ...res };
  };
  return { calls, runCli };
}

/** Linha final no formato do CLI 2.1.x (verificado de verdade com --output-format json). */
function resultLine(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    num_turns: 2,
    stop_reason: "tool_use", // normal: a resposta estruturada sai por uma ferramenta interna
    result: "",
    structured_output: { reply: "Oi!", handoff: false, handoffReason: "" },
    total_cost_usd: 0.0003,
    usage: { server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } },
    permission_denials: [],
    ...over,
  });
}

function provider(runCli: CliRunner, extra: Partial<ConstructorParameters<typeof ClaudeCodeProvider>[0]> = {}) {
  return new ClaudeCodeProvider({
    command: "claude",
    workdir: WORKDIR,
    env: {
      PATH: "/usr/bin",
      HOME: "/home/node",
      ANTHROPIC_API_KEY: "sk-ant-api-secreta",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDECODE: "1",
    },
    oauthToken: "sk-ant-oat01-assinatura",
    now: () => NOW,
    runCli,
    ...extra,
  });
}

const req = { task: "reply" as const, system: "Você é o atendente.", prompt: "Cliente: oi", schema: replySchema };

/** Valor que vem logo depois de uma flag na lista de argumentos. */
const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

describe("ClaudeCodeProvider — generate", () => {
  it("roda isolado, sem --bare, com o prompt pela entrada padrão", async () => {
    const fake = fakeCli({ stdout: resultLine() });
    const ai = provider(fake.runCli);
    const out = await ai.generate({ ...req, effort: "medium" });

    expect(out).toEqual({ reply: "Oi!", handoff: false, handoffReason: "" });
    expect(ai.model).toBe("claude-code:sonnet (assinatura)");
    const { args, stdin, opts } = fake.calls[0]!;
    expect(args[0]).toBe("-p");
    expect(args).not.toContain("--bare");
    expect(flag(args, "--model")).toBe("sonnet");
    expect(flag(args, "--effort")).toBe("medium");
    expect(flag(args, "--system-prompt")).toBe("Você é o atendente.");
    expect(flag(args, "--output-format")).toBe("json");
    expect(flag(args, "--tools")).toBe("");
    expect(flag(args, "--setting-sources")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    const schema = JSON.parse(flag(args, "--json-schema")!);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["reply", "handoff", "handoffReason"]);
    expect(schema.$schema).toBeUndefined();
    expect(stdin).toBe("Cliente: oi");
    expect(args).not.toContain("Cliente: oi");
    expect(opts.cwd).toBe(WORKDIR);
    expect(opts.timeoutMs).toBe(180_000);
  });

  it("tira a chave de API do ambiente para o CLI usar a assinatura", async () => {
    const fake = fakeCli({ stdout: resultLine() });
    await provider(fake.runCli).generate(req);
    const env = fake.calls[0]!.opts.env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-assinatura");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("effort padrão é low e o modelo vem da configuração", async () => {
    const fake = fakeCli({ stdout: resultLine() });
    const ai = provider(fake.runCli, { model: "opus", timeoutMs: 5000 });
    await ai.generate(req);
    expect(flag(fake.calls[0]!.args, "--effort")).toBe("low");
    expect(flag(fake.calls[0]!.args, "--model")).toBe("opus");
    expect(fake.calls[0]!.opts.timeoutMs).toBe(5000);
  });

  it("sem structured_output, lê o JSON do texto da resposta", async () => {
    const text = 'Aqui está:\n```json\n{"reply":"Do texto","handoff":true,"handoffReason":"pediu humano"}\n```';
    const fake = fakeCli({ stdout: resultLine({ structured_output: undefined, result: text }) });
    expect(await provider(fake.runCli).generate(req)).toEqual({ reply: "Do texto", handoff: true, handoffReason: "pediu humano" });
  });

  it("resposta fora do schema ou sem JSON vira AiError", async () => {
    const wrong = fakeCli({ stdout: resultLine({ structured_output: { reply: 123 } }) });
    await expect(provider(wrong.runCli).generate(req)).rejects.toThrow(/fora do formato na tarefa "reply"/);
    const noJson = fakeCli({ stdout: resultLine({ structured_output: null, result: "não sei" }) });
    await expect(provider(noJson.runCli).generate(req)).rejects.toThrow(/JSON válido/);
    const retries = fakeCli({ stdout: resultLine({ subtype: "error_max_structured_output_retries", is_error: true, structured_output: null }) });
    await expect(provider(retries.runCli).generate(req)).rejects.toThrow(/fora do formato/);
  });

  it("limite do plano (5 horas/semanal) é limite diário, com hora de liberação", async () => {
    const reset = Math.floor(NOW / 1000) + 3600;
    const fake = fakeCli({
      stdout: resultLine({ is_error: true, structured_output: null, result: `Claude AI usage limit reached|${reset}` }),
      code: 1,
    });
    const err = await provider(fake.runCli).generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(AiRateLimitError);
    expect(err.daily).toBe(true);
    expect(err.retryAfterMs).toBe(3_600_000);
    expect(err.message).toMatch(/assinatura/);

    const weekly = fakeCli({ stdout: resultLine({ is_error: true, structured_output: null, result: "You've hit your weekly limit · resets Oct 12" }) });
    const err2 = await provider(weekly.runCli).generate(req).catch((e) => e);
    expect(err2).toBeInstanceOf(AiRateLimitError);
    expect(err2.daily).toBe(true);
    expect(err2.retryAfterMs).toBeNull();
  });

  it("429 por minuto ou sobrecarga é limite passageiro", async () => {
    const fake = fakeCli({
      stdout: resultLine({ is_error: true, api_error_status: 429, structured_output: null, result: "API Error: Rate limit exceeded" }),
    });
    const err = await provider(fake.runCli).generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(AiRateLimitError);
    expect(err.daily).toBe(false);
    const overloaded = fakeCli({ stdout: resultLine({ is_error: true, api_error_status: 529, structured_output: null, result: "Overloaded" }) });
    expect(await provider(overloaded.runCli).generate(req).catch((e) => e)).toBeInstanceOf(AiRateLimitError);
  });

  it("sem login: explica como entrar na assinatura (computador e Docker)", async () => {
    const fake = fakeCli({
      stdout: resultLine({ is_error: true, structured_output: null, result: "Not logged in · Please run /login" }),
      code: 1,
    });
    const err = await provider(fake.runCli).generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err).not.toBeInstanceOf(AiRateLimitError);
    expect(err.message).toMatch(/\/login/);
    expect(err.message).toMatch(/claude setup-token/);
    expect(err.message).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    const status = fakeCli({ stdout: resultLine({ is_error: true, api_error_status: 401, structured_output: null, result: "Invalid API key" }) });
    await expect(provider(status.runCli).generate(req)).rejects.toThrow(/setup-token/);
  });

  it("recusa não vira erro comum (não passa para a IA reserva)", async () => {
    const byStop = fakeCli({ stdout: resultLine({ stop_reason: "refusal", structured_output: null }) });
    await expect(provider(byStop.runCli).generate(req)).rejects.toThrow(AiRefusalError);
    const byText = fakeCli({
      stdout: resultLine({
        is_error: true,
        structured_output: null,
        result: "Claude Code is unable to respond to this request, which appears to violate our Usage Policy",
      }),
    });
    await expect(provider(byText.runCli).generate(req)).rejects.toThrow(AiRefusalError);
  });

  it("CLI não encontrado, tempo esgotado e falha genérica", async () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const notFound = await provider(fakeCli(enoent).runCli).generate(req).catch((e) => e);
    expect(notFound).toBeInstanceOf(AiError);
    expect(notFound.message).toMatch(/Claude Code não encontrado/);
    expect(notFound.message).toMatch(/CLAUDE_CODE_PATH/);

    const timeout = await provider(fakeCli(new CliTimeoutError(180_000)).runCli).generate(req).catch((e) => e);
    expect(timeout).toBeInstanceOf(AiError);
    expect(timeout.message).toMatch(/não respondeu em 180 s/);

    const failed = fakeCli({ stdout: resultLine({ is_error: true, subtype: "error_during_execution", structured_output: null, result: "boom" }) });
    await expect(provider(failed.runCli).generate(req)).rejects.toThrow(/falhou na tarefa "reply": boom/);
  });

  it("stdout que não é JSON: erro com o fim do stderr, sem segredos", async () => {
    const fake = fakeCli({
      stdout: "Segmentation fault",
      stderr: "erro interno: Authorization Bearer abc.def com chave sk-ant-api03-xyz e token sk-ant-oat01-assinatura",
      code: 139,
    });
    const err = await provider(fake.runCli).generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.message).toMatch(/código 139/);
    expect(err.message).toMatch(/erro interno/);
    expect(err.message).not.toMatch(/xyz|abc\.def|oat01-assinatura/);

    // Erro de login que só aparece no stderr
    const login = fakeCli({ stdout: "", stderr: "Error: Invalid API key · Please run /login", code: 1 });
    await expect(provider(login.runCli).generate(req)).rejects.toThrow(/setup-token/);
  });

  it("prompt de sistema longo vai por arquivo (limite da linha de comando no Windows)", async () => {
    let seen = "";
    const fake = fakeCli(async ({ args }) => {
      const file = flag(args, "--system-prompt-file")!;
      seen = readFileSync(file, "utf8");
      return { stdout: resultLine() };
    });
    const big = "FAQ ".repeat(5000);
    await provider(fake.runCli).generate({ ...req, system: big });
    const args = fake.calls[0]!.args;
    expect(args).not.toContain("--system-prompt");
    expect(seen).toBe(big);
    expect(existsSync(flag(args, "--system-prompt-file")!)).toBe(false); // apagado depois
  });

  it("no máximo CLAUDE_CODE_MAX_CONCURRENCY processos ao mesmo tempo", async () => {
    let active = 0;
    let peak = 0;
    const slow = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { stdout: resultLine() };
    };
    const fake = fakeCli(slow, slow, slow, slow, slow);
    const ai = provider(fake.runCli, { maxConcurrency: 2 });
    await Promise.all(Array.from({ length: 5 }, () => ai.generate(req)));
    expect(fake.calls).toHaveLength(5);
    expect(peak).toBe(2);
  });
});

describe("ClaudeCodeProvider — amostras, tempo por pedido e limite do plano", () => {
  const siteSchema = z.object({ title: z.string(), html: z.string(), caption: z.string(), notes: z.string() });
  const siteOut = { title: "Demo", html: `<html><body>${"x".repeat(60_000)}</body></html>`, caption: "Oi!", notes: "" };
  const sampleReq = { task: "sample_site" as const, system: "Crie o site.", prompt: "Padaria", schema: siteSchema };

  it("honra req.timeoutMs no generate", async () => {
    const fake = fakeCli({ stdout: resultLine() });
    await provider(fake.runCli, { timeoutMs: 5000 }).generate({ ...req, timeoutMs: 600_000 });
    expect(fake.calls[0]!.opts.timeoutMs).toBe(600_000);
  });

  it("amostras: modelo próprio, teto de saída maior e saída grande (60 KB) lida do structured_output", async () => {
    const fake = fakeCli({ stdout: resultLine({ structured_output: siteOut }) }, { stdout: resultLine() });
    const ai = provider(fake.runCli, { sampleModel: "opus" });
    expect(ai.model).toBe("claude-code:sonnet (assinatura; amostras: opus)");
    const out = await ai.generate({ ...sampleReq, effort: "medium", timeoutMs: 600_000 });
    expect(out.html.length).toBeGreaterThan(60_000);
    expect(flag(fake.calls[0]!.args, "--model")).toBe("opus");
    expect(flag(fake.calls[0]!.args, "--effort")).toBe("medium");
    expect(fake.calls[0]!.opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("32000");
    expect(fake.calls[0]!.opts.timeoutMs).toBe(600_000);
    // As respostas do bot continuam no modelo normal, sem mexer no teto de saída
    await ai.generate(req);
    expect(flag(fake.calls[1]!.args, "--model")).toBe("sonnet");
    expect(fake.calls[1]!.opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  it("amostras: CLAUDE_CODE_MAX_OUTPUT_TOKENS do .env é respeitado", async () => {
    const fake = fakeCli({ stdout: resultLine({ structured_output: siteOut }) });
    await provider(fake.runCli, { env: { PATH: "/usr/bin", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000" } }).generate(sampleReq);
    expect(fake.calls[0]!.opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("64000");
  });

  it("amostras têm vaga própria: não ocupam as vagas do bot", async () => {
    let releaseSample: () => void = () => {};
    const fake = fakeCli(
      () => new Promise((resolve) => (releaseSample = () => resolve({ stdout: resultLine({ structured_output: siteOut }) }))),
      { stdout: resultLine() },
    );
    const ai = provider(fake.runCli, { maxConcurrency: 1 });
    const sample = ai.generate(sampleReq);
    await new Promise((r) => setTimeout(r, 5));
    expect(await ai.generate(req)).toEqual({ reply: "Oi!", handoff: false, handoffReason: "" });
    releaseSample();
    expect((await sample).title).toBe("Demo");
  });

  it("'You've hit your session limit · resets 11pm (America/Sao_Paulo)' → limite com a hora em pt-BR", async () => {
    // NOW = 12:00 UTC = 09:00 em São Paulo → libera em 14 h
    const fake = fakeCli({
      stdout: resultLine({
        is_error: true,
        api_error_status: 429,
        structured_output: null,
        result: "You've hit your session limit · resets 11pm (America/Sao_Paulo)",
      }),
    });
    const err = await provider(fake.runCli).generate(sampleReq).catch((e) => e);
    expect(err).toBeInstanceOf(AiRateLimitError);
    expect(err.daily).toBe(true);
    expect(err.retryAfterMs).toBe(14 * 3_600_000);
    expect(err.message).toBe("Limite de uso da sua assinatura do Claude atingido (Claude Code). Libera às 23h (America/Sao_Paulo).");
  });

  it("limite semanal e usage_limit_reached também são limite do plano", async () => {
    const weekly = fakeCli({
      stdout: resultLine({ is_error: true, structured_output: null, result: "You've hit your weekly limit · resets Oct 12, 9am (America/Sao_Paulo)" }),
    });
    const err = await provider(weekly.runCli).generate(req).catch((e) => e);
    expect(err.daily).toBe(true);
    expect(err.retryAfterMs).toBe(48 * 3_600_000);
    expect(err.message).toMatch(/Libera em 12\/10 às 9h \(America\/Sao_Paulo\)\.$/);

    const apiError = fakeCli({
      stdout: resultLine({ is_error: true, api_error_status: 429, structured_output: null, result: "API Error: usage_limit_reached" }),
    });
    const err2 = await provider(apiError.runCli).generate(req).catch((e) => e);
    expect(err2).toBeInstanceOf(AiRateLimitError);
    expect(err2.daily).toBe(true);
    expect(err2.retryAfterMs).toBeNull();
    expect(err2.message).toMatch(/algumas horas/);

    // Só texto no stdout (o CLI caiu sem JSON)
    const plain = fakeCli({ stdout: "You've hit your usage limit · resets 3:30am", code: 1 });
    const err3 = await provider(plain.runCli).generate(req).catch((e) => e);
    expect(err3).toBeInstanceOf(AiRateLimitError);
    expect(err3.retryAfterMs).toBe(18.5 * 3_600_000);
    expect(err3.message).toMatch(/Libera às 3h30\.$/);
  });

  it("parseResetTime e formatResetEpoch", () => {
    expect(parseResetTime("resets 12am (America/Sao_Paulo)", NOW)).toEqual({ label: "às 0h (America/Sao_Paulo)", retryAfterMs: 15 * 3_600_000 });
    expect(parseResetTime("resets 12pm", NOW)).toEqual({ label: "às 12h", retryAfterMs: 3 * 3_600_000 });
    expect(parseResetTime("resets Oct 12", NOW)).toEqual({ label: "em 12/10", retryAfterMs: null });
    expect(parseResetTime("resets 11pm (Fuso/Inexistente)", NOW)).toEqual({ label: "às 23h (Fuso/Inexistente)", retryAfterMs: null });
    expect(parseResetTime("sem hora nenhuma", NOW)).toBeNull();
    expect(formatResetEpoch(NOW + 2 * 3_600_000, NOW)).toBe("às 11h");
    expect(formatResetEpoch(NOW + 20 * 3_600_000, NOW)).toBe("em 11/10 às 5h");
  });
});

/** Linhas do stream-json reais (2.1.296), simplificadas. */
const streamLines = (result: Record<string, unknown> = {}) => [
  JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput", "WebFetch", "WebSearch"], permissionMode: "dontAsk" }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { query: "padaria Campinas telefone" } }] },
  }),
  JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1792062000 } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking" }] } }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t2", name: "WebFetch", input: { url: "https://guia.example/padaria-real", prompt: "telefone?" } }] },
  }),
  // A mesma mensagem pode reaparecer: não conta duas vezes
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t2", name: "WebFetch", input: { url: "https://guia.example/padaria-real" } }] },
  }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t3", name: "StructuredOutput", input: prospectOut } ] },
  }),
  resultLine({ structured_output: prospectOut, num_turns: 4, ...result }),
];

const prospectOut = {
  prospects: [{ company: "Padaria Real", phone: "(19) 3245-8830", sources: ["https://guia.example/padaria-real"] }],
  notes: "",
};
const prospectSchema = z.object({
  prospects: z.array(z.object({ company: z.string(), phone: z.string(), sources: z.array(z.string()) })),
  notes: z.string(),
});
const researchReq = { task: "prospect" as const, system: "Pesquise.", prompt: "1 padaria em Campinas", schema: prospectSchema };

/** Executor que entrega as linhas por onLine, como o de verdade. */
const streaming = (lines: string[]) => async ({ opts }: Call) => {
  for (const l of lines) opts.onLine?.(l);
  return { stdout: `${lines.join("\n")}\n` };
};

describe("ClaudeCodeProvider — research", () => {
  it("usa WebSearch/WebFetch sem pedir permissão, stream-json e conta o andamento", async () => {
    const fake = fakeCli(streaming(streamLines()));
    const ai = provider(fake.runCli, { researchModel: "opus" });
    const progress: ResearchProgress[] = [];
    const out = await ai.research({ ...researchReq, onProgress: (p) => progress.push(p) });

    expect(out).toEqual(prospectOut);
    expect(ai.model).toBe("claude-code:sonnet (assinatura; pesquisa: opus)");
    const { args, stdin, opts } = fake.calls[0]!;
    expect(args).not.toContain("--bare");
    expect(flag(args, "--model")).toBe("opus");
    expect(flag(args, "--effort")).toBe("medium");
    expect(flag(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(flag(args, "--tools")).toBe("WebSearch,WebFetch");
    expect(flag(args, "--allowedTools")).toBe("WebSearch,WebFetch");
    expect(flag(args, "--permission-mode")).toBe("dontAsk");
    expect(flag(args, "--setting-sources")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(stdin).toBe("1 padaria em Campinas");
    expect(opts.timeoutMs).toBe(15 * 60_000);
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(progress).toEqual([
      { searches: 1, fetches: 0, lastAction: "padaria Campinas telefone" },
      { searches: 1, fetches: 1, lastAction: "https://guia.example/padaria-real" },
    ]);
  });

  it("lê o stdout no fim se as linhas não vieram por onLine; usa a ferramenta StructuredOutput como reserva", async () => {
    const lines = streamLines({ structured_output: undefined, result: "" });
    const fake = fakeCli({ stdout: lines.join("\n") });
    expect(await provider(fake.runCli).research({ ...researchReq, timeoutMs: 1000 })).toEqual(prospectOut);
    expect(fake.calls[0]!.opts.timeoutMs).toBe(1000);
  });

  it("limite do plano avisado no stream vira limite diário com a hora de liberação", async () => {
    const reset = Math.floor(NOW / 1000) + 7200;
    const lines = [
      JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset, rateLimitType: "five_hour" } }),
      resultLine({ is_error: true, structured_output: null, result: "Limite atingido" }),
    ];
    const err = await provider(fakeCli(streaming(lines)).runCli).research(researchReq).catch((e) => e);
    expect(err).toBeInstanceOf(AiRateLimitError);
    expect(err.daily).toBe(true);
    expect(err.retryAfterMs).toBe(7_200_000);
    expect(err.message).toMatch(/Libera às 11h\.$/); // 12:00 UTC + 2 h = 11h em São Paulo
  });

  it("sem linha de resultado: erro claro", async () => {
    const fake = fakeCli({ stdout: streamLines().slice(0, 3).join("\n"), stderr: "caiu", code: 1 });
    await expect(provider(fake.runCli).research(researchReq)).rejects.toThrow(/não devolveu uma resposta válida.*caiu/);
  });

  it("cancelar encerra a pesquisa com AiError('Pesquisa cancelada.')", async () => {
    const controller = new AbortController();
    const fake = fakeCli(
      ({ opts }) =>
        new Promise((_, reject) => {
          opts.signal!.addEventListener("abort", () => reject(new CliAbortError()));
        }),
    );
    const running = provider(fake.runCli).research({ ...researchReq, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const err = await running.catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.message).toBe("Pesquisa cancelada.");

    // Já cancelada antes de começar: nem chama o CLI
    const idle = fakeCli();
    await expect(provider(idle.runCli).research({ ...researchReq, signal: AbortSignal.abort() })).rejects.toThrow("Pesquisa cancelada.");
    expect(idle.calls).toHaveLength(0);
  });

  it("tempo esgotado da pesquisa", async () => {
    const err = await provider(fakeCli(new CliTimeoutError(900_000)).runCli).research(researchReq).catch((e) => e);
    expect(err.message).toMatch(/não respondeu em 900 s na tarefa "prospect"/);
  });

  it("a pesquisa tem vaga própria: não espera as respostas do bot", async () => {
    let releaseBot = () => {};
    const botBlocked = new Promise<void>((r) => (releaseBot = r));
    const hold = async () => {
      await botBlocked;
      return { stdout: resultLine() };
    };
    const fake = fakeCli(hold, streaming(streamLines()), hold);
    const ai = provider(fake.runCli, { maxConcurrency: 1 });
    const bot = ai.generate(req);
    const research = ai.research(researchReq); // vaga da pesquisa
    const queued = ai.generate(req); // espera a vaga do bot
    expect(await research).toEqual(prospectOut);
    expect(fake.calls).toHaveLength(2);
    releaseBot();
    await Promise.all([bot, queued]);
    expect(fake.calls).toHaveLength(3);
  });
});

describe("Claude Code — utilitários", () => {
  it("acha o claude.exe no Windows (o claude.cmd do npm não roda sem shell)", () => {
    const env = { APPDATA: "C:\\Users\\Ana\\AppData\\Roaming", USERPROFILE: "C:\\Users\\Ana" };
    const npmExe = "C:\\Users\\Ana\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    const nativeExe = "C:\\Users\\Ana\\.local\\bin\\claude.exe";
    expect(resolveClaudeCommand("", env, "win32", (p) => p === npmExe)).toBe(npmExe);
    expect(resolveClaudeCommand("", env, "win32", (p) => p === nativeExe)).toBe(nativeExe);
    expect(resolveClaudeCommand("", env, "win32", () => false)).toBe("claude.exe");
    expect(resolveClaudeCommand("C:\\Users\\Ana\\AppData\\Roaming\\npm\\claude.cmd", env, "win32", (p) => p === npmExe)).toBe(npmExe);
    expect(resolveClaudeCommand("D:\\tools\\claude.exe", env, "win32", () => true)).toBe("D:\\tools\\claude.exe");
    expect(resolveClaudeCommand("", env, "linux")).toBe("claude");
    expect(resolveClaudeCommand("/opt/claude", env, "linux")).toBe("/opt/claude");
  });

  it("ambiente do filho: tira chaves de API (sem diferenciar maiúsculas) e as variáveis do CRM", () => {
    const env = claudeCodeEnv(
      { Path: "C:\\bin", anthropic_api_key: "x", CLAUDE_CODE_MODEL: "opus", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_CODE_OAUTH_TOKEN: "" },
      "",
    );
    expect(env).toEqual({ Path: "C:\\bin", CLAUDE_CONFIG_DIR: "/cfg", DISABLE_AUTOUPDATER: "1" });
  });

  it("acha a linha de resultado no meio de outras saídas", () => {
    expect(parseResultMessage(`aviso qualquer\n${resultLine()}\n`)?.structured_output).toBeTruthy();
    expect(parseResultMessage("nada aqui")).toBeNull();
    expect(parseResultMessage('{"type":"system"}')).toBeNull();
  });

  it("Semaphore: cancelar enquanto espera tira da fila", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const controller = new AbortController();
    const waiting = sem.acquire(controller.signal);
    expect(sem.pending).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(CliAbortError);
    expect(sem.pending).toBe(0);
    release();
    release(); // liberar duas vezes não abre vaga extra
    const a = await sem.acquire();
    let gotB = false;
    const b = sem.acquire().then((r) => {
      gotB = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(gotB).toBe(false);
    a();
    (await b)();
  });
});

describe("spawnCliRunner (processo de verdade, com o node no lugar do claude)", () => {
  const node = spawnCliRunner(process.execPath);
  const opts = (extra: Partial<CliRunOptions> = {}): CliRunOptions => ({ env: process.env, cwd: os.tmpdir(), timeoutMs: 10_000, ...extra });

  it("passa argumentos com aspas, JSON e acentos intactos; lê stdin e entrega linha a linha", async () => {
    const lines: string[] = [];
    const tricky = '{"a":"b c","d":["é \\"x\\""]}';
    const res = await node(
      ["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.stringify(process.argv.slice(1)));console.log(s.toUpperCase())})", tricky, ""],
      "olá mundo",
      opts({ onLine: (l) => lines.push(l) }),
    );
    expect(res.code).toBe(0);
    expect(JSON.parse(lines[0]!)).toEqual([tricky, ""]);
    expect(lines[1]).toBe("OLÁ MUNDO");
    expect(res.stdout).toContain("OLÁ MUNDO");
  });

  it("encerra o processo no tempo limite e ao cancelar", async () => {
    const hang = ["-e", "setTimeout(() => {}, 60000)"];
    await expect(node(hang, "", opts({ timeoutMs: 200 }))).rejects.toBeInstanceOf(CliTimeoutError);
    const controller = new AbortController();
    const running = node(hang, "", opts({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toBeInstanceOf(CliAbortError);
  });

  it("executável inexistente → ENOENT", async () => {
    const err = await spawnCliRunner(path.join(os.tmpdir(), "nao-existe-claude-xyz"))([], "", opts()).catch((e) => e);
    expect(err.code).toBe("ENOENT");
  });
});
