import { z } from "zod";
import { AiError, AiRateLimitError, AiRefusalError } from "./errors.js";
import type { AiProvider, StructuredRequest } from "./provider.js";

/**
 * OpenRouter (https://openrouter.ai): uma chave dá acesso a centenas de modelos, inclusive gratuitos.
 * O padrão "openrouter/free" escolhe um dos modelos gratuitos disponíveis no momento (eles entram e saem
 * da lista sem aviso, então fixar um só costuma quebrar).
 *
 * Modelos gratuitos variam muito na obediência ao formato, por isso:
 * - pedimos saída estruturada (json_schema strict) e, se o modelo não aceitar, caímos para json_object
 *   e depois para texto livre — o schema também vai no prompt;
 * - o plugin response-healing do OpenRouter conserta JSON malformado;
 * - a resposta é validada com Zod e, se vier fora do formato, pedimos uma correção (uma vez).
 */
export interface OpenRouterOptions {
  apiKey: string;
  /** Ex.: "openrouter/free" ou "nvidia/nemotron-3-super-120b-a12b:free" */
  model: string;
  /** Modelos de reserva que o próprio OpenRouter tenta se o principal falhar */
  fallbackModels?: string[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Espera máxima quando bate o limite por minuto (acima disso desiste na hora) */
  maxRateLimitWaitMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

class UnsupportedFormatError extends AiError {}

type Mode = "json_schema" | "json_object" | "none";
const MODES: Mode[] = ["json_schema", "json_object", "none"];

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  model?: string;
  error?: { code?: number; message?: string; metadata?: Record<string, unknown> };
  choices?: Array<{
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    error?: { code?: number; message?: string };
    message?: { content?: string | null; refusal?: string | null };
  }>;
}

const SAFE_INT = Number.MAX_SAFE_INTEGER;

/**
 * JSON Schema no formato do modo strict (estilo OpenAI): sem "$schema", objetos fechados
 * (additionalProperties: false) e sem os limites de inteiro "infinitos" que o Zod coloca.
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema") continue;
      if ((k === "minimum" || k === "maximum") && Math.abs(v as number) >= SAFE_INT) continue;
      out[k] = clean(v);
    }
    if (out.type === "object" && out.properties && typeof out.properties === "object") {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties);
    }
    return out;
  };
  return clean(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** Tira cercas de markdown e texto em volta: pega o primeiro objeto JSON da resposta. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* tenta o próximo */
    }
  }
  throw new SyntaxError("sem JSON válido");
}

export class OpenRouterProvider implements AiProvider {
  readonly enabled = true;
  readonly provider = "openrouter";
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;

  constructor(private opts: OpenRouterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  get model(): string {
    return this.opts.model;
  }

  async generate<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const schema = toStrictJsonSchema(req.schema);
    for (let i = 0; ; i++) {
      try {
        return await this.generateWith(req, schema, MODES[i]!);
      } catch (err) {
        // O modelo não aceita esse formato de saída: tenta o próximo, mais simples
        if (err instanceof UnsupportedFormatError && i < MODES.length - 1) continue;
        if (err instanceof UnsupportedFormatError) throw new AiError(err.message);
        throw err;
      }
    }
  }

