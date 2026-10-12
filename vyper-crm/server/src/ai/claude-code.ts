import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import { AiError, AiRateLimitError, AiRefusalError } from "./errors.js";
import { extractJson, toStrictJsonSchema } from "./openrouter.js";
import type { AiProvider, Effort, ResearchProgress, ResearchRequest, StructuredRequest } from "./provider.js";

/**
 * Claude Code (CLI "claude") como IA: usa a assinatura do Claude (Pro/Max) do usuário, sem chave de API.
 *
 * Cada pedido roda "claude -p" isolado — sem ferramentas, MCP, configurações, CLAUDE.md nem sessão salva —
 * para gastar só o necessário (~1k tokens em cache em vez de ~170k com o ambiente completo do usuário).
 * Nunca usar --bare: nesse modo o CLI ignora o login da assinatura e só aceita ANTHROPIC_API_KEY.
 * O prompt vai pela entrada padrão; a resposta vem em JSON no stdout (structured_output).
 */

export interface CliRunOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Recebe cada linha do stdout assim que chega (stream-json) */
  onLine?: (line: string) => void;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type CliRunner = (args: string[], stdin: string, opts: CliRunOptions) => Promise<CliRunResult>;

/** O processo passou do tempo e foi encerrado. */
export class CliTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`tempo esgotado (${timeoutMs} ms)`);
  }
}

/** O pedido foi cancelado (AbortSignal) e o processo foi encerrado. */
export class CliAbortError extends Error {
  constructor() {
    super("cancelado");
  }
}

// Processos em andamento: encerrados junto com o servidor (senão uma pesquisa longa ficaria órfã)
const running = new Set<ChildProcess>();

/** Encerra todos os processos do Claude Code em andamento (desligamento do servidor). */
export function killClaudeCodeProcesses(): void {
  for (const child of running) child.kill();
  running.clear();
}

const STDERR_MAX = 16_000;

/** Executa o CLI de verdade (spawn sem shell: argumentos com JSON e quebras de linha passam intactos). */
export function spawnCliRunner(command: string): CliRunner {
  return (args, stdin, opts) =>
    new Promise<CliRunResult>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new CliAbortError());
      let child: ChildProcess;
      try {
        child = spawn(command, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: "pipe" });
      } catch (err) {
        return reject(err);
      }
      running.add(child);
      let stdout = "";
      let stderr = "";
      let pending = "";
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const emitLine = (line: string) => {
        if (!opts.onLine || !line.trim()) return;
        try {
          opts.onLine(line.trim());
        } catch {
          /* o andamento é só informativo */
        }
      };
      const kill = () => {
        child.kill();
        // Se não sair por bem em 5 s, sai à força
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        killTimer.unref();
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const timer = setTimeout(() => {
        kill();
        finish(() => reject(new CliTimeoutError(opts.timeoutMs)));
      }, opts.timeoutMs);
      timer.unref();
      const onAbort = () => {
        kill();
        finish(() => reject(new CliAbortError()));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        if (!opts.onLine) return;
        pending += chunk;
        let i: number;
        while ((i = pending.indexOf("\n")) >= 0) {
          emitLine(pending.slice(0, i));
          pending = pending.slice(i + 1);
        }
      });
      child.stderr!.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_MAX);
      });
      child.on("error", (err) => {
        running.delete(child);
        finish(() => reject(err));
      });
      child.on("close", (code) => {
        running.delete(child);
        if (killTimer) clearTimeout(killTimer);
        emitLine(pending);
        pending = "";
        finish(() => resolve({ stdout, stderr, code }));
      });
      // EPIPE se o processo morrer antes de ler a entrada: o erro de verdade chega pelo "close"/"error"
      child.stdin!.on("error", () => {});
      child.stdin!.end(stdin, "utf8");
    });
}

/**
 * Onde está o executável. No Windows o "claude" do npm é um .cmd, que não roda sem shell — então
 * procuramos o claude.exe que ele chama (instalação via npm ou instalador nativo).
 */
