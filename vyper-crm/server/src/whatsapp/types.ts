export interface IncomingMessage {
  /** Telefone com DDI (só dígitos). null quando o WhatsApp só informa o LID do contato. */
  phone: string | null;
  /** Id interno do WhatsApp ("123...@lid"), quando conhecido. Também serve para responder. */
  jid?: string;
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
  /** Mensagens descartadas e o motivo (vai para o log) */
  skipped?: string[];
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
  /** Só Evolution: regrava o webhook na inicialização (URL/token podem ter mudado). */
  syncWebhook?(): Promise<"updated" | "no_instance" | "unreachable">;
  /**
   * Confere se o número (só dígitos, com DDI) tem WhatsApp. `jid` é o id que o WhatsApp usa para ele,
   * quando informado. Lança erro quando não dá para conferir agora (desconectado, fora do ar).
   * Ausente = o provedor não sabe conferir (Meta).
   */
  checkNumber?(phone: string): Promise<NumberCheck>;
  /** Envia uma imagem (com legenda opcional). Ausente = o provedor não envia imagens. */
  sendImage?(phone: string, image: OutgoingImage): Promise<{ externalId?: string }>;
}

export interface OutgoingImage {
  data: Buffer;
  mimeType: "image/png" | "image/jpeg";
  caption?: string;
  fileName?: string;
}

export interface NumberCheck {
  exists: boolean;
  jid?: string | null;
}

/**
 * Texto gravado em message.error quando o envio falhou porque o número não tem WhatsApp.
 * O painel reconhece a falha por ele (aviso acima da caixa de mensagem), então não mude sem mudar lá.
 */
export const NOT_ON_WHATSAPP_ERROR = "Este número não tem WhatsApp (conferido com e sem o 9).";

/** O provedor recusou o envio porque o número não tem WhatsApp (Evolution: 400 com exists:false). */
export class WhatsAppNumberNotFoundError extends Error {
  readonly notOnWhatsApp = true;
  constructor(
    readonly phone: string,
    /** Resposta original do provedor (vai só para o log) */
    readonly detail?: string,
  ) {
    super(NOT_ON_WHATSAPP_ERROR);
    this.name = "WhatsAppNumberNotFoundError";
  }
}

export function isNotOnWhatsAppError(err: unknown): err is WhatsAppNumberNotFoundError {
  return err instanceof WhatsAppNumberNotFoundError || (err as { notOnWhatsApp?: unknown } | null)?.notOnWhatsApp === true;
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
