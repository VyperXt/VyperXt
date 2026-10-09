import type { AiProvider } from "./ai/provider.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import type { EventBus } from "./lib/events.js";
import type { KeyedRunner } from "./lib/keyed-runner.js";
import type { WhatsAppProvider } from "./whatsapp/types.js";

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Tudo que os serviços precisam — facilita trocar peças nos testes. */
export interface AppContext {
  db: Db;
  config: Config;
  ai: AiProvider;
  wa: WhatsAppProvider;
  events: EventBus;
  jobs: KeyedRunner;
  log: Logger;
  now: () => Date;
  /** Substitui o atraso de resposta da IA (testes usam 0) */
  aiDelayOverrideMs?: number;
}
