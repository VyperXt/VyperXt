/** Falha da IA que vale mostrar para quem clicou (formato errado, provedor fora do ar...). */
export class AiError extends Error {}

/** Limite de uso atingido (no plano gratuito do OpenRouter: 20 pedidos/min e 50/dia sem créditos). */
export class AiRateLimitError extends AiError {}

export class AiRefusalError extends Error {}

export class AiUnavailableError extends Error {
  constructor() {
    super("IA desativada: configure ANTHROPIC_API_KEY ou OPENROUTER_API_KEY no arquivo .env");
  }
}
