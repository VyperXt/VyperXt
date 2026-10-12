import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";

export type CrmEventType =
  | "lead.created"
  | "lead.updated"
  | "lead.stage_changed"
  | "lead.hot"
  | "lead.handoff"
  | "lead.opted_out"
  | "lead.deleted"
  | "message.received"
  | "message.sent"
  | "message.status"
  | "copilot.updated"
  | "whatsapp.connection"
  | "whatsapp.qrcode"
  | "prospect.updated"
  | "sample.updated"
  | "scheduled.updated";

export interface CrmEvent {
  type: CrmEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

// Eventos que vão para o n8n (os de interface, como copilot.updated, ficam só no navegador)
export const N8N_EVENTS: CrmEventType[] = [
  "lead.created",
  "lead.stage_changed",
  "lead.hot",
  "lead.handoff",
  "lead.opted_out",
  "message.received",
  "message.sent",
];

export interface WebhookTarget {
  url: string;
  secret?: string;
}

/**
 * Barramento de eventos: alimenta o painel em tempo real (SSE)
 * e repassa os eventos de negócio para o webhook do n8n.
 */
export class EventBus {
  private emitter = new EventEmitter();
  private pendingDeliveries = new Set<Promise<void>>();

  constructor(
    private getWebhook: () => Promise<WebhookTarget | null>,
    private log: { warn: (obj: object, msg: string) => void } = console as never,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.emitter.setMaxListeners(0);
  }

  emit(type: CrmEventType, data: Record<string, unknown>): void {
    const event: CrmEvent = { type, timestamp: new Date().toISOString(), data };
    this.emitter.emit("event", event);
    if (N8N_EVENTS.includes(type)) {
      const delivery = this.deliver(event).finally(() => this.pendingDeliveries.delete(delivery));
      this.pendingDeliveries.add(delivery);
    }
  }

  subscribe(listener: (event: CrmEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pendingDeliveries]);
  }

  private async deliver(event: CrmEvent): Promise<void> {
    let target: WebhookTarget | null;
    try {
      target = await this.getWebhook();
    } catch {
      return;
    }
    if (!target?.url) return;
    const body = JSON.stringify({ event: event.type, timestamp: event.timestamp, data: event.data });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (target.secret) {
      headers["x-crm-signature"] = createHmac("sha256", target.secret).update(body).digest("hex");
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.fetchImpl(target.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return;
        if (res.status < 500) {
          this.log.warn({ status: res.status, event: event.type }, "webhook do n8n recusou o evento");
          return;
        }
      } catch (err) {
        if (attempt === 2) this.log.warn({ err: String(err), event: event.type }, "falha ao enviar evento ao n8n");
      }
    }
  }
}
