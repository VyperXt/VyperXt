import { randomUUID } from "node:crypto";
import { phoneVariants } from "../lib/phone.js";
import {
  WhatsAppNumberNotFoundError,
  type ConnectResult,
  type ConnectionStatus,
  type NumberCheck,
  type OutgoingImage,
  type WhatsAppProvider,
} from "./types.js";

/**
 * Provedor de teste: não envia nada de verdade, só registra.
 * Use a caixa "Simular mensagem do lead" no painel para testar o fluxo completo sem WhatsApp.
 */
export class SimulatorProvider implements WhatsAppProvider {
  readonly name = "simulator" as const;
  /** Tudo o que "saiu". Imagens entram com a legenda em `text` e os dados em `image`. */
  readonly sent: Array<{
    phone: string;
    text: string;
    externalId: string;
    image?: { mimeType: string; bytes: number; fileName?: string };
  }> = [];
  failNext: string | null = null;
  connected = true;
  /**
   * Números (só dígitos, com DDI) que "não têm WhatsApp" — para testes. Os demais existem.
   * Enviar para eles falha como na Evolution (WhatsAppNumberNotFoundError).
   */
  readonly missingNumbers = new Set<string>();

  private isMissing(phone: string): boolean {
    return phoneVariants(phone).some((v) => this.missingNumbers.has(v));
  }

  async checkNumber(phone: string): Promise<NumberCheck> {
    if (this.isMissing(phone)) return { exists: false, jid: null };
    return { exists: true, jid: `${phone}@s.whatsapp.net` };
  }

  async sendText(phone: string, text: string): Promise<{ externalId?: string }> {
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      throw new Error(msg);
    }
    if (this.isMissing(phone)) throw new WhatsAppNumberNotFoundError(phone);
    const externalId = `sim-${randomUUID()}`;
    this.sent.push({ phone, text, externalId });
    return { externalId };
  }

  async sendImage(phone: string, image: OutgoingImage): Promise<{ externalId?: string }> {
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      throw new Error(msg);
    }
    if (this.isMissing(phone)) throw new WhatsAppNumberNotFoundError(phone);
    const externalId = `sim-${randomUUID()}`;
    this.sent.push({
      phone,
      text: image.caption ?? "",
      externalId,
      image: { mimeType: image.mimeType, bytes: image.data.length, fileName: image.fileName },
    });
    return { externalId };
  }

  async status(): Promise<ConnectionStatus> {
    return {
      provider: this.name,
      connected: this.connected,
      state: this.connected ? "open" : "disconnected",
      detail: this.connected
        ? "Modo simulador (nenhuma mensagem sai de verdade)"
        : "WhatsApp desconectado",
    };
  }

  async connect(): Promise<ConnectResult> {
    this.connected = true;
    return { message: "Modo simulador ativo. Para usar WhatsApp real, configure WHATSAPP_PROVIDER=evolution ou meta." };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}
