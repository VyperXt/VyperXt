import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiError, type ResearchRequest } from "../src/ai/provider.js";
import { enrollments, leads, prospectSearches, scheduledMessages, sequences } from "../src/db/schema.js";
import {
  checkProspectsWhatsApp,
  parseProspectPhone,
  recoverInterruptedSearches,
  type ProspectResult,
} from "../src/services/prospecting.js";
import { MetaCloudProvider } from "../src/whatsapp/meta.js";
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

const criteria = {
  niche: "clínicas odontológicas",
  location: "Pinheiros, São Paulo",
  size: "Pequena",
  offer: "Sistema de agendamento online",
  quantity: 10,
};

function prospect(over: Record<string, unknown> = {}) {
  return {
    company: "Empresa",
    contactName: "",
    phone: "",
    email: "",
    website: "",
    instagram: "",
    address: "",
    city: "São Paulo",
    size: "pequena",
    fitReason: "Agenda pelo telefone.",
    approach: "Oi! Vi que vocês agendam por telefone. Posso mostrar como automatizar?",
    score: 50,
    sources: ["https://maps.google.com/?cid=1"],
    ...over,
  };
}

/** Pesquisa que só termina quando o teste mandar (ou quando for cancelada). */
function pendingResearch() {
  let finish: (value: unknown) => void = () => {};
  env.claude.researchHandler = () => new Promise((resolve) => (finish = resolve));
  return { finish: (value: unknown) => finish(value) };
}

async function startSearch(payload: Record<string, unknown> = criteria) {
  return app.inject({ method: "POST", url: "/api/prospecting/searches", headers: auth(), payload });
}

async function getSearch(id: number) {
  return (await app.inject({ method: "GET", url: `/api/prospecting/searches/${id}`, headers: auth() })).json();
}

/** Roda uma pesquisa até o fim com os resultados dados. */
async function finishedSearch(prospects: unknown[]) {
  env.claude.researchHandler = () => ({ prospects, notes: "" });
  const res = await startSearch();
  expect(res.statusCode).toBe(202);
  await env.settle();
  return getSearch(res.json().search.id);
}

