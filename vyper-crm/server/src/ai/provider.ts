import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

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
  readonly model: string;
  generate<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>>;
}

export class AiUnavailableError extends Error {
  constructor() {
    super("IA desativada: configure ANTHROPIC_API_KEY no arquivo .env");
  }
}

export class AiRefusalError extends Error {}

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
      throw new Error(`Resposta da IA cortada por limite de tokens na tarefa "${req.task}".`);
    }
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`A IA não devolveu um JSON válido na tarefa "${req.task}".`);
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) throw new Error(`Resposta da IA fora do formato na tarefa "${req.task}": ${parsed.error.message}`);
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

export function createAiProvider(apiKey: string, model: string): AiProvider {
  return apiKey ? new ClaudeProvider(model, apiKey) : new DisabledAi();
}
