import { randomUUID } from "node:crypto";
import type { ConnectResult, ConnectionStatus, WhatsAppProvider } from "./types.js";

/**
 * Provedor de teste: não envia nada de verdade, só registra.
 * Use a caixa "Simular mensagem do lead" no painel para testar o fluxo completo sem WhatsApp.
 */
export class SimulatorProvider implements WhatsAppProvider {
  readonly name = "simulator" as const;
  readonly sent: Array<{ phone: string; text: string; externalId: string }> = [];
  failNext: string | null = null;

  async sendText(phone: string, text: string): Promise<{ externalId?: string }> {
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      throw new Error(msg);
    }
    const externalId = `sim-${randomUUID()}`;
    this.sent.push({ phone, text, externalId });
    return { externalId };
  }

  async status(): Promise<ConnectionStatus> {
    return { provider: this.name, connected: true, state: "open", detail: "Modo simulador (nenhuma mensagem sai de verdade)" };
  }

  async connect(): Promise<ConnectResult> {
    return { message: "Modo simulador ativo. Para usar WhatsApp real, configure WHATSAPP_PROVIDER=evolution ou meta." };
  }

  async disconnect(): Promise<void> {}
}
