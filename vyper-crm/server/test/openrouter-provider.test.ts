import { describe, expect, it } from "vitest";
import { AiError, AiRateLimitError, AiRefusalError } from "../src/ai/errors.js";
import { extractJson, OpenRouterProvider, toStrictJsonSchema } from "../src/ai/openrouter.js";
import { ClaudeProvider, createAiProvider, DisabledAi, FallbackAi, type AiConfig, type AiProvider } from "../src/ai/provider.js";
import { copilotSchema, qualifySchema, replySchema } from "../src/ai/schemas.js";
import { loadConfig } from "../src/config.js";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; brokenBody?: boolean } | Error;

/** fetch falso: devolve as respostas na ordem e guarda os pedidos. */
function fakeOpenRouter(replies: Reply[]) {
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    const r = replies.shift() ?? { body: completion("{}") };
    if (r instanceof Error) throw r;
    if (r.brokenBody) {
      // 200 chega logo; o corpo cai no meio (timeout ou conexão perdida durante a geração)
      const stream = new ReadableStream({ start: (c) => c.error(new Error("The operation was aborted due to timeout")) });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  return { requests, fetchImpl, sleeps, sleep };
}

const completion = (content: string, extra: Record<string, unknown> = {}) => ({
  id: "gen-1",
  model: "nvidia/nemotron-3-super-120b-a12b:free",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content }, ...extra }],
});
const okReply = JSON.stringify({ reply: "Oi!", handoff: false, handoffReason: "" });
const req = { task: "reply" as const, system: "Você atende a ACME.", prompt: "Lead: oi", schema: replySchema };

function provider(fake: ReturnType<typeof fakeOpenRouter>, extra: Partial<ConstructorParameters<typeof OpenRouterProvider>[0]> = {}) {
  return new OpenRouterProvider({
    apiKey: "sk-or-test",
    model: "openrouter/free",
    fetchImpl: fake.fetchImpl,
    sleep: fake.sleep,
    now: () => Date.parse("2026-10-10T12:00:00Z"),
    ...extra,
  });
}

