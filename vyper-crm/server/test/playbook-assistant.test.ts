import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiError, AiRateLimitError, AiRefusalError } from "../src/ai/errors.js";
import { playbooks } from "../src/db/schema.js";
import { login, setup, type TestEnv } from "./helpers.js";

let env: TestEnv;
let app: Awaited<ReturnType<TestEnv["app"]>>;
let token: string;

beforeEach(async () => {
  env = await setup();
  app = await env.app();
  token = await login(app);
});

afterEach(async () => {
  await app.close();
  await env.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe("Assistente de Roteiros (POST /api/playbooks/assistant)", () => {
  it("200: devolve reply/draft/done/provider 'claude-code'; chamada tem rascunho e última mensagem no prompt", async () => {
    env.claude.handlers.playbook_assistant = () => ({
      reply: "Roteiro atualizado com sucesso!",
      draft: {
        name: "OrcaEasy – eletricistas",
        goal: "Agendar demonstração do app",
        offer: "App gratuito de orçamentos rápidos",
        instructions: "Focar em agilidade e economia de tempo",
        handoffRules: "Passar para humano se pedir desconto no plano pro",
        firstMessage: "Oi {primeiro_nome}, tudo bem com a {empresa}?",
      },
      done: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/playbooks/assistant",
      headers: auth(),
      payload: {
        messages: [
          { role: "user", content: "Quero criar um roteiro para eletricistas." },
          { role: "assistant", content: "Qual é o objetivo principal?" },
          { role: "user", content: "O objetivo é agendar demonstração do app OrcaEasy." },
        ],
        draft: {
          name: "OrcaEasy",
          goal: "Agendar demo",
        },
        playbookId: 42,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply).toBe("Roteiro atualizado com sucesso!");
    expect(body.done).toBe(true);
    expect(body.provider).toBe("claude-code");
    expect(body.draft).toEqual({
      name: "OrcaEasy – eletricistas",
      goal: "Agendar demonstração do app",
      offer: "App gratuito de orçamentos rápidos",
      instructions: "Focar em agilidade e economia de tempo",
      handoffRules: "Passar para humano se pedir desconto no plano pro",
      firstMessage: "Oi {primeiro_nome}, tudo bem com a {empresa}?",
    });

    // Confere os detalhes da chamada na IA
    const calls = env.claude.callsOf("playbook_assistant");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.task).toBe("playbook_assistant");
    expect(call.effort).toBe("medium");
    expect(call.timeoutMs).toBe(150_000);

    // O prompt contém o rascunho atual e a última mensagem do usuário
    expect(call.prompt).toContain('"name": "OrcaEasy"');
    expect(call.prompt).toContain('"goal": "Agendar demo"');
    expect(call.prompt).toContain("O objetivo é agendar demonstração do app OrcaEasy.");
    expect(call.prompt).toContain("Ajustando o roteiro existente #42");
    expect(call.prompt).toContain("Responda à última mensagem do usuário.");
  });

  it("não grava nada na tabela playbooks", async () => {
    const [before] = await env.ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(playbooks);

    const res = await app.inject({
      method: "POST",
      url: "/api/playbooks/assistant",
      headers: auth(),
      payload: {
        messages: [{ role: "user", content: "Crie um roteiro qualquer." }],
      },
    });
    expect(res.statusCode).toBe(200);

    const [after] = await env.ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(playbooks);

    expect(after!.count).toBe(before!.count);
  });

  it("400 quando a última mensagem não é do usuário / messages vazio", async () => {
    // 1. messages vazio
    const resEmpty = await app.inject({
      method: "POST",
      url: "/api/playbooks/assistant",
      headers: auth(),
      payload: { messages: [] },
    });
    expect(resEmpty.statusCode).toBe(400);

    // 2. Última mensagem com role assistant
    const resLastAssistant = await app.inject({
      method: "POST",
      url: "/api/playbooks/assistant",
      headers: auth(),
      payload: {
        messages: [
          { role: "user", content: "Oi" },
          { role: "assistant", content: "Olá, como posso ajudar?" },
        ],
      },
    });
    expect(resLastAssistant.statusCode).toBe(400);

    // 3. Sem o campo messages
    const resMissing = await app.inject({
      method: "POST",
      url: "/api/playbooks/assistant",
      headers: auth(),
      payload: {},
    });
    expect(resMissing.statusCode).toBe(400);
  });

  it("env.ctx.claude = null → usa ctx.ai (provider 'ai')", async () => {
    env.ctx.claude = null;

    env.ai.handlers.playbook_assistant = () => ({
      reply: "Resposta via IA de reserva.",
      draft: {
        name: "Roteiro Backup",
        goal: "Testar IA",
        offer: "Oferta",
        instructions: "Instruções",
        handoffRules: "Handoff",
        firstMessage: "Olá!",
      },
      done: false,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/playbooks/assistant",
      headers: auth(),
      payload: {
        messages: [{ role: "user", content: "Olá pelo provedor secundário." }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe("ai");
    expect(body.reply).toBe("Resposta via IA de reserva.");
    expect(body.draft.name).toBe("Roteiro Backup");

    expect(env.ai.callsOf("playbook_assistant")).toHaveLength(1);
    expect(env.claude.callsOf("playbook_assistant")).toHaveLength(0);
  });

  it("503 quando nem claude nem ai estão disponíveis", async () => {
    env.ctx.claude = null;
    (env.ctx.ai as any).enabled = false;

    const res = await app.inject({
      method: "POST",
      url: "/api/playbooks/assistant",
      headers: auth(),
      payload: {
        messages: [{ role: "user", content: "Oi" }],
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe(
      "O assistente de roteiros usa o Claude Code: defina CLAUDE_CODE_ENABLED=true no .env e reinicie o CRM.",
    );
  });

  it("normaliza draft: trim em strings, name cortado em 80 caracteres e campos ausentes viram ''", async () => {
    const longName = "a".repeat(100);
    env.claude.handlers.playbook_assistant = () => ({
      reply: "  Rascunho formatado  ",
      draft: {
        name: `  ${longName}  `,
        goal: "   Objetivo com espaços   ",
        offer: "",
        instructions: " Instruções ",
        handoffRules: "",
        firstMessage: "",
      },
      done: false,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/playbooks/assistant",
      headers: auth(),
      payload: {
        messages: [{ role: "user", content: "Teste normalização" }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply).toBe("Rascunho formatado");
    expect(body.draft.name).toHaveLength(80);
    expect(body.draft.name).toBe("a".repeat(80));
    expect(body.draft.goal).toBe("Objetivo com espaços");
    expect(body.draft.offer).toBe("");
    expect(body.draft.instructions).toBe("Instruções");
    expect(body.draft.handoffRules).toBe("");
    expect(body.draft.firstMessage).toBe("");
  });

  it("trata erros de IA (AiError, AiRefusalError, AiRateLimitError) sem vazar stack", async () => {
    // 1. AiError -> 502
    env.claude.handlers.playbook_assistant = () => {
      throw new AiError("Falha na geração do modelo.");
    };

    const resError = await app.inject({
      method: "POST",
      url: "/api/playbooks/assistant",
      headers: auth(),
      payload: {
        messages: [{ role: "user", content: "Teste de falha" }],
      },
    });
    expect(resError.statusCode).toBe(502);
    expect(resError.json()).toEqual({ error: "Falha na geração do modelo." });

    // 2. AiRefusalError -> 422
    env.claude.handlers.playbook_assistant = () => {
      throw new AiRefusalError("A IA recusou a tarefa.");
    };

    const resRefusal = await app.inject({
      method: "POST",
      url: "/api/playbooks/assistant",
      headers: auth(),
      payload: {
        messages: [{ role: "user", content: "Teste de recusa" }],
      },
    });
    expect(resRefusal.statusCode).toBe(422);
    expect(resRefusal.json()).toEqual({ error: "A IA recusou a tarefa." });

    // 3. AiRateLimitError -> 429
    env.claude.handlers.playbook_assistant = () => {
      throw new AiRateLimitError("Limite de uso atingido.");
    };

    const resRateLimit = await app.inject({
      method: "POST",
      url: "/api/playbooks/assistant",
      headers: auth(),
      payload: {
        messages: [{ role: "user", content: "Teste de rate limit" }],
      },
    });
    expect(resRateLimit.statusCode).toBe(429);
    expect(resRateLimit.json()).toEqual({ error: "Limite de uso atingido." });
  });
});