export function resolveClaudeCommand(
  override: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string {
  const npmExe = (npmDir: string) => path.win32.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  if (override) {
    // CLAUDE_CODE_PATH apontando para o claude.cmd: usa o .exe ao lado
    if (platform === "win32" && /\.cmd$/i.test(override)) {
      const exe = npmExe(path.win32.dirname(override));
      if (exists(exe)) return exe;
    }
    return override;
  }
  if (platform !== "win32") return "claude";
  const candidates = [
    env.APPDATA ? npmExe(path.win32.join(env.APPDATA, "npm")) : "",
    env.USERPROFILE ? path.win32.join(env.USERPROFILE, ".local", "bin", "claude.exe") : "",
  ].filter(Boolean);
  return candidates.find((c) => exists(c)) ?? "claude.exe";
}

// Variáveis que não podem chegar ao CLI: com uma chave de API ele deixaria de usar a assinatura; as de
// sessão vêm de quando o CRM é iniciado de dentro de outro Claude Code; as CLAUDE_CODE_* do CRM são nossas.
const STRIPPED_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_MODEL",
  "CLAUDE_CODE_RESEARCH_MODEL",
  "CLAUDE_CODE_SAMPLE_MODEL",
  "CLAUDE_CODE_ENABLED",
  "CLAUDE_CODE_PATH",
  "CLAUDE_CODE_TIMEOUT_MS",
  "CLAUDE_CODE_MAX_CONCURRENCY",
]);

/** Ambiente do processo filho: o do servidor, sem as variáveis acima, com o token da assinatura (Docker). */
export function claudeCodeEnv(base: NodeJS.ProcessEnv, oauthToken = ""): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // No Windows os nomes não diferenciam maiúsculas: compara em maiúsculas
  for (const [k, v] of Object.entries(base)) if (!STRIPPED_ENV.has(k.toUpperCase())) env[k] = v;
  env.DISABLE_AUTOUPDATER = "1";
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  // Vazio (copiado do .env.example) não pode esconder o login feito com /login
  else if (!env.CLAUDE_CODE_OAUTH_TOKEN) delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

/** Fila simples: no máximo N processos ao mesmo tempo. */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get pending(): number {
    return this.queue.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new CliAbortError();
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          this.queue = this.queue.filter((q) => q !== go);
          reject(new CliAbortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.queue.push(go);
      });
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      // A vaga passa direto para o próximo da fila (active não muda)
      if (next) next();
      else this.active--;
    };
  }
}

/** Linha final do CLI (--output-format json, ou a última linha do stream-json). */
interface CliResultMessage {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: number | null;
  result?: string;
  structured_output?: unknown;
  stop_reason?: string | null;
  errors?: unknown;
}

const AUTH_HELP =
  "O Claude Code não está logado na sua assinatura do Claude. No computador: rode \"claude\" no terminal e faça /login. " +
  "No Docker: rode \"claude setup-token\" no seu computador, coloque o token em CLAUDE_CODE_OAUTH_TOKEN no .env e reinicie o CRM.";

// Limites do plano (janela de 5 horas, semanal): só passam com o tempo
const PLAN_LIMIT =
  /usage[ _]limit|limit[ _]reached|hit your (usage |session |weekly )?limit|5-hour|five[- _]hour|weekly|seven[_ ]day|session limit|out of (extra )?usage/i;
const RATE_LIMIT = /rate.?limit|too many requests|overloaded/i;
const AUTH_ERROR =
  /not logged in|please run \/login|\/login|invalid api key|authenticat|unauthori[sz]ed|oauth|token (has )?(expired|revoked)|credential|forbidden/i;
const PLAN_LIMIT_MESSAGE = "Limite de uso da sua assinatura do Claude atingido (Claude Code). Ele libera sozinho em algumas horas.";
const planLimitMessage = (when: string | null) =>
  when ? `Limite de uso da sua assinatura do Claude atingido (Claude Code). Libera ${when}.` : PLAN_LIMIT_MESSAGE;
const REFUSAL = /violates? (our|the) usage polic|unable to respond to this request/i;

