import { normalizePhone } from "../lib/phone.js";
import {
  mediaPlaceholder,
  type ConnectResult,
  type ConnectionStatus,
  type IncomingMessage,
  type ParsedWebhook,
  type StatusUpdate,
  type WhatsAppProvider,
} from "./types.js";

export interface EvolutionOptions {
  baseUrl: string;
  apiKey: string;
  instance: string;
  /** URL completa que a Evolution deve chamar (já com ?token=...) */
  webhookUrl: string;
  fetchImpl?: typeof fetch;
}

export const EVOLUTION_EVENTS = ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED"];

/**
 * Evolution API v2 (https://doc.evolution-api.com) — conecta um número de WhatsApp via QR code.
 */
export class EvolutionProvider implements WhatsAppProvider {
  readonly name = "evolution" as const;
  private fetchImpl: typeof fetch;

  constructor(private opts: EvolutionOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { "content-type": "application/json", apikey: this.opts.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const err = new Error(`Evolution API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return json as T;
  }

  async sendText(phone: string, text: string): Promise<{ externalId?: string }> {
    const res = await this.call<{ key?: { id?: string } }>("POST", `/message/sendText/${this.opts.instance}`, {
      number: phone,
      text,
    });
    return { externalId: res?.key?.id };
  }

  async status(): Promise<ConnectionStatus> {
    try {
      const res = await this.call<{ instance?: { state?: string } }>(
        "GET",
        `/instance/connectionState/${this.opts.instance}`,
      );
      const state = res?.instance?.state ?? "unknown";
      return { provider: this.name, connected: state === "open", state };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return { provider: this.name, connected: false, state: "not_created" };
      return { provider: this.name, connected: false, state: "error", detail: (err as Error).message };
    }
  }

  private async setWebhook(): Promise<void> {
    await this.call("POST", `/webhook/set/${this.opts.instance}`, {
      webhook: {
        enabled: true,
        url: this.opts.webhookUrl,
        byEvents: false,
        base64: false,
        events: EVOLUTION_EVENTS,
      },
    });
  }

  private async ensureInstance(): Promise<void> {
    const current = await this.status();
    if (current.state === "not_created") {
      await this.call("POST", "/instance/create", {
        instanceName: this.opts.instance,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true,
        groupsIgnore: true,
      });
    }
    await this.setWebhook();
  }

  /**
   * Na inicialização: se a instância já existe, grava de novo a URL do webhook.
   * Sem isso, trocar WEBHOOK_SECRET ou PUBLIC_URL no .env deixaria a Evolution chamando a URL antiga
   * (e toda mensagem recebida seria recusada) até alguém clicar em Conectar.
   */
  async syncWebhook(): Promise<"updated" | "no_instance" | "unreachable"> {
    const current = await this.status();
    if (current.state === "not_created") return "no_instance";
    if (current.state === "error") return "unreachable";
    await this.setWebhook();
    return "updated";
  }

  async connect(): Promise<ConnectResult> {
    await this.ensureInstance();
    const current = await this.status();
    if (current.connected) return { message: "WhatsApp já está conectado." };
    const res = await this.call<{ base64?: string; pairingCode?: string; code?: string }>(
      "GET",
      `/instance/connect/${this.opts.instance}`,
    );
    return {
      qrCode: res?.base64,
      pairingCode: res?.pairingCode ?? undefined,
      message: res?.base64
        ? "Abra o WhatsApp no celular → Aparelhos conectados → Conectar aparelho, e escaneie o QR code."
        : "Gerando o QR code... ele aparece aqui em alguns segundos.",
    };
  }

  async disconnect(): Promise<void> {
    await this.call("DELETE", `/instance/logout/${this.opts.instance}`);
  }
}

type AnyRecord = Record<string, any>;

function extractContent(message: AnyRecord | undefined, messageType?: string): { body: string; mediaType: string } {
  if (!message) return { body: "", mediaType: "text" };
  if (typeof message.conversation === "string") return { body: message.conversation, mediaType: "text" };
  if (message.extendedTextMessage?.text) return { body: message.extendedTextMessage.text, mediaType: "text" };
  const media: Array<[string, string]> = [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
    ["documentWithCaptionMessage", "document"],
    ["stickerMessage", "sticker"],
    ["locationMessage", "location"],
    ["contactMessage", "contact"],
  ];
  for (const [key, type] of media) {
    const m = message[key];
    if (m) {
      const caption = m.caption ?? m.message?.documentMessage?.caption;
      return { body: caption ? `${mediaPlaceholder(type)} ${caption}` : mediaPlaceholder(type), mediaType: type };
    }
  }
  if (message.buttonsResponseMessage?.selectedDisplayText)
    return { body: message.buttonsResponseMessage.selectedDisplayText, mediaType: "text" };
  if (message.listResponseMessage?.title) return { body: message.listResponseMessage.title, mediaType: "text" };
  return { body: messageType ? `[${messageType}]` : "", mediaType: messageType ?? "unknown" };
}

const STATUS_MAP: Record<string, StatusUpdate["status"]> = {
  SERVER_ACK: "sent",
  DELIVERY_ACK: "delivered",
  READ: "read",
  PLAYED: "read",
  ERROR: "failed",
};

/** "123:4@lid" → "123@lid" (o sufixo é o aparelho, não o contato) */
function stripDevice(jid: string): string {
  return jid.replace(/:\d+(?=@)/, "");
}

/** Converte o corpo do webhook da Evolution API no formato interno do CRM. */
export function parseEvolutionWebhook(payload: AnyRecord): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], statuses: [] };
  const event = String(payload?.event ?? "")
    .toLowerCase()
    .replace(/_/g, ".");
  const items: AnyRecord[] = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];

  if (event === "messages.upsert") {
    // Número da própria instância (a Evolution manda em "sender" no envelope do webhook)
    const owner = typeof payload?.sender === "string" ? normalizePhone(payload.sender, { international: true }) : null;
    for (const data of items) {
      const key = data.key ?? {};
      const remote: string = key.remoteJid ?? "";
      // Ignora grupos, status e canais
      if (!remote || remote.endsWith("@g.us") || remote === "status@broadcast" || remote.endsWith("@newsletter")) continue;
      if (data.messageType === "protocolMessage" || data.message?.protocolMessage) continue;
      if (data.message?.reactionMessage) continue;
      const fromMe = Boolean(key.fromMe);
      // Contatos com LID: o número real vem em remoteJidAlt/senderPn (quando o WhatsApp informa).
      // O LID não é telefone; sem o número, guardamos o LID e respondemos por ele.
      // A Evolution troca remoteJid pelo número quando o conhece; numa conversa endereçada pelo número,
      // o LID do contato vem em remoteJidAlt. Esses campos "alternativos" são de quem ENVIOU: numa
      // mensagem sua eles são seus, não do contato, então só valem para mensagens recebidas.
      let lid: string | undefined;
      let pnJid = remote;
      if (remote.endsWith("@lid")) {
        lid = stripDevice(remote);
        pnJid = fromMe
          ? ""
          : ([key.remoteJidAlt, key.senderPn, data.senderPn].find(
              (j): j is string => typeof j === "string" && j !== "" && !j.endsWith("@lid"),
            ) ?? "");
      } else if (!fromMe && typeof key.remoteJidAlt === "string" && key.remoteJidAlt.endsWith("@lid")) {
        lid = stripDevice(key.remoteJidAlt);
      }
      const phone = pnJid ? normalizePhone(pnJid, { international: true }) : null;
      if (!phone && !lid) continue;
      // Conversa com o próprio número da instância ("sender"): acontece quando você responde pelo celular
      // numa conversa por LID e a Evolution troca o contato pelo SEU número. Não dá para saber quem é o contato.
      if (phone && owner && phone === owner) {
        (result.skipped ??= []).push(`${key.id ?? "?"}: conversa com o próprio número da instância`);
        continue;
      }
      const { body, mediaType } = extractContent(data.message, data.messageType);
      if (!body) continue;
      const ts = Number(data.messageTimestamp);
      result.messages.push({
        phone,
        ...(lid ? { jid: lid } : {}),
        name: key.fromMe ? undefined : data.pushName || undefined,
        body,
        mediaType,
        externalId: key.id,
        fromMe,
        timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : undefined,
      } satisfies IncomingMessage);
    }
  } else if (event === "messages.update") {
    for (const data of items) {
      const status = STATUS_MAP[String(data.status ?? "")];
      const id = data.keyId ?? data.key?.id;
      if (status && id && data.fromMe !== false) result.statuses.push({ externalId: id, status });
    }
  } else if (event === "connection.update") {
    const state = items[0]?.state;
    if (state) result.connection = { state };
  } else if (event === "qrcode.updated") {
    // O QR code chega por aqui alguns segundos depois de pedir a conexão
    const data = items[0] ?? {};
    result.qrCode = {
      base64: data.qrcode?.base64 || undefined,
      pairingCode: data.qrcode?.pairingCode || undefined,
      message: data.message || undefined,
    };
  }
  return result;
}
