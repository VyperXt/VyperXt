import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { AiError, AiRefusalError, AiUnavailableError } from "./errors.js";
import { OpenRouterProvider } from "./openrouter.js";

export { AiError, AiRateLimitError, AiRefusalError, AiUnavailableError } from "./errors.js";

export type AiTask = "reply" | "qualify" | "copilot" | "copilot_ask" | "extract" | "followup";
export type Effort = "low" | "medium" | "high";

export interface StructuredRequest<T extends z.ZodType> {
  task: AiTask;
  system: string;
  prompt: string;
  schema: T;
  effort?: Effort;
}

export interface AiProvider {
  readonly enabled: boolean;
  /** Modelo (para mostrar nas configurações) */
  readonly model: string;
  generate<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>>;
}


// Modelos que aceitam o fallback automático do servidor quando o pedido é recusado
const SERVER_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
// Modelos antigos que não aceitam o parâmetro "effort"
const NO_EFFORT = /^claude-(3|haiku-4|sonnet-4-5|opus-4-1|opus-4-0|sonnet-4-0)/;

/** Claude (Anthropic) com saída estruturada validada por Zod. */
export class ClaudeProvider implements AiProvider {
  readonly enabled = true;
  private client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string,
    clientOptions: Omit<NonNullable<ConstructorParameters<typeof Anthropic>[0]>, "apiKey"> = {},
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 3, ...clientOptions });
  }

  async generate<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    // create() em vez de parse(): assim checamos recusa/corte ANTES de tentar ler o JSON
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      // O prompt de sistema (dados da empresa) é estável → fica em cache e sai mais barato
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.prompt }],
      output_config: {
        format: betaZodOutputFormat(req.schema),
        ...(NO_EFFORT.test(this.model) ? {} : { effort: req.effort ?? "low" }),
      },
      ...(SERVER_FALLBACK_MODELS.has(this.model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    });

    if (response.stop_reason === "refusal") {
      throw new AiRefusalError(`A IA recusou a tarefa "${req.task}" (${response.stop_details?.category ?? "sem categoria"}).`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new AiError(`Resposta da IA cortada por limite de tokens na tarefa "${req.task}".`);
    }
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AiError(`A IA não devolveu um JSON válido na tarefa "${req.task}".`);
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) throw new AiError(`Resposta da IA fora do formato na tarefa "${req.task}": ${parsed.error.message}`);
    return parsed.data as z.infer<T>;
  }
}

export class DisabledAi implements AiProvider {
  readonly enabled = false;
  readonly model = "";
  async generate<T extends z.ZodType>(): Promise<z.infer<T>> {
    throw new AiUnavailableError();
  }
}

/**
 * Usa a IA principal e, se ela falhar (limite de uso, fora do ar, resposta fora do formato), a reserva.
 * Recusa não passa para a reserva: se uma IA recusou a tarefa, não tentamos contornar com outra.
 */
export class FallbackAi implements AiProvider {
  readonly enabled = true;

  constructor(
    private primary: AiProvider,
    private secondary: AiProvider,
    private onFallback: (err: unknown) => void = () => {},
  ) {}

  get model(): string {
    return `${this.primary.model} (reserva: ${this.secondary.model})`;
  }

  async generate<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    try {
      return await this.primary.generate(req);
    } catch (err) {
      if (err instanceof AiRefusalError) throw err;
      this.onFallback(err);
      return this.secondary.generate(req);
    }
  }
}

export interface AiConfig {
  AI_PROVIDER: "auto" | "anthropic" | "openrouter";
  ANTHROPIC_API_KEY: string;
  AI_MODEL: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_FALLBACK_MODELS: string;
}

/**
 * Escolhe a IA pelas chaves do .env:
 * - só ANTHROPIC_API_KEY → Claude; só OPENROUTER_API_KEY → OpenRouter (modelos gratuitos por padrão);
 * - as duas → a de AI_PROVIDER (padrão: Claude) é a principal e a outra fica de reserva.
 */
export function createAiProvider(config: AiConfig, onFallback?: (err: unknown) => void): AiProvider {
  const claude = config.ANTHROPIC_API_KEY ? new ClaudeProvider(config.AI_MODEL, config.ANTHROPIC_API_KEY) : null;
  const openrouter = config.OPENROUTER_API_KEY
    ? new OpenRouterProvider({
        apiKey: config.OPENROUTER_API_KEY,
        model: config.OPENROUTER_MODEL,
        fallbackModels: config.OPENROUTER_FALLBACK_MODELS.split(",")
          .map((m) => m.trim())
          .filter(Boolean),
      })
    : null;
  const [primary, secondary] = config.AI_PROVIDER === "openrouter" ? [openrouter, claude] : [claude, openrouter];
  if (config.AI_PROVIDER !== "auto" && !primary) {
    throw new Error(
      `AI_PROVIDER=${config.AI_PROVIDER}, mas a chave ${config.AI_PROVIDER === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY"} está vazia.`,
    );
  }
  if (primary && secondary) return new FallbackAi(primary, secondary, onFallback);
  return primary ?? secondary ?? new DisabledAi();
}