export interface ClaudeCodeOptions {
  /** Alias (sonnet, opus, haiku) ou nome completo do modelo */
  model?: string;
  /** Modelo da pesquisa na web (padrão: o mesmo de model) */
  researchModel?: string;
  /** Modelo das amostras — site demo e arte (padrão: o mesmo de model) */
  sampleModel?: string;
  /** Fuso para mostrar a hora em que o limite do plano libera (padrão America/Sao_Paulo) */
  timeZone?: string;
  /** Executável (padrão: resolveClaudeCommand) */
  command?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  oauthToken?: string;
  /** Pasta vazia onde o CLI roda (nenhum CLAUDE.md ou configuração de projeto é lido) */
  workdir?: string;
  /** Ambiente base do processo filho (padrão: process.env) */
  env?: NodeJS.ProcessEnv;
  /** Para testes: substitui a execução do CLI */
  runCli?: CliRunner;
  now?: () => number;
  /** Acima disso o prompt de sistema vai por arquivo (padrão: 8000 caracteres) */
  systemPromptArgMax?: number;
}

const DEFAULT_RESEARCH_TIMEOUT_MS = 15 * 60_000;
// Amostras (uma página HTML inteira ou um SVG detalhado) passam fácil de 20 mil tokens de saída
const SAMPLE_MAX_OUTPUT_TOKENS = "32000";
const isSampleTask = (task: string) => task === "sample_site" || task === "sample_image";

export class ClaudeCodeProvider implements AiProvider {
  readonly enabled = true;
  readonly provider = "claude-code";
  readonly command: string;
  private readonly modelName: string;
  private readonly researchModel: string;
  private readonly sampleModel: string;
  private readonly timeZone: string;
  private readonly timeoutMs: number;
  private readonly oauthToken: string;
  private readonly workdir: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly runCli: CliRunner;
  private readonly now: () => number;
  private readonly systemPromptArgMax: number;
  // Respostas do dia a dia (bot, qualificação, copiloto) disputam estas vagas...
  private readonly slots: Semaphore;
  // ...e a pesquisa na web (minutos) tem uma vaga própria, para não travar o bot nem ficar presa atrás dele
  private readonly researchSlots = new Semaphore(1);
  // ...assim como as amostras (site/arte levam minutos)
  private readonly sampleSlots = new Semaphore(1);

  constructor(opts: ClaudeCodeOptions = {}) {
    this.modelName = opts.model?.trim() || "sonnet";
    this.researchModel = opts.researchModel?.trim() || this.modelName;
    this.sampleModel = opts.sampleModel?.trim() || this.modelName;
    this.timeZone = opts.timeZone?.trim() || "America/Sao_Paulo";
    this.command = opts.command || resolveClaudeCommand("");
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.oauthToken = opts.oauthToken ?? "";
    this.workdir = opts.workdir ?? path.join(os.tmpdir(), "vyper-crm-claude");
    this.baseEnv = opts.env ?? process.env;
    this.runCli = opts.runCli ?? spawnCliRunner(this.command);
    this.now = opts.now ?? Date.now;
    this.slots = new Semaphore(Math.max(1, opts.maxConcurrency ?? 2));
    this.systemPromptArgMax = opts.systemPromptArgMax ?? 8000;
  }

  get model(): string {
    const research = this.researchModel !== this.modelName ? `; pesquisa: ${this.researchModel}` : "";
    const sample = this.sampleModel !== this.modelName ? `; amostras: ${this.sampleModel}` : "";
    return `claude-code:${this.modelName} (assinatura${research}${sample})`;
  }

  async generate<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const sample = isSampleTask(req.task);
    const release = await (sample ? this.sampleSlots : this.slots).acquire();
    let system: { args: string[]; cleanup: () => void } | undefined;
    let run: CliRunResult;
    try {
      system = this.systemPromptArgs(req.system);
      const args = [
        ...this.baseArgs(sample ? this.sampleModel : this.modelName, req.effort ?? "low", system.args, req.schema),
        "--output-format",
        "json",
        "--tools",
        "",
      ];
      const opts = this.runOptions(req.timeoutMs ?? this.timeoutMs);
      // Saída longa (página inteira): sobe o teto de tokens de saída, a menos que o .env já defina outro
      if (sample && !opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = SAMPLE_MAX_OUTPUT_TOKENS;
      run = await this.runCli(args, req.prompt, opts);
    } catch (err) {
      throw this.runError(err, req.task);
    } finally {
      system?.cleanup();
      release();
    }
    const result = parseResultMessage(run.stdout);
    if (!result) throw this.invalidOutput(run, req.task);
    return this.toOutput(result, req);
  }

