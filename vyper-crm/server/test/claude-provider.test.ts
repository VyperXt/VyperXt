import { describe, expect, it } from "vitest";
import { ClaudeProvider } from "../src/ai/provider.js";
import { replySchema } from "../src/ai/schemas.js";

/** Confere o formato do pedido enviado à API do Claude sem usar a rede. */
function fakeAnthropic(responseBody: object) {
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

const message = (text: string, stop_reason = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text }],
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

describe("ClaudeProvider", () => {
  it("usa saída estruturada, effort, cache e fallback do servidor", async () => {
    const { requests, fetchImpl } = fakeAnthropic(
      message(JSON.stringify({ reply: "Oi!", handoff: false, handoffReason: "" })),
    );
    const ai = new ClaudeProvider("claude-opus-5-5", "sk-test", { fetch: fetchImpl, maxRetries: 0 });
    const out = await ai.generate({ task: "reply", system: "sys", prompt: "p", schema: replySchema, effort: "low" });

    expect(out).toEqual({ reply: "Oi!", handoff: false, handoffReason: "" });
    const req = requests[0]!;
    expect(req.url).toContain("/v1/messages");
    expect(req.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(req.body.model).toBe("claude-opus-5-5");
    expect(req.body.fallbacks).toBe("default");
    expect(req.body.output_config.effort).toBe("low");
    expect(req.body.output_config.format.type).toBe("json_schema");
    expect(req.body.output_config.format.schema.properties.handoff.type).toBe("boolean");
    expect(req.body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(req.body.thinking).toBeUndefined();
  });

  it("modelos sem fallback do servidor não recebem o parâmetro", async () => {
    const { requests, fetchImpl } = fakeAnthropic(message(JSON.stringify({ reply: "x", handoff: false, handoffReason: "" })));
    const ai = new ClaudeProvider("claude-haiku-5-5", "sk-test", { fetch: fetchImpl, maxRetries: 0 });
    await ai.generate({ task: "reply", system: "s", prompt: "p", schema: replySchema });
    expect(requests[0]!.body.fallbacks).toBeUndefined();
    expect(requests[0]!.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
  });

  it("recusa vira erro tratável", async () => {
    const { fetchImpl } = fakeAnthropic(message("", "refusal"));
    const ai = new ClaudeProvider("claude-opus-5-5", "sk-test", { fetch: fetchImpl, maxRetries: 0 });
    await expect(ai.generate({ task: "reply", system: "s", prompt: "p", schema: replySchema })).rejects.toThrow(/recusou/);
  });
});
