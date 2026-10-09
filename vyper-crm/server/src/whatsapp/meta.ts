import { createHmac } from "node:crypto";
import { normalizePhone } from "../lib/phone.js";
import { safeEqual } from "../lib/password.js";
import {
  mediaPlaceholder,
  type ConnectResult,
  type ConnectionStatus,
  type ParsedWebhook,
  type StatusUpdate,
  type WhatsAppProvider,
} from "./types.js";

export interface MetaOptions {
  accessToken: string;
  phoneNumberId: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
}

/**
 * API oficial do WhatsApp (Meta Cloud API).
 * Atenção: fora da janela de 24h desde a última mensagem do lead, a Meta só aceita templates aprovados.
 */
export class MetaCloudProvider implements WhatsAppProvider {
  readonly name = "meta" as const;
  private fetchImpl: typeof fetch;

  constructor(private opts: MetaOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get base() {
    return `https://graph.facebook.com/${this.opts.graphVersion}/${this.opts.phoneNumberId}`;
  }

  async sendText(phone: string, text: string): Promise<{ externalId?: string }> {
    const res = await this.fetchImpl(`${this.base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.accessToken}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phone,
        type: "text",
        text: { preview_url: true, body: text },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!res.ok) throw new Error(`Meta Cloud API → ${res.status}: ${json.error?.message ?? "erro desconhecido"}`);
    return { externalId: json.messages?.[0]?.id };
  }

  async status(): Promise<ConnectionStatus> {
    if (!this.opts.accessToken || !this.opts.phoneNumberId) {
      return { provider: this.name, connected: false, state: "not_configured" };
    }
    try {
      const res = await this.fetchImpl(`${this.base}?fields=display_phone_number,verified_name`, {
        headers: { authorization: `Bearer ${this.opts.accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => ({}))) as { display_phone_number?: string; verified_name?: string };
      if (!res.ok) return { provider: this.name, connected: false, state: "error", detail: `HTTP ${res.status}` };
      return {
        provider: this.name,
        connected: true,
        state: "open",
        detail: [json.verified_name, json.display_phone_number].filter(Boolean).join(" · "),
      };
    } catch (err) {
      return { provider: this.name, connected: false, state: "error", detail: (err as Error).message };
    }
  }

  async connect(): Promise<ConnectResult> {
    return {
      message:
        "A API oficial não usa QR code: configure META_ACCESS_TOKEN e META_PHONE_NUMBER_ID e cadastre o webhook no painel da Meta.",
    };
  }

  async disconnect(): Promise<void> {}
}

/** Confere a assinatura X-Hub-Signature-256 enviada pela Meta. */
export function verifyMetaSignature(rawBody: string, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(signatureHeader.slice("sha256=".length), expected);
}

type AnyRecord = Record<string, any>;

export function parseMetaWebhook(payload: AnyRecord): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], statuses: [] };
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;
      const value = change.value ?? {};
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) if (c?.wa_id) names.set(c.wa_id, c.profile?.name);
      for (const m of value.messages ?? []) {
        const phone = normalizePhone(m.from, { international: true });
        if (!phone) continue;
        let body = "";
        let mediaType = m.type ?? "text";
        if (m.type === "text") body = m.text?.body ?? "";
        else if (m.type === "button") body = m.button?.text ?? "";
        else if (m.type === "interactive")
          body = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "[interativo]";
        else {
          const caption = m[m.type]?.caption;
          body = caption ? `${mediaPlaceholder(m.type)} ${caption}` : mediaPlaceholder(m.type);
        }
        if (mediaType === "button" || mediaType === "interactive") mediaType = "text";
        if (!body) continue;
        const ts = Number(m.timestamp);
        result.messages.push({
          phone,
          name: names.get(m.from) ?? undefined,
          body,
          mediaType,
          externalId: m.id,
          fromMe: false,
          timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : undefined,
        });
      }
      for (const s of value.statuses ?? []) {
        const map: Record<string, StatusUpdate["status"]> = {
          sent: "sent",
          delivered: "delivered",
          read: "read",
          failed: "failed",
        };
        const status = map[s?.status];
        if (status && s.id) {
          result.statuses.push({
            externalId: s.id,
            status,
            error: s.errors?.[0]?.title ?? s.errors?.[0]?.message,
          });
        }
      }
    }
  }
  return result;
}