  private async generateWith<T extends z.ZodType>(
    req: StructuredRequest<T>,
    schema: Record<string, unknown>,
    mode: Mode,
  ): Promise<z.infer<T>> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          `${req.system}\n\n` +
          "Responda SOMENTE com um objeto JSON válido que siga exatamente este JSON Schema " +
          `(sem markdown e sem texto fora do JSON):\n${JSON.stringify(schema)}`,
      },
      { role: "user", content: req.prompt },
    ];

    // Até 2 tentativas de conteúdo: a segunda mostra ao modelo o que veio errado
    for (let attempt = 0; attempt < 2; attempt++) {
      const content = await this.complete(req.task, messages, schema, mode);
      let problem: string;
      try {
        const parsed = req.schema.safeParse(extractJson(content));
        if (parsed.success) return parsed.data as z.infer<T>;
        problem = parsed.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`).join("; ");
      } catch {
        problem = "a resposta não é um JSON válido";
      }
      if (attempt === 1) throw new AiError(`Resposta da IA fora do formato na tarefa "${req.task}": ${problem}`);
      messages.push(
        { role: "assistant", content: content.slice(0, 4000) },
        { role: "user", content: `Sua resposta não seguiu o formato pedido (${problem}). Responda de novo, só com o JSON correto.` },
      );
    }
    throw new Error("inalcançável");
  }

  /** Uma chamada ao /chat/completions, com as novas tentativas de rede e de limite por minuto. */
  private async complete(task: string, messages: ChatMessage[], schema: Record<string, unknown>, mode: Mode): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      max_tokens: 8000,
      plugins: [{ id: "response-healing" }],
    };
    if (this.opts.fallbackModels?.length) body.models = [this.opts.model, ...this.opts.fallbackModels];
    if (mode === "json_schema") {
      body.response_format = { type: "json_schema", json_schema: { name: task, strict: true, schema } };
      // Só manda para provedores que aceitam saída estruturada
      body.provider = { require_parameters: true };
    } else if (mode === "json_object") {
      body.response_format = { type: "json_object" };
      body.provider = { require_parameters: true };
    }

    let rateLimitWaits = 0;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${(this.opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            "content-type": "application/json",
            // Identificação do app no OpenRouter (opcional)
            "http-referer": "https://github.com/VyperXt/VyperXt",
            "x-title": "Vyper CRM",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
        });
      } catch (err) {
        // Rede/timeout: tenta de novo algumas vezes
        if (attempt < 2) {
          await this.sleep(1000 * 3 ** attempt);
          continue;
        }
        throw new AiError(`OpenRouter fora do ar ou lento demais: ${(err as Error).message}`);
      }

      let data: ChatResponse = {};
      try {
        data = (await res.json()) as ChatResponse;
      } catch {
        /* corpo vazio ou HTML */
      }
      // O OpenRouter pode devolver 200 com erro no corpo (falha durante a geração)
      const error = data.error ?? data.choices?.[0]?.error;
      const status = !res.ok ? res.status : error ? (error.code ?? 502) : 200;

      if (status === 429) {
        // Sem dica de espera (comum quando o limite é do provedor do modelo gratuito): uma pausa curta
        // e nova tentativa — o openrouter/free pode escolher outro modelo
        const wait = this.rateLimitWait(res) ?? (rateLimitWaits === 0 ? 5_000 : null);
        if (wait !== null && wait <= (this.opts.maxRateLimitWaitMs ?? 20_000) && rateLimitWaits < 3) {
          rateLimitWaits++;
          await this.sleep(wait);
          continue;
        }
        const reset = this.resetTime(res);
        throw new AiRateLimitError(
          "Limite de uso do OpenRouter atingido (modelos gratuitos: 20 pedidos por minuto e 50 por dia; 1000 por dia " +
            `depois de comprar US$ 10 em créditos).${reset ? ` Libera por volta de ${reset}.` : ""}`,
        );
      }
      if (status !== 200) {
        const message = String(error?.message ?? `HTTP ${status}`);
        if (status === 401) throw new AiError("OPENROUTER_API_KEY inválida ou desativada.");
        if (status === 402) {
          throw new AiError("OpenRouter sem saldo: mesmo os modelos gratuitos param de responder com saldo negativo.");
        }
        if (/data policy|privacy|prompt training|publish prompts/i.test(message)) {
          throw new AiError(
            "Os modelos gratuitos do OpenRouter exigem liberar, em openrouter.ai/settings/privacy, o uso de provedores " +
              `gratuitos que podem guardar os prompts. Detalhe: ${message}`,
          );
        }
        if (status === 403) throw new AiRefusalError(`O OpenRouter bloqueou o pedido da tarefa "${task}": ${message}`);
        if ((status === 400 || status === 404) && mode !== "none") throw new UnsupportedFormatError(message);
        // Falhas passageiras do provedor: tenta de novo
        if ((status === 408 || status >= 500) && attempt < 2) {
          await this.sleep(1000 * 3 ** attempt);
          continue;
        }
        throw new AiError(`OpenRouter respondeu ${status} na tarefa "${task}": ${message}`);
      }

      const choice = data.choices?.[0];
      if (choice?.message?.refusal) throw new AiRefusalError(`A IA recusou a tarefa "${task}": ${choice.message.refusal}`);
      if (choice?.finish_reason === "content_filter") throw new AiRefusalError(`A IA recusou a tarefa "${task}" (filtro de conteúdo).`);
      if (choice?.finish_reason === "length") throw new AiError(`Resposta da IA cortada por limite de tokens na tarefa "${task}".`);
      return choice?.message?.content ?? "";
    }
  }

  /** Quanto esperar num 429 (Retry-After em segundos ou X-RateLimit-Reset em ms). null = não informado. */
  private rateLimitWait(res: Response): number | null {
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset - this.now());
    return null;
  }

  private resetTime(res: Response): string | null {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (!Number.isFinite(reset) || reset <= this.now()) return null;
    return new Date(reset).toISOString().slice(11, 16) + " UTC";
  }
}
