import type { z } from "zod";
import type { AiProvider, AiTask, StructuredRequest } from "../src/ai/provider.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AppContext, Logger } from "../src/context.js";
import { openDatabase } from "../src/db/client.js";
import { EventBus } from "../src/lib/events.js";
import { KeyedRunner } from "../src/lib/keyed-runner.js";
import { ensureDefaultData } from "../src/services/leads.js";
import { SimulatorProvider } from "../src/whatsapp/simulator.js";

type Handler = (req: StructuredRequest<z.ZodType>) => unknown;

export class FakeAi implements AiProvider {
  readonly enabled = true;
  readonly model = "fake-model";
  calls: Array<StructuredRequest<z.ZodType>> = [];
  handlers: Record<AiTask, Handler> = {
    reply: () => ({ reply: "Olá! Como posso te ajudar?", handoff: false, handoffReason: "" }),
    qualify: () => ({
      name: "",
      email: "",
      company: "",
      interest: "",
      budget: "",
      timeline: "",
      score: 40,
      temperature: "morno",
      summary: "Lead interessado.",
      suggestedStage: "",
      tags: [],
    }),
    copilot: () => ({
      summary: "Lead quer saber preço.",
      intent: "Comparar preços",
      sentiment: "neutro",
      buyingStage: "pesquisa",
      objections: ["preço"],
      buyingSignals: ["perguntou prazo"],
      nextBestAction: "Entender o orçamento antes de passar o preço.",
      paths: [
        { title: "Aprofundar a dor", strategy: "Entender o problema", message: "Me conta mais sobre o que você precisa?" },
        { title: "Ancorar valor", strategy: "Mostrar resultado", message: "Nossos clientes economizam 30%..." },
      ],
      avoid: ["Mandar preço seco"],
      missingInfo: ["orçamento"],
    }),
    copilot_ask: () => ({ answer: "Pergunte o orçamento.", suggestedMessage: "Qual valor você tinha em mente?" }),
    extract: () => ({ leads: [] }),
    followup: () => ({ send: true, message: "Oi! Conseguiu pensar na proposta?", reason: "" }),
  };

  async generate<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    this.calls.push(req as StructuredRequest<z.ZodType>);
    return req.schema.parse(await this.handlers[req.task](req as StructuredRequest<z.ZodType>));
  }

  callsOf(task: AiTask) {
    return this.calls.filter((c) => c.task === task);
  }
}


export async function setup(env: Record<string, string> = {}) {
  const handle = await openDatabase("pglite://memory");
  const config = loadConfig({
    JWT_SECRET: "test-secret-1234567890",
    ADMIN_EMAIL: "admin@test.dev",
    ADMIN_PASSWORD: "senha123",
    CRM_API_KEY: "test-key",
    WEBHOOK_SECRET: "whsec",
    META_VERIFY_TOKEN: "verify-me",
    META_APP_SECRET: "app-secret",
    N8N_WEBHOOK_URL: "http://n8n.test/webhook/crm",
    APP_TIMEZONE: "America/Sao_Paulo",
    ...env,
  });
  const errors: Array<{ obj: object; msg?: string }> = [];
  const silent: Logger = {
    info() {},
    warn() {},
    error(obj, msg) {
      errors.push({ obj, msg });
    },
  };
  const deliveries: Array<{ url: string; body: { event: string; data: Record<string, any> } }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    deliveries.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("ok");
  }) as unknown as typeof fetch;
  const events = new EventBus(async () => ({ url: config.N8N_WEBHOOK_URL }), silent, fakeFetch);
  const ai = new FakeAi();
  const wa = new SimulatorProvider();
  // 12:00 em São Paulo (dentro da janela de envio padrão 08:00–20:00)
  let clock = new Date("2026-10-09T15:00:00Z");
  const ctx: AppContext = {
    db: handle.db,
    config,
    ai,
    wa,
    events,
    jobs: new KeyedRunner((err) => {
      throw err;
    }),
    log: silent,
    now: () => clock,
    aiDelayOverrideMs: 0,
  };
  await ensureDefaultData(ctx);

  return {
    ctx,
    ai,
    wa,
    deliveries,
    errors,
    eventsOf: (type: string) => deliveries.filter((d) => d.body.event === type),
    advanceMinutes(min: number) {
      clock = new Date(clock.getTime() + min * 60_000);
    },
    setNow(d: Date) {
      clock = d;
    },
    async settle() {
      await ctx.jobs.drain();
      await events.flush();
    },
    async app() {
      return buildApp(ctx);
    },
    close: () => handle.close(),
  };
}

export type TestEnv = Awaited<ReturnType<typeof setup>>;

export async function login(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@test.dev", password: "senha123" },
  });
  return res.json().token;
}
