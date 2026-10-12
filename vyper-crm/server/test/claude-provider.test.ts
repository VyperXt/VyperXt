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

/** Corpo SSE de uma resposta em streaming (o que messages.stream() lê). */
function sse(blocks: any[], stop_reason: string) {
  const ev = (type: string, data: object) => `event: ${type}
data: ${JSON.stringify({ type, ...data })}

`;
  let out = ev("message_start", {
    message: { id: "msg_s", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } },
  });
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "", citations: null } });
      out += ev("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
      for (const citation of block.citations ?? []) out += ev("content_block_delta", { index, delta: { type: "citations_delta", citation } });
    } else if (block.type === "server_tool_use") {
      out += ev("content_block_start", { index, content_block: { ...block, input: {} } });
      out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else {
      out += ev("content_block_start", { index, content_block: block });
    }
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
  out += ev("message_stop", {});
  return out;
}

/** API falsa para a pesquisa: respostas em streaming (pesquisa) ou JSON (conversão final), na ordem. */
function fakeResearchApi(replies: Array<{ sse: string } | { json: object }>) {
  const requests: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const r = replies.shift()!;
    if ("sse" in r) return new Response(r.sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify(r.json), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

describe("ClaudeProvider — pesquisa na web", () => {
  const search = { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "padarias Campinas" } };
  const searchResult = {
    type: "web_search_tool_result",
    tool_use_id: "srv_1",
    content: [{ type: "web_search_result", url: "https://guia.example/padaria", title: "Padaria", encrypted_content: "enc", page_age: null }],
  };
  const fetchPage = { type: "server_tool_use", id: "srv_2", name: "web_fetch", input: { url: "https://guia.example/padaria" } };
  const citation = { type: "web_search_result_location", url: "https://guia.example/padaria", title: "Padaria", encrypted_index: "ei", cited_text: "Tel (19) 3245-8830" };

  it("ferramentas web do servidor, continua após pause_turn e converte o relatório no schema", async () => {
    const api = fakeResearchApi([
      { sse: sse([search, searchResult], "pause_turn") },
      { sse: sse([fetchPage, { type: "text", text: "Padaria Real, telefone (19) 3245-8830.", citations: [citation] }], "end_turn") },
      { json: message(JSON.stringify({ reply: "Padaria Real", handoff: false, handoffReason: "" })) },
    ]);
    const ai = new ClaudeProvider("claude-opus-5-5", "sk-test", { fetch: api.fetchImpl, maxRetries: 0 });
    const progress: unknown[] = [];
    const out = await ai.research({
      task: "prospect",
      system: "Pesquise.",
      prompt: "1 padaria",
      schema: replySchema,
      onProgress: (p) => progress.push(p),
    });

    expect(out.reply).toBe("Padaria Real");
    expect(api.requests).toHaveLength(3);
    const [first, second, convert] = api.requests;
    expect(first.stream).toBe(true);
    expect(first.tools.map((t: any) => t.type)).toEqual(["web_search_20260209", "web_fetch_20260209"]);
    expect(first.output_config).toEqual({ effort: "medium" });
    expect(first.system[0].text).toContain("Pesquise.");
    // pause_turn: a resposta pausada volta como está, sem mensagem extra do usuário
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1].role).toBe("assistant");
    expect(second.messages[1].content[0]).toMatchObject({ type: "server_tool_use", id: "srv_1" });
    // Conversão: sem ferramentas, saída estruturada, relatório com as fontes citadas
    expect(convert.stream).toBeFalsy();
    expect(convert.tools).toBeUndefined();
    expect(convert.output_config.format.type).toBe("json_schema");
    expect(convert.messages[0].content).toContain("(19) 3245-8830. [fontes: https://guia.example/padaria]");
    expect(progress).toEqual([
      { searches: 1, fetches: 0, lastAction: "padarias Campinas" },
      { searches: 1, fetches: 1, lastAction: "https://guia.example/padaria" },
    ]);
  });

  it("modelos antigos usam as ferramentas web básicas; cancelar vira AiError", async () => {
    const api = fakeResearchApi([
      { sse: sse([{ type: "text", text: "nada encontrado" }], "end_turn") },
      { json: message(JSON.stringify({ reply: "", handoff: false, handoffReason: "" })) },
    ]);
    const old = new ClaudeProvider("claude-haiku-4-5", "sk-test", { fetch: api.fetchImpl, maxRetries: 0 });
    await old.research({ task: "prospect", system: "s", prompt: "p", schema: replySchema });
    expect(api.requests[0].tools.map((t: any) => t.type)).toEqual(["web_search_20250305", "web_fetch_20250910"]);
    expect(api.requests[0].output_config).toBeUndefined();

    const ai = new ClaudeProvider("claude-opus-5-5", "sk-test", { fetch: api.fetchImpl, maxRetries: 0 });
    await expect(
      ai.research({ task: "prospect", system: "s", prompt: "p", schema: replySchema, signal: AbortSignal.abort() }),
    ).rejects.toThrow("Pesquisa cancelada.");
  });
});