  /**
   * Pesquisa com WebSearch/WebFetch do próprio Claude Code. Usa stream-json para acompanhar as buscas
   * enquanto acontecem (onProgress); a última linha traz o mesmo resultado do modo json.
   */
  async research<T extends z.ZodType>(req: ResearchRequest<T>): Promise<z.infer<T>> {
    const progress: ResearchProgress = { searches: 0, fetches: 0 };
    const seen = new Set<string>();
    let result: CliResultMessage | null = null;
    // Reserva: a resposta estruturada também aparece como chamada da ferramenta interna StructuredOutput
    let structuredFromTool: unknown;
    // O stream avisa quando o plano bloqueou o pedido (status "rejected") e quando libera
    let limitResetsAt: number | null = null;

    const onLine = (line: string) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg?.type === "result") {
        result = msg;
        return;
      }
      if (msg?.type === "rate_limit_event" && msg.rate_limit_info?.status === "rejected") {
        const at = Number(msg.rate_limit_info.resetsAt);
        limitResetsAt = Number.isFinite(at) && at > 0 ? at : 0;
        return;
      }
      if (msg?.type !== "assistant" || !Array.isArray(msg.message?.content)) return;
      let changed = false;
      for (const block of msg.message.content) {
        if (block?.type !== "tool_use" && block?.type !== "server_tool_use") continue;
        if (block.id && seen.has(block.id)) continue;
        if (block.id) seen.add(block.id);
        const input = block.input ?? {};
        if (block.name === "WebSearch" || block.name === "web_search") {
          progress.searches++;
          if (typeof input.query === "string") progress.lastAction = input.query.slice(0, 200);
          changed = true;
        } else if (block.name === "WebFetch" || block.name === "web_fetch") {
          progress.fetches++;
          if (typeof input.url === "string") progress.lastAction = input.url.slice(0, 300);
          changed = true;
        } else if (block.name === "StructuredOutput") {
          structuredFromTool = input;
        }
      }
      if (changed && req.onProgress) {
        try {
          req.onProgress({ ...progress });
        } catch {
          /* o andamento é só informativo */
        }
      }
    };

    let release: (() => void) | undefined;
    let system: { args: string[]; cleanup: () => void } | undefined;
    let run: CliRunResult;
    try {
      release = await this.researchSlots.acquire(req.signal);
      system = this.systemPromptArgs(req.system);
      const args = [
        ...this.baseArgs(this.researchModel, req.effort ?? "medium", system.args, req.schema),
        "--output-format",
        "stream-json",
        "--verbose",
        "--tools",
        "WebSearch,WebFetch",
        "--allowedTools",
        "WebSearch,WebFetch",
        "--permission-mode",
        "dontAsk",
      ];
      run = await this.runCli(args, req.prompt, {
        ...this.runOptions(req.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS),
        signal: req.signal,
        onLine,
      });
    } catch (err) {
      throw this.runError(err, req.task);
    } finally {
      system?.cleanup();
      release?.();
    }
    // Se o executor não passou as linhas por onLine, lê tudo no fim
    if (!result) for (const line of run.stdout.split(/\r?\n/)) onLine(line);
    const final = result as CliResultMessage | null;
    if (!final) throw this.invalidOutput(run, req.task);
    if (final.structured_output == null && structuredFromTool !== undefined && !isFailure(final)) {
      final.structured_output = structuredFromTool;
    }
    return this.toOutput(final, req, limitResetsAt);
  }

  /** Flags comuns: isolamento total do ambiente do usuário (ver comentário da classe). */
  private baseArgs(model: string, effort: Effort, systemArgs: string[], schema: z.ZodType): string[] {
    return [
      "-p",
      "--model",
      model,
      "--effort",
      effort,
      ...systemArgs,
      "--json-schema",
      JSON.stringify(toStrictJsonSchema(schema)),
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--no-session-persistence",
    ];
  }

  /**
   * Prompt de sistema grande (FAQ e produtos longos) vai por arquivo: no Windows a linha de comando
   * inteira tem limite de ~32 mil caracteres.
   */
  private systemPromptArgs(system: string): { args: string[]; cleanup: () => void } {
    if (system.length <= this.systemPromptArgMax) return { args: ["--system-prompt", system], cleanup: () => {} };
    const dir = path.join(this.workdir, "prompts");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `system-${randomUUID()}.txt`);
    writeFileSync(file, system, "utf8");
    return { args: ["--system-prompt-file", file], cleanup: () => rmSync(file, { force: true }) };
  }

  private runOptions(timeoutMs: number): CliRunOptions {
    mkdirSync(this.workdir, { recursive: true });
    return { env: claudeCodeEnv(this.baseEnv, this.oauthToken), cwd: this.workdir, timeoutMs };
  }

  /** limitResetsAt: o stream avisou que o plano bloqueou o pedido (epoch em segundos da liberação; 0 = sem data). */
  private toOutput<T extends z.ZodType>(res: CliResultMessage, req: StructuredRequest<T>, limitResetsAt: number | null = null): z.infer<T> {
    const text = describeResult(res);
    if (res.stop_reason === "refusal" || REFUSAL.test(text)) {
      throw new AiRefusalError(`A IA recusou a tarefa "${req.task}" (Claude Code).`);
    }
    if (isFailure(res)) {
      if (limitResetsAt !== null) {
        const parsed = limitResetsAt ? null : parseResetTime(text, this.now(), this.timeZone);
        throw new AiRateLimitError(
          planLimitMessage(limitResetsAt ? formatResetEpoch(limitResetsAt * 1000, this.now(), this.timeZone) : (parsed?.label ?? null)),
          {
            daily: true,
            retryAfterMs: limitResetsAt ? Math.max(0, limitResetsAt * 1000 - this.now()) : (parsed?.retryAfterMs ?? null),
          },
        );
      }
      throw this.classifyFailure(text, res.api_error_status ?? null, req.task, res.subtype);
    }
    let json = res.structured_output;
    if (json == null) {
      try {
        json = extractJson(res.result ?? "");
      } catch {
        throw new AiError(`A IA não devolveu um JSON válido na tarefa "${req.task}" (Claude Code).`);
      }
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) throw new AiError(`Resposta da IA fora do formato na tarefa "${req.task}": ${parsed.error.message}`);
    return parsed.data as z.infer<T>;
  }

  private classifyFailure(text: string, status: number | null, task: string, subtype?: string): Error {
    if (status === 429 || PLAN_LIMIT.test(text) || RATE_LIMIT.test(text) || status === 529) {
      const daily = PLAN_LIMIT.test(text);
      // Formato antigo do CLI: "Claude AI usage limit reached|<epoch em segundos da liberação>"
      const reset = text.match(/\|(\d{10})\b/);
      // Formato atual: "You've hit your session limit · resets 11pm (America/Sao_Paulo)"
      const parsed = reset ? null : parseResetTime(text, this.now(), this.timeZone);
      const retryAfterMs = reset ? Math.max(0, Number(reset[1]) * 1000 - this.now()) : (parsed?.retryAfterMs ?? null);
      const when = reset ? formatResetEpoch(Number(reset[1]) * 1000, this.now(), this.timeZone) : (parsed?.label ?? null);
      return new AiRateLimitError(
        daily
          ? planLimitMessage(when)
          : "Claude ocupado no momento (limite por minuto ou sobrecarga). Tente de novo em instantes.",
        { daily, retryAfterMs },
      );
    }
    if (status === 401 || status === 403 || AUTH_ERROR.test(text)) return new AiError(AUTH_HELP);
    if (subtype === "error_max_structured_output_retries") {
      return new AiError(`Resposta da IA fora do formato na tarefa "${task}" (Claude Code).`);
    }
    return new AiError(`O Claude Code falhou na tarefa "${task}": ${this.redact(text).slice(0, 300) || "sem detalhes"}`);
  }

  /** stdout sem o JSON esperado (o CLI caiu antes de responder). */
  private invalidOutput(run: CliRunResult, task: string): Error {
    // Só o texto solto: as linhas JSON do stream (ex.: rate_limit_event "allowed") não dizem por que caiu
    const plain = run.stdout
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("{"))
      .join("\n")
      .trim();
    const text = `${run.stderr}\n${plain}`;
    if (PLAN_LIMIT.test(text) || RATE_LIMIT.test(text) || AUTH_ERROR.test(text)) {
      return this.classifyFailure(text, null, task);
    }
    const tail = this.redact(run.stderr.trim() || plain).slice(-300);
    return new AiError(
      `O Claude Code não devolveu uma resposta válida na tarefa "${task}" (código ${run.code ?? "?"})${tail ? `: ${tail}` : "."}`,
    );
  }

  private runError(err: unknown, task: string): Error {
    return runErrorToAiError(err, task, this.command, (t) => this.redact(t));
  }

  /** Nada de token em mensagem de erro (elas vão para o log e para o painel). */
  private redact(text: string): string {
    let out = text.replace(/sk-ant-[\w-]+/g, "sk-ant-***").replace(/Bearer\s+\S+/gi, "Bearer ***");
    if (this.oauthToken) out = out.split(this.oauthToken).join("***");
    return out;
  }
}

