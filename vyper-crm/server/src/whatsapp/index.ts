import type { Config } from "../config.js";
import { EvolutionProvider } from "./evolution.js";
import { MetaCloudProvider } from "./meta.js";
import { SimulatorProvider } from "./simulator.js";
import type { WhatsAppProvider } from "./types.js";

export function evolutionWebhookUrl(config: Config): string {
  const base = config.PUBLIC_URL.replace(/\/$/, "");
  const token = config.WEBHOOK_SECRET ? `?token=${encodeURIComponent(config.WEBHOOK_SECRET)}` : "";
  return `${base}/api/webhooks/evolution${token}`;
}

export function createWhatsAppProvider(config: Config): WhatsAppProvider {
  switch (config.WHATSAPP_PROVIDER) {
    case "evolution":
      return new EvolutionProvider({
        baseUrl: config.EVOLUTION_API_URL,
        apiKey: config.EVOLUTION_API_KEY,
        instance: config.EVOLUTION_INSTANCE,
        webhookUrl: evolutionWebhookUrl(config),
      });
    case "meta":
      return new MetaCloudProvider({
        accessToken: config.META_ACCESS_TOKEN,
        phoneNumberId: config.META_PHONE_NUMBER_ID,
        graphVersion: config.META_GRAPH_VERSION,
      });
    default:
      return new SimulatorProvider();
  }
}

export * from "./types.js";
