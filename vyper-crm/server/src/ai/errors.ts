/** Falha da IA que vale mostrar para quem clicou (formato errado, provedor fora do ar...). */
export class AiError extends Error {}

/**
 * Limite de uso atingido. daily = acabou a cota do dia (no plano gratuito do OpenRouter: 50 pedidos,
 * ou 1000 com US$ 10 em créditos); senão é passageiro (limite por minuto ou modelo gratuito ocupado).
 */
export class AiRateLimitError extends AiError {
  readonly daily: boolean;
  /** Quanto falta para liberar, se o provedor informou */
  readonly retryAfterMs: number | null;

  constructor(message: string, opts: { daily?: boolean; retryAfterMs?: number | null; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.daily = opts.daily ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

export class AiRefusalError extends Error {}

export class AiUnavailableError extends Error {
  constructor() {
    super("IA desativada: configure ANTHROPIC_API_KEY ou OPENROUTER_API_KEY no arquivo .env");
  }
}