/** Falha ao executar o processo (não achou, passou do tempo, cancelado) → erro para o usuário. */
function runErrorToAiError(err: unknown, task: string, command: string, redact: (t: string) => string = (t) => t): Error {
  if (err instanceof CliAbortError) return new AiError("Pesquisa cancelada.");
  if (err instanceof CliTimeoutError) {
    return new AiError(`O Claude Code não respondeu em ${Math.round(err.timeoutMs / 1000)} s na tarefa "${task}" e foi interrompido.`);
  }
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "EINVAL" || code === "EACCES") {
    return new AiError(
      `Claude Code não encontrado (${command}). Instale com "npm install -g @anthropic-ai/claude-code", faça login ` +
        `rodando "claude", ou aponte CLAUDE_CODE_PATH para o executável (no Windows, o claude.exe).`,
    );
  }
  return new AiError(`Falha ao rodar o Claude Code: ${redact(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, jun: 6, jul: 7,
  aug: 8, ago: 8, sep: 9, set: 9, oct: 10, out: 10, nov: 11, dec: 12, dez: 12,
};

/** Data/hora "de parede" (no fuso) como se fosse UTC — para fazer contas de dias e horas. */
function wallClock(ms: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; asUtc: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const [year, month, day, hour, minute, second] = ["year", "month", "day", "hour", "minute", "second"].map(get) as number[];
    if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
    return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, asUtc: Date.UTC(year!, month! - 1, day!, hour!, minute!, second || 0) };
  } catch {
    return null; // fuso inválido
  }
}

const hourLabel = (h: number, m: number) => `${h}h${m ? String(m).padStart(2, "0") : ""}`;
const dateLabel = (d: number, mo: number) => `${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}`;

/**
 * Lê a hora de liberação do texto do CLI: "resets 11pm (America/Sao_Paulo)", "resets 3:30am",
 * "resets Oct 12, 9am (America/Sao_Paulo)", "resets Oct 12". Devolve o texto em pt-BR ("às 23h (America/Sao_Paulo)")
 * e quanto falta (só quando há horário e o fuso é conhecido).
 */
export function parseResetTime(
  text: string,
  nowMs: number,
  defaultTimeZone = "America/Sao_Paulo",
): { label: string; retryAfterMs: number | null } | null {
  const m = text.match(
    /resets?\s+(?:at\s+|on\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:at\s+)?)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm))?\s*(?:\(([^)]+)\))?/i,
  );
  if (!m) return null;
  const [, monName, dayStr, hStr, minStr, ampm, tzRaw] = m;
  const month = monName ? MONTHS[monName.toLowerCase()] : undefined;
  const hasDate = month !== undefined && dayStr !== undefined;
  const hasTime = hStr !== undefined && ampm !== undefined;
  if (!hasDate && !hasTime) return null;

  let hour = 0;
  let minute = 0;
  if (hasTime) {
    hour = Number(hStr) % 12 + (ampm!.toLowerCase() === "pm" ? 12 : 0);
    minute = minStr ? Number(minStr) : 0;
    if (hour > 23 || minute > 59) return null;
  }
  const tz = tzRaw?.trim();
  const tzLabel = tz ? ` (${tz})` : "";
  const label = hasDate
    ? `em ${dateLabel(Number(dayStr), month!)}${hasTime ? ` às ${hourLabel(hour, minute)}` : ""}${tzLabel}`
    : `às ${hourLabel(hour, minute)}${tzLabel}`;
  if (!hasTime) return { label, retryAfterMs: null };

  const now = wallClock(nowMs, tz || defaultTimeZone);
  if (!now) return { label, retryAfterMs: null };
  let target: number;
  if (hasDate) {
    target = Date.UTC(now.year, month! - 1, Number(dayStr), hour, minute);
    // "Jan 2" visto em dezembro = ano que vem
    if (target < now.asUtc - 86_400_000) target = Date.UTC(now.year + 1, month! - 1, Number(dayStr), hour, minute);
  } else {
    target = Date.UTC(now.year, now.month - 1, now.day, hour, minute);
    if (target <= now.asUtc) target += 86_400_000;
  }
  return { label, retryAfterMs: Math.max(0, target - now.asUtc) };
}

/** Hora de liberação (epoch em ms) em pt-BR: "às 23h" no mesmo dia, senão "em 12/10 às 9h". */
export function formatResetEpoch(resetMs: number, nowMs: number, timeZone = "America/Sao_Paulo"): string | null {
  const at = wallClock(resetMs, timeZone);
  const now = wallClock(nowMs, timeZone);
  if (!at || !now) return null;
  const sameDay = at.year === now.year && at.month === now.month && at.day === now.day;
  return sameDay ? `às ${hourLabel(at.hour, at.minute)}` : `em ${dateLabel(at.day, at.month)} às ${hourLabel(at.hour, at.minute)}`;
}

function isFailure(res: CliResultMessage): boolean {
  return Boolean(res.is_error) || (res.subtype !== undefined && res.subtype !== "success") || Boolean(res.api_error_status);
}

function describeResult(res: CliResultMessage): string {
  const errors = Array.isArray(res.errors) ? res.errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))) : [];
  return [res.result ?? "", ...errors].join(" ").trim();
}

/** O JSON final: stdout inteiro (modo json) ou a última linha type:"result" (stream-json). */
export function parseResultMessage(stdout: string): CliResultMessage | null {
  const isResult = (v: unknown): v is CliResultMessage => Boolean(v) && typeof v === "object" && (v as CliResultMessage).type === "result";
  try {
    const whole = JSON.parse(stdout.trim());
    if (isResult(whole)) return whole;
  } catch {
    /* tenta linha a linha */
  }
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const v = JSON.parse(line);
      if (isResult(v)) return v;
    } catch {
      /* linha que não é JSON */
    }
  }
  return null;
}

/**
 * Confere se o Claude Code existe e responde (claude --version). Não gasta a assinatura.
 * Devolve a versão; lança AiError com a instrução de instalação se não achar.
 */
export async function checkClaudeCode(
  command: string,
  opts: { runCli?: CliRunner; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const runCli = opts.runCli ?? spawnCliRunner(command);
  const cwd = path.join(os.tmpdir(), "vyper-crm-claude");
  mkdirSync(cwd, { recursive: true });
  let run: CliRunResult;
  try {
    run = await runCli(["--version"], "", { env: claudeCodeEnv(opts.env ?? process.env), cwd, timeoutMs: opts.timeoutMs ?? 15_000 });
  } catch (err) {
    throw runErrorToAiError(err, "verificação", command);
  }
  const version = run.stdout.trim().split(/\r?\n/)[0] ?? "";
  if (run.code !== 0 || !version) throw new AiError(`O Claude Code não respondeu ao --version (código ${run.code ?? "?"}).`);
  return version;
}
