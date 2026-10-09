export interface IncomingMessage {
  phone: string;
  /** Nome do perfil do WhatsApp */
  name?: string;
  body: string;
  mediaType: string;
  externalId?: string;
  /** true quando a mensagem foi enviada por você (pelo celular/WhatsApp Web) */
  fromMe: boolean;
  timestamp?: Date;
}

export interface StatusUpdate {
  externalId: string;
  status: "sent" | "delivered" | "read" | "failed";
  error?: string;
}

export interface ParsedWebhook {
  messages: IncomingMessage[];
  statuses: StatusUpdate[];
  connection?: { state: string };
  qrCode?: { base64?: string; pairingCode?: string; message?: string };
}

export interface ConnectionStatus {
  provider: string;
  connected: boolean;
  state: string;
  detail?: string;
}

export interface ConnectResult {
  /** QR code em data URL (data:image/png;base64,...) quando aplicável */
  qrCode?: string;
  pairingCode?: string;
  message: string;
}

export interface WhatsAppProvider {
  readonly name: "simulator" | "evolution" | "meta";
  sendText(phone: string, text: string): Promise<{ externalId?: string }>;
  status(): Promise<ConnectionStatus>;
  connect(): Promise<ConnectResult>;
  disconnect(): Promise<void>;
}

/** Texto amigável para mensagens que não são texto puro */
export function mediaPlaceholder(type: string): string {
  const map: Record<string, string> = {
    image: "[imagem]",
    audio: "[áudio]",
    video: "[vídeo]",
    document: "[documento]",
    sticker: "[figurinha]",
    location: "[localização]",
    contact: "[contato]",
  };
  return map[type] ?? `[${type}]`;
}