describe("prospecção com IA", () => {
  it("pesquisa em segundo plano: normaliza telefones, marca quem já é lead, tira repetidos e quem não tem contato", async () => {
    const existing = (
      await app.inject({ method: "POST", url: "/api/leads", headers: auth(), payload: { name: "Já cliente", phone: "(11) 97777-6666" } })
    ).json();

    env.claude.researchHandler = (req: ResearchRequest<any>) => {
      req.onProgress?.({ searches: 3, fetches: 2, lastAction: "dentistas em Pinheiros" });
      return {
        prospects: [
          prospect({ company: "Clínica Sorriso", phone: "(11) 98888-7777", score: 90, contactName: "Dra. Ana" }),
          // Mesmo número (escrito de outro jeito): repetido
          prospect({ company: "Sorriso Pinheiros", phone: "+55 11 98888-7777", score: 70 }),
          // Mesmo nome na mesma cidade (sem acento/maiúsculas): repetido
          prospect({ company: "CLINICA SORRISO", email: "contato@sorriso.com.br", score: 60 }),
          // Celular antigo sem o 9 → é o lead que já existe
          prospect({ company: "Odonto Center", phone: "(11) 7777-6666", score: 80 }),
          // Fixo + site sem https; nota fora do intervalo
          prospect({ company: "Dental F", phone: "(11) 3333-4444", website: "dentalf.com.br", score: 150 }),
          // Sem nenhum contato: fora
          prospect({ company: "Fantasma", score: 99 }),
          // Link perigoso e telefone de 0800: não passam
          prospect({
            company: "Odonto X",
            phone: "0800 123 4567",
            instagram: "@odontox",
            website: "javascript:alert(1)",
            sources: ["javascript:alert(1)", "https://odontox.com.br"],
            score: -5,
          }),
        ],
        notes: "Poucas clínicas com WhatsApp no site.",
      };
    };

    const res = await startSearch({ ...criteria, extra: "Só clínicas com site" });
    expect(res.statusCode).toBe(202);
    const started = res.json().search;
    expect(started.status).toBe("running");
    expect(started.criteria).toMatchObject({ ...criteria, extra: "Só clínicas com site" });

    await env.settle();
    const search = await getSearch(started.id);
    expect(search.status).toBe("done");
    expect(search.finishedAt).toBeTruthy();
    expect(search.progress).toBe("Poucas clínicas com WhatsApp no site.");

    const call = env.claude.calls.find((c) => c.task === "prospect")!;
    expect(call.prompt).toContain("clínicas odontológicas");
    expect(call.prompt).toContain("Pinheiros, São Paulo");
    expect(call.prompt).toContain("Só clínicas com site");
    expect(call.prompt).toContain("Sistema de agendamento online");
    expect(call.system).toContain("NUNCA invente");

    const byCompany = Object.fromEntries(search.results.map((r: { company: string }) => [r.company, r]));
    expect(search.results.map((r: { company: string }) => r.company)).toEqual([
      "Dental F",
      "Clínica Sorriso",
      "Odonto Center",
      "Odonto X",
    ]);
    expect(byCompany["Dental F"]).toMatchObject({
      phone: "551133334444",
      isMobile: false,
      score: 100,
      website: "https://dentalf.com.br/",
      duplicateLeadId: null,
      leadId: null,
    });
    expect(byCompany["Clínica Sorriso"]).toMatchObject({
      phone: "5511988887777",
      rawPhone: "(11) 98888-7777",
      isMobile: true,
      contactName: "Dra. Ana",
    });
    expect(byCompany["Odonto Center"]).toMatchObject({ phone: "5511977776666", duplicateLeadId: existing.id });
    expect(byCompany["Odonto X"]).toMatchObject({
      phone: "",
      rawPhone: "0800 123 4567",
      website: "",
      instagram: "https://www.instagram.com/odontox/",
      sources: ["https://odontox.com.br/"],
      score: 0,
    });

    // Histórico sem a lista de resultados, mas com a contagem
    const list = (await app.inject({ method: "GET", url: "/api/prospecting/searches", headers: auth() })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: started.id, status: "done", resultCount: 4 });
    expect(list[0].results).toBeUndefined();

    // Evento só do painel: não vai para o n8n
    expect(env.eventsOf("prospect.updated")).toHaveLength(0);
  });

  it("andamento da pesquisa aparece enquanto ela roda", async () => {
    let report: ResearchRequest<any>["onProgress"];
    const pending = pendingResearch();
    const handler = env.claude.researchHandler;
    env.claude.researchHandler = (req) => {
      report = req.onProgress;
      return handler(req);
    };
    const updates: string[] = [];
    env.ctx.events.subscribe((e) => {
      if (e.type === "prospect.updated") updates.push((e.data.search as { progress: string }).progress);
    });
    const id = (await startSearch()).json().search.id;
    await new Promise((r) => setTimeout(r, 10));
    report!({ searches: 1, fetches: 0, lastAction: "clínicas odontológicas Pinheiros" });
    await new Promise((r) => setTimeout(r, 50));
    expect((await getSearch(id)).progress).toBe("1 busca, 0 páginas lidas — última: clínicas odontológicas Pinheiros");
    expect(updates).toContain("1 busca, 0 páginas lidas — última: clínicas odontológicas Pinheiros");
    pending.finish({ prospects: [], notes: "" });
    await env.settle();
    expect((await getSearch(id)).status).toBe("done");
  });

  it("sem Claude Code nem IA com acesso à web → 503 com a explicação", async () => {
    env.ctx.claude = null;
    env.ai.research = undefined;
    const res = await startSearch();
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/CLAUDE_CODE_ENABLED=true/);
    const list = (await app.inject({ method: "GET", url: "/api/prospecting/searches", headers: auth() })).json();
    expect(list).toHaveLength(0);
    const settings = (await app.inject({ method: "GET", url: "/api/settings", headers: auth() })).json();
    expect(settings.system.aiResearch).toBe(false);
    expect(settings.system.claudeCode).toEqual({ enabled: false, model: "" });
  });

  it("usa o Claude Code (assinatura), não a IA principal; sem ele, a principal se ela pesquisar", async () => {
    env.ai.researchHandler = () => ({ prospects: [prospect({ company: "Da principal", phone: "11 98888-7777" })], notes: "" });
    env.claude.researchHandler = () => ({ prospects: [prospect({ company: "Do Claude Code", phone: "11 97777-6666" })], notes: "" });
    let id = (await startSearch()).json().search.id;
    await env.settle();
    expect((await getSearch(id)).results.map((r: { company: string }) => r.company)).toEqual(["Do Claude Code"]);
    expect(env.ai.callsOf("prospect")).toHaveLength(0);

    env.ctx.claude = null;
    id = (await startSearch()).json().search.id;
    await env.settle();
    expect((await getSearch(id)).results.map((r: { company: string }) => r.company)).toEqual(["Da principal"]);
    const settings = (await app.inject({ method: "GET", url: "/api/settings", headers: auth() })).json();
    expect(settings.system.aiResearch).toBe(true);
  });

  it("valida os critérios", async () => {
    const res = await startSearch({ niche: "x", location: "São Paulo", quantity: 50 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/niche/);
  });

  it("uma pesquisa por vez; cancelar interrompe a IA", async () => {
    const pending = pendingResearch();
    const first = await startSearch();
    expect(first.statusCode).toBe(202);
    const id = first.json().search.id;

    const second = await startSearch();
    expect(second.statusCode).toBe(409);

    // Não dá para apagar nem importar enquanto roda
    expect((await app.inject({ method: "DELETE", url: `/api/prospecting/searches/${id}`, headers: auth() })).statusCode).toBe(409);
    const imp = await app.inject({
      method: "POST",
      url: `/api/prospecting/searches/${id}/import`,
      headers: auth(),
      payload: { indexes: [0] },
    });
    expect(imp.statusCode).toBe(409);

    const canceled = await app.inject({ method: "POST", url: `/api/prospecting/searches/${id}/cancel`, headers: auth() });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().status).toBe("canceled");
    await env.settle();

    // A resposta que chegasse depois do cancelamento não muda nada
    pending.finish({ prospects: [prospect({ phone: "11988887777" })], notes: "" });
    const after = await getSearch(id);
    expect(after.status).toBe("canceled");
    expect(after.results).toEqual([]);

    const again = await app.inject({ method: "POST", url: `/api/prospecting/searches/${id}/cancel`, headers: auth() });
    expect(again.statusCode).toBe(409);

    // Liberou para uma nova pesquisa
    env.claude.researchHandler = () => ({ prospects: [], notes: "" });
    expect((await startSearch()).statusCode).toBe(202);
    await env.settle();

    const del = await app.inject({ method: "DELETE", url: `/api/prospecting/searches/${id}`, headers: auth() });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/prospecting/searches/${id}`, headers: auth() })).statusCode).toBe(404);
  });

  it("falha da IA fica registrada na pesquisa", async () => {
    env.claude.researchHandler = () => {
      throw new AiError("Limite de uso do Claude atingido. Tente de novo mais tarde.");
    };
    const id = (await startSearch()).json().search.id;
    await env.settle();
    const search = await getSearch(id);
    expect(search.status).toBe("failed");
    expect(search.error).toBe("Limite de uso do Claude atingido. Tente de novo mais tarde.");
  });

  it("importa como leads (origem prospeccao-ia, modo humano, anotações) sem entrar em 'lead criado'", async () => {
    // Automação de boas-vindas ativa: leads comuns entram, prospectados não
    const [welcome] = await env.ctx.db.select().from(sequences).where(eq(sequences.trigger, "lead_created"));
    await env.ctx.db.update(sequences).set({ active: true }).where(eq(sequences.id, welcome!.id));
    const existing = (
      await app.inject({ method: "POST", url: "/api/leads", headers: auth(), payload: { phone: "11977776666", source: "formulario" } })
    ).json();
    expect(await env.ctx.db.select().from(enrollments).where(eq(enrollments.leadId, existing.id))).toHaveLength(1);

    const search = await finishedSearch([
      prospect({
        company: "Clínica Sorriso",
        contactName: "Dra. Ana",
        phone: "(11) 98888-7777",
        website: "https://sorriso.com.br",
        instagram: "@clinicasorriso",
        address: "Rua dos Pinheiros, 100",
        score: 90,
      }),
      prospect({ company: "Odonto Center", phone: "(11) 97777-6666", score: 80 }),
      prospect({ company: "Dental Mail", email: "Contato@DentalMail.com.br", score: 70 }),
      prospect({ company: "Só Site", website: "https://sosite.com.br", score: 60 }),
    ]);
    expect(search.results.map((r: { company: string }) => r.company)).toEqual([
      "Clínica Sorriso",
      "Odonto Center",
      "Dental Mail",
      "Só Site",
    ]);
    expect(search.results[1].duplicateLeadId).toBe(existing.id);

    const stages = (await app.inject({ method: "GET", url: "/api/stages", headers: auth() })).json();
    const qualificando = stages.find((s: { name: string }) => s.name === "Qualificando");
    const res = await app.inject({
      method: "POST",
      url: `/api/prospecting/searches/${search.id}/import`,
      headers: auth(),
      payload: { indexes: [0, 1, 2, 3, 0], stageId: qualificando.id },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.created).toBe(2);
    expect(out.skipped).toBe(0);
    expect(out.sendSkipped).toEqual([]);
    expect(out.queued).toBe(0);
    expect(out.lastSendAt).toBeNull();
    expect(out.errors).toEqual([
      { index: 1, error: `Já existe um lead com este telefone (#${existing.id}).` },
      { index: 3, error: "Sem telefone nem e-mail: não dá para criar o lead." },
    ]);

    const [lead] = await env.ctx.db.select().from(leads).where(eq(leads.id, out.ids[0]));
    expect(lead).toMatchObject({
      name: "Dra. Ana",
      company: "Clínica Sorriso",
      phone: "5511988887777",
      source: "prospeccao-ia",
      chatMode: "human",
      stageId: qualificando.id,
      interest: "Sistema de agendamento online",
      tags: ["clínicas odontológicas", "são paulo"],
    });
    expect(lead!.notes).toContain("Por que tem fit: Agenda pelo telefone.");
    expect(lead!.notes).toContain("Sugestão de abordagem:");
    expect(lead!.notes).toContain("Site: https://sorriso.com.br/");
    expect(lead!.notes).toContain("Instagram: https://www.instagram.com/clinicasorriso/");
    expect(lead!.notes).toContain("- https://maps.google.com/?cid=1");
    const [mailLead] = await env.ctx.db.select().from(leads).where(eq(leads.id, out.ids[1]));
    expect(mailLead).toMatchObject({ phone: null, email: "contato@dentalmail.com.br", company: "Dental Mail" });

    // Nenhum prospectado entrou na automação de boas-vindas
    for (const id of out.ids) {
      expect(await env.ctx.db.select().from(enrollments).where(eq(enrollments.leadId, id))).toHaveLength(0);
    }

    const saved = await getSearch(search.id);
    expect(saved.results[0].leadId).toBe(out.ids[0]);
    expect(saved.results[2].leadId).toBe(out.ids[1]);
    expect(saved.results[1]).toMatchObject({ leadId: null, duplicateLeadId: existing.id });

    // Importar de novo: os já importados são pulados
    const again = (
      await app.inject({
        method: "POST",
        url: `/api/prospecting/searches/${search.id}/import`,
        headers: auth(),
        payload: { indexes: [0, 2, 9] },
      })
    ).json();
    expect(again).toMatchObject({ created: 0, ids: [], skipped: 2, sendSkipped: [], queued: 0, lastSendAt: null, errors: [{ index: 9, error: "Resultado não encontrado." }] });
    expect(await env.ctx.db.select().from(leads).where(eq(leads.source, "prospeccao-ia"))).toHaveLength(2);
  });

  it("na subida, pesquisas que estavam rodando viram 'interrompidas'", async () => {
    const [orphan] = await env.ctx.db
      .insert(prospectSearches)
      .values({ criteria: { ...criteria, extra: "" }, progress: "3 buscas" })
      .returning();
    expect(await recoverInterruptedSearches(env.ctx)).toBe(1);
    const [row] = await env.ctx.db.select().from(prospectSearches).where(eq(prospectSearches.id, orphan!.id));
    expect(row).toMatchObject({ status: "failed", error: "Interrompida: o servidor reiniciou.", progress: null });
    expect(row!.finishedAt).toBeTruthy();

    // Uma pesquisa viva neste processo não é tocada
    const pending = pendingResearch();
    const id = (await startSearch()).json().search.id;
    expect(await recoverInterruptedSearches(env.ctx)).toBe(0);
    expect((await getSearch(id)).status).toBe("running");
    pending.finish({ prospects: [], notes: "" });
    await env.settle();
  });

  it("confere o WhatsApp dos resultados: tem, não tem e não verificado (sem telefone ou conferência falhou)", async () => {
    env.wa.missingNumbers.add("5531994235519");
    const check = vi.spyOn(env.wa, "checkNumber");
    check.mockImplementation(async (phone) => {
      if (phone === "5521988887777") throw new Error("instância desconectada");
      return { exists: !env.wa.missingNumbers.has(phone), jid: null };
    });
    const search = await finishedSearch([
      prospect({ company: "Com zap", phone: "(11) 98888-7777", score: 90 }),
      // O caso real: ficha com o celular antigo de 8 dígitos, sem WhatsApp
      prospect({ company: "Sem zap", phone: "(31) 99423-5519", score: 80 }),
      prospect({ company: "Falhou", phone: "(21) 98888-7777", score: 70 }),
      prospect({ company: "Só e-mail", email: "oi@soemail.com.br", score: 60 }),
    ]);
    expect(search.status).toBe("done");
    expect(search.results.map((r: ProspectResult) => [r.company, r.whatsapp])).toEqual([
      ["Com zap", "yes"],
      ["Sem zap", "no"],
      ["Falhou", null],
      ["Só e-mail", null],
    ]);
    // Só os que têm telefone são conferidos
    expect(check.mock.calls.map(([phone]) => phone).sort()).toEqual(["5511988887777", "5521988887777", "5531994235519"]);
  });

  it("conferência que falha para todos ou provedor sem conferência (Meta): a pesquisa termina normalmente", async () => {
    vi.spyOn(env.wa, "checkNumber").mockRejectedValue(new Error("Evolution fora do ar"));
    let search = await finishedSearch([prospect({ company: "A", phone: "(11) 98888-7777" })]);
    expect(search).toMatchObject({ status: "done", error: null });
    expect(search.results[0]).toMatchObject({ company: "A", phone: "5511988887777", whatsapp: null });

    env.ctx.wa = new MetaCloudProvider({ accessToken: "t", phoneNumberId: "1", graphVersion: "v21.0" });
    search = await finishedSearch([prospect({ company: "B", phone: "(11) 97777-6666" })]);
    expect(search).toMatchObject({ status: "done" });
    expect(search.results[0]).toMatchObject({ company: "B", whatsapp: null });
  });

  it("conferência que demora não passa do limite de tempo: o que não deu tempo fica não verificado", async () => {
    const results = [
      { phone: "5511988887777", whatsapp: null },
      { phone: "5511977776666", whatsapp: null },
      { phone: "", whatsapp: null },
    ] as ProspectResult[];
    vi.spyOn(env.wa, "checkNumber").mockImplementation(async (phone) =>
      phone === "5511988887777" ? { exists: true } : new Promise(() => {}),
    );
    const started = Date.now();
    const out = await checkProspectsWhatsApp(env.ctx, results, { budgetMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.map((r) => r.whatsapp)).toEqual(["yes", null, null]);
    // Não mexe na lista original
    expect(results.map((r) => r.whatsapp)).toEqual([null, null, null]);
  });

  it("verificar WhatsApp de uma pesquisa antiga (resultados sem o campo) e avisar o painel", async () => {
    const [old] = await env.ctx.db
      .insert(prospectSearches)
      .values({
        criteria: { ...criteria, extra: "" },
        status: "done",
        finishedAt: env.ctx.now(),
        // Como a pesquisa #1: gravada antes da verificação, sem "whatsapp"
        results: [
          { ...prospect({ company: "Com zap", phone: "5511988887777" }), rawPhone: "", isMobile: true, duplicateLeadId: null, leadId: null },
          { ...prospect({ company: "Sem zap", phone: "5531994235519" }), rawPhone: "", isMobile: true, duplicateLeadId: null, leadId: null },
          { ...prospect({ company: "Só site", website: "https://x.com.br/" }), rawPhone: "", isMobile: false, duplicateLeadId: null, leadId: null },
        ] as ProspectResult[],
      })
      .returning();
    // Lida como "não verificado"
    expect((await getSearch(old!.id)).results.map((r: ProspectResult) => r.whatsapp)).toEqual([null, null, null]);

    env.wa.missingNumbers.add("5531994235519");
    const updates: unknown[] = [];
    env.ctx.events.subscribe((e) => {
      if (e.type === "prospect.updated") updates.push(e.data.search);
    });
    const res = await app.inject({ method: "POST", url: `/api/prospecting/searches/${old!.id}/check-whatsapp`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ yes: 1, no: 1, unchecked: 0 });
    expect(res.json().search.results.map((r: ProspectResult) => r.whatsapp)).toEqual(["yes", "no", null]);
    expect((await getSearch(old!.id)).results.map((r: ProspectResult) => r.whatsapp)).toEqual(["yes", "no", null]);
    expect(updates).toEqual([expect.objectContaining({ id: old!.id, status: "done", resultCount: 3 })]);

    // Conferir de novo com o WhatsApp fora do ar não apaga o que já foi conferido
    vi.spyOn(env.wa, "checkNumber").mockRejectedValue(new Error("desconectado"));
    const again = await app.inject({ method: "POST", url: `/api/prospecting/searches/${old!.id}/check-whatsapp`, headers: auth() });
    expect(again.json()).toMatchObject({ yes: 1, no: 1, unchecked: 0 });
  });

  it("verificar WhatsApp: só pesquisa pronta, só com provedor que confere, 404 para inexistente", async () => {
    const pending = pendingResearch();
    const id = (await startSearch()).json().search.id;
    const url = `/api/prospecting/searches/${id}/check-whatsapp`;
    expect((await app.inject({ method: "POST", url, headers: auth() })).statusCode).toBe(409);
    pending.finish({ prospects: [prospect({ phone: "11988887777" })], notes: "" });
    await env.settle();
    expect((await app.inject({ method: "POST", url, headers: auth() })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/api/prospecting/searches/999/check-whatsapp", headers: auth() })).statusCode,
    ).toBe(404);

    env.ctx.wa = new MetaCloudProvider({ accessToken: "t", phoneNumberId: "1", graphVersion: "v21.0" });
    const meta = await app.inject({ method: "POST", url, headers: auth() });
    expect(meta.statusCode).toBe(400);
    expect(meta.json().error).toMatch(/não confere números/);
  });

  it("telefones da fonte: celular preferido, 0800 e números sem DDD descartados", () => {
    expect(parseProspectPhone("(11) 3333-4444 / (11) 99999-8888")).toBe("5511999998888");
    expect(parseProspectPhone("(011) 3333-4444")).toBe("551133334444");
    expect(parseProspectPhone("+1 415 555 1234")).toBe("14155551234");
    expect(parseProspectPhone("0800 123 4567")).toBe("");
    expect(parseProspectPhone("4004-1234")).toBe("");
    expect(parseProspectPhone("99999-8888")).toBe("");
    expect(parseProspectPhone("")).toBe("");
  });

  it("import com firstMessage cria scheduled_messages espaçados com author automation e variáveis substituídas; leads já existentes não recebem", async () => {
    // 1. Cria um lead que já existe no CRM
    const existing = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Carlos Antigo", company: "Empresa Antiga", phone: "(11) 97777-6666" },
      })
    ).json();

    // 2. Pesquisa finalizada com:
    // Prospect 0: novo com celular, nome e empresa
    // Prospect 1: novo com celular e empresa, sem nome pessoal
    // Prospect 2: número do lead que já existe
    // Prospect 3: só e-mail (vira lead, mas sem telefone -> scheduleFirstMessages pula)
    const search = await finishedSearch([
      prospect({
        company: "Clínica Sorriso",
        contactName: "Ana",
        phone: "(11) 98888-7777",
      }),
      prospect({
        company: "Odonto Bruno",
        phone: "(11) 98888-9999",
      }),
      prospect({
        company: "Empresa Duplicada",
        phone: "(11) 97777-6666",
      }),
      prospect({
        company: "Dental Mail",
        email: "contato@dentalmail.com.br",
      }),
    ]);

    // Validação: firstMessage com send: true e texto vazio retorna 400
    const badRes = await app.inject({
      method: "POST",
      url: `/api/prospecting/searches/${search.id}/import`,
      headers: auth(),
      payload: {
        indexes: [0],
        firstMessage: { send: true, text: "   " },
      },
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json().error).toBe("Escreva a primeira mensagem antes de disparar.");

    // Fixa data e hora às 12:00 São Paulo (15:00 UTC) dentro da janela de envio
    env.setNow(new Date("2026-10-09T15:00:00.000Z"));

    const res = await app.inject({
      method: "POST",
      url: `/api/prospecting/searches/${search.id}/import`,
      headers: auth(),
      payload: {
        indexes: [0, 1, 2, 3],
        firstMessage: {
          send: true,
          text: "Olá {primeiro_nome}, vi o trabalho da {empresa}!",
          intervalMinutes: 10,
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.created).toBe(3); // 0, 1 e 3 criados; 2 é duplicado
    expect(out.queued).toBe(2); // 0 e 1 agendados; 3 não tem telefone
    expect(out.sendSkipped).toEqual([
      { leadId: out.ids[2], reason: "sem telefone" },
    ]);
    expect(out.lastSendAt).toBeDefined();

    // Mensagens criadas no banco
    const [sm0] = await env.ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.leadId, out.ids[0]));
    expect(sm0).toBeDefined();
    expect(sm0!.body).toBe("Olá Ana, vi o trabalho da Clínica Sorriso!");
    expect(sm0!.author).toBe("automation");
    expect(sm0!.sendAt.toISOString()).toBe("2026-10-09T15:00:00.000Z");

    const [sm1] = await env.ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.leadId, out.ids[1]));
    expect(sm1).toBeDefined();
    // Sem nome: limpa a variável {primeiro_nome} e pontuação de forma limpa
    expect(sm1!.body).toBe("Olá, vi o trabalho da Odonto Bruno!");
    expect(sm1!.author).toBe("automation");
    const sendAt1 = sm1!.sendAt.getTime();
    const baseTime = new Date("2026-10-09T15:00:00.000Z").getTime();
    // 10 minutos ±15% = [8.5 min .. 11.5 min]
    expect(sendAt1).toBeGreaterThanOrEqual(baseTime + 8.5 * 60_000);
    expect(sendAt1).toBeLessThanOrEqual(baseTime + 11.5 * 60_000);

    // O lead já existente NÃO recebe mensagem agendada
    const existingSm = await env.ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.leadId, existing.id));
    expect(existingSm).toHaveLength(0);

    // O lead sem telefone NÃO recebe mensagem agendada
    const noPhoneSm = await env.ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.leadId, out.ids[2]));
    expect(noPhoneSm).toHaveLength(0);
  });
});