describe("OpenRouterProvider", () => {
  it("pede saída estruturada strict ao modelo gratuito e valida a resposta", async () => {
    const fake = fakeOpenRouter([{ body: completion(okReply) }]);
    const out = await provider(fake).generate(req);
    expect(out).toEqual({ reply: "Oi!", handoff: false, handoffReason: "" });

    const r = fake.requests[0]!;
    expect(r.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(r.headers.get("authorization")).toBe("Bearer sk-or-test");
    expect(r.headers.get("x-title")).toBe("Vyper CRM");
    expect(r.body.model).toBe("openrouter/free");
    expect(r.body.messages[0].role).toBe("system");
    expect(r.body.messages[0].content).toContain("Você atende a ACME.");
    expect(r.body.messages[0].content).toContain('"handoff"'); // o schema também vai no prompt
    expect(r.body.messages[1]).toEqual({ role: "user", content: "Lead: oi" });
    expect(r.body.response_format.type).toBe("json_schema");
    expect(r.body.response_format.json_schema).toMatchObject({ name: "reply", strict: true });
    expect(r.body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(r.body.provider).toEqual({ require_parameters: true });
    expect(r.body.plugins).toEqual([{ id: "response-healing" }]);
    expect(r.body.models).toBeUndefined();
  });

  it("schema strict: objetos fechados, todos os campos obrigatórios, sem $schema nem limites gigantes", () => {
    const s = toStrictJsonSchema(copilotSchema) as any;
    expect(s.$schema).toBeUndefined();
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(Object.keys(s.properties));
    expect(s.properties.paths.items.additionalProperties).toBe(false);
    expect(s.properties.paths.items.required).toEqual(["title", "strategy", "message"]);
    const q = toStrictJsonSchema(qualifySchema) as any;
    expect(q.properties.score).toEqual({ type: "integer", description: expect.any(String) });
  });

  it("modelos de reserva vão no campo models", async () => {
    const fake = fakeOpenRouter([{ body: completion(okReply) }]);
    await provider(fake, { fallbackModels: ["google/gemma-4-31b-it:free"] }).generate(req);
    expect(fake.requests[0]!.body.models).toEqual(["openrouter/free", "google/gemma-4-31b-it:free"]);
  });

  it("modelo sem saída estruturada: cai para json_object e depois para texto livre", async () => {
    const unsupported = { status: 404, body: { error: { code: 404, message: "No endpoints found that support the requested parameters" } } };
    const fake = fakeOpenRouter([unsupported, { status: 400, body: { error: { code: 400, message: "response_format not supported" } } }, { body: completion(okReply) }]);
    const out = await provider(fake, { model: "google/gemma-4-31b-it:free" }).generate(req);
    expect(out.reply).toBe("Oi!");
    expect(fake.requests.map((r) => r.body.response_format?.type ?? "none")).toEqual(["json_schema", "json_object", "none"]);
    expect(fake.requests[2]!.body.provider).toBeUndefined();
  });

  it("JSON dentro de markdown ou com texto em volta é aproveitado", async () => {
    const fake = fakeOpenRouter([{ body: completion("Claro! Aqui está:\n```json\n" + okReply + "\n```") }]);
    expect((await provider(fake).generate(req)).reply).toBe("Oi!");
    expect(extractJson('Resposta: {"a": 1} fim')).toEqual({ a: 1 });
    expect(() => extractJson("sem json")).toThrow();
  });

  it("resposta fora do formato: pede correção uma vez", async () => {
    const fake = fakeOpenRouter([{ body: completion('{"reply": "Oi!"}') }, { body: completion(okReply) }]);
    expect((await provider(fake).generate(req)).handoff).toBe(false);
    const second = fake.requests[1]!.body.messages;
    expect(second.at(-2)).toEqual({ role: "assistant", content: '{"reply": "Oi!"}' });
    expect(second.at(-1).content).toContain("handoff");
  });

  it("fora do formato duas vezes: erro claro (sem loop)", async () => {
    const fake = fakeOpenRouter([{ body: completion("não sei") }, { body: completion("ainda não") }]);
    await expect(provider(fake).generate(req)).rejects.toThrow(AiError);
    expect(fake.requests).toHaveLength(2);
  });

  it("limite por minuto: espera o Retry-After e tenta de novo", async () => {
    const limited = { status: 429, body: { error: { code: 429, message: "Rate limit exceeded" } }, headers: { "retry-after": "3" } };
    const fake = fakeOpenRouter([limited, { body: completion(okReply) }]);
    expect((await provider(fake).generate(req)).reply).toBe("Oi!");
    expect(fake.sleeps).toEqual([3250]);
  });

  it("limite por minuto com reset em até 1 minuto: espera e tenta de novo (não é o limite do dia)", async () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    const limited = { status: 429, body: { error: { code: 429, message: "Rate limit exceeded: free-models-per-min" } }, headers: { "x-ratelimit-reset": String(now + 45_000) } };
    const fake = fakeOpenRouter([limited, { body: completion(okReply) }]);
    expect((await provider(fake).generate(req)).reply).toBe("Oi!");
    expect(fake.sleeps).toEqual([45_250]);
  });

  it("limite do provedor do modelo: o reset pode vir no corpo (metadata.headers)", async () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    const limited = {
      status: 429,
      body: { error: { code: 429, message: "Provider returned error", metadata: { headers: { "X-RateLimit-Reset": String(now + 30_000) } } } },
    };
    const fake = fakeOpenRouter([limited, { body: completion(okReply) }]);
    expect((await provider(fake).generate(req)).reply).toBe("Oi!");
    expect(fake.sleeps).toEqual([30_250]);
  });

  it("ocupado o tempo todo: desiste com erro passageiro (não diz que acabou a cota do dia)", async () => {
    const busy = () => ({ status: 429, body: { error: { code: 429, message: "temporarily rate-limited upstream" } } });
    const fake = fakeOpenRouter([busy(), busy(), busy()]);
    const err = await provider(fake).generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(AiRateLimitError);
    expect(err.daily).toBe(false);
    expect(err.message).toContain("ocupado");
    expect(fake.sleeps).toEqual([5_250, 15_250]);
  });

  it("limite do dia: não fica esperando, avisa quando libera", async () => {
    const reset = Date.parse("2026-10-11T00:00:00Z");
    const limited = {
      status: 429,
      body: { error: { code: 429, message: "Rate limit exceeded: free-models-per-day" } },
      headers: { "x-ratelimit-reset": String(reset) },
    };
    const fake = fakeOpenRouter([limited]);
    const err = await provider(fake).generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(AiRateLimitError);
    expect(err.daily).toBe(true);
    expect(err.message).toContain("50 pedidos por dia");
    expect(err.message).toContain("00:00 UTC");
    expect(fake.sleeps).toEqual([]);
  });

  it("429 sem dica de espera: uma pausa curta e nova tentativa", async () => {
    const limited = { status: 429, body: { error: { code: 429, message: "upstream rate limited" } } };
    const fake = fakeOpenRouter([limited, { body: completion(okReply) }]);
    expect((await provider(fake).generate(req)).reply).toBe("Oi!");
    expect(fake.sleeps).toEqual([5250]);
  });

  it("erro no corpo de uma resposta 200 e falha passageira: tenta de novo", async () => {
    const fake = fakeOpenRouter([
      { body: { error: { code: 502, message: "Provider returned error" } } },
      new TypeError("fetch failed"),
      { body: completion(okReply) },
    ]);
    expect((await provider(fake).generate(req)).reply).toBe("Oi!");
    expect(fake.requests).toHaveLength(3);
  });

  it("erros de conta e de privacidade viram mensagens claras", async () => {
    const cases: Array<[Reply, RegExp]> = [
      [{ status: 401, body: { error: { code: 401, message: "No auth credentials found" } } }, /OPENROUTER_API_KEY inválida/],
      [{ status: 402, body: { error: { code: 402, message: "Insufficient credits" } } }, /sem saldo/],
      [{ status: 404, body: { error: { code: 404, message: "No endpoints found matching your data policy" } } }, /settings\/privacy/],
      [
        { status: 404, body: { error: { code: 404, message: "No endpoints found matching your data policy (Free model publication)" } } },
        /PUBLICAR/,
      ],
      [{ status: 400, body: { error: { code: 400, message: "foo/bar:free is not a valid model ID" } } }, /not a valid model ID/],
      [{ status: 400, body: { error: { code: 400, message: "This endpoint's maximum context length is 65536 tokens" } } }, /context length/],
    ];
    for (const [reply, msg] of cases) {
      const fake = fakeOpenRouter([reply]);
      await expect(provider(fake).generate(req)).rejects.toThrow(msg);
      expect(fake.requests).toHaveLength(1); // não insiste nem troca de formato
    }
  });

  it("corpo cortado numa resposta 200: avisa sem repetir o pedido nem trocar de formato", async () => {
    const fake = fakeOpenRouter([{ brokenBody: true }]);
    await expect(provider(fake).generate(req)).rejects.toThrow(/não terminou a resposta/);
    expect(fake.requests).toHaveLength(1);
  });

  it("resposta 200 sem escolhas: erro claro", async () => {
    const fake = fakeOpenRouter([{ body: { id: "gen-1", choices: [] } }]);
    await expect(provider(fake).generate(req)).rejects.toThrow(/resposta vazia/);
  });

  it("conteúdo vazio: pede de novo sem mandar uma mensagem vazia do assistente", async () => {
    const fake = fakeOpenRouter([{ body: completion("") }, { body: completion(okReply) }]);
    expect((await provider(fake).generate(req)).reply).toBe("Oi!");
    const second = fake.requests[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(second.some((m) => m.role === "assistant")).toBe(false);
    expect(second.at(-1)!.content).toContain("vazia");
  });

  it("erro na correção (invalid_prompt) não troca de formato", async () => {
    const invalid = { status: 400, body: { error: { code: 400, message: "Invalid prompt", metadata: { error_type: "invalid_prompt" } } } };
    const fake = fakeOpenRouter([{ body: completion("não sei") }, invalid]);
    await expect(provider(fake).generate(req)).rejects.toThrow(AiError);
    expect(fake.requests).toHaveLength(2);
  });

  it("recusa e corte por tamanho", async () => {
    const refusal = fakeOpenRouter([{ body: completion("", { message: { content: null, refusal: "Não posso ajudar com isso." } }) }]);
    await expect(provider(refusal).generate(req)).rejects.toThrow(AiRefusalError);
    const cut = fakeOpenRouter([{ body: completion('{"reply": "Oi', { finish_reason: "length" }) }]);
    await expect(provider(cut).generate(req)).rejects.toThrow(/cortada/);
  });
});

describe("escolha da IA", () => {
  const base: AiConfig = {
    AI_PROVIDER: "auto",
    ANTHROPIC_API_KEY: "",
    AI_MODEL: "claude-opus-5-5",
    OPENROUTER_API_KEY: "",
    OPENROUTER_MODEL: "openrouter/free",
    OPENROUTER_FALLBACK_MODELS: "",
  };

  it("sem chave: desativada; só uma chave: usa essa", () => {
    expect(createAiProvider(base)).toBeInstanceOf(DisabledAi);
    expect(createAiProvider({ ...base, OPENROUTER_API_KEY: "sk-or" })).toBeInstanceOf(OpenRouterProvider);
    expect(createAiProvider({ ...base, ANTHROPIC_API_KEY: "sk-ant" })).toBeInstanceOf(ClaudeProvider);
  });

  it("as duas chaves: AI_PROVIDER escolhe a principal e a outra vira reserva", () => {
    const both = { ...base, ANTHROPIC_API_KEY: "sk-ant", OPENROUTER_API_KEY: "sk-or" };
    expect(createAiProvider(both).model).toBe("claude-opus-5-5 (reserva: openrouter/free)");
    expect(createAiProvider({ ...both, AI_PROVIDER: "openrouter" }).model).toBe("openrouter/free (reserva: claude-opus-5-5)");
    expect(() => createAiProvider({ ...base, AI_PROVIDER: "openrouter" })).toThrow(/OPENROUTER_API_KEY/);
  });

  it("variáveis do .env", () => {
    expect(loadConfig({}).AI_PROVIDER).toBe("auto");
    expect(loadConfig({ AI_PROVIDER: "" }).AI_PROVIDER).toBe("auto");
    expect(loadConfig({ AI_PROVIDER: " OpenRouter " }).AI_PROVIDER).toBe("openrouter");
    expect(loadConfig({ AI_PROVIDER: "claude" }).AI_PROVIDER).toBe("anthropic");
    expect(loadConfig({}).OPENROUTER_MODEL).toBe("openrouter/free");
    expect(loadConfig({ OPENROUTER_MODEL: "" }).OPENROUTER_MODEL).toBe("openrouter/free");
    expect(loadConfig({ OPENROUTER_MODEL: " google/gemma-4-31b-it:free " }).OPENROUTER_MODEL).toBe("google/gemma-4-31b-it:free");
    expect(() => loadConfig({ AI_PROVIDER: "gpt" })).toThrow(/AI_PROVIDER/);
  });

  it("reserva assume quando a principal falha, mas não depois de uma recusa", async () => {
    const failing = (err: Error): AiProvider => ({ enabled: true, model: "a", generate: async () => Promise.reject(err) });
    const backup: AiProvider = { enabled: true, model: "b", generate: async () => ({ reply: "da reserva", handoff: false, handoffReason: "" }) as any };
    const warned: unknown[] = [];
    const ai = new FallbackAi(failing(new AiRateLimitError("limite")), backup, (e) => warned.push(e));
    expect((await ai.generate(req)).reply).toBe("da reserva");
    expect(warned).toHaveLength(1);
    const refused = new FallbackAi(failing(new AiRefusalError("não")), backup);
    await expect(refused.generate(req)).rejects.toThrow(AiRefusalError);
    // Principal sem cota e reserva também falhou: vale o limite (o bot passa a conversa para um humano)
    const both = new FallbackAi(failing(new AiRateLimitError("cota", { daily: true })), failing(new Error("Claude sem crédito")));
    const err = await both.generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(AiRateLimitError);
    expect(err.daily).toBe(true);
    expect(err.message).toContain("Claude sem crédito");
  });
});
