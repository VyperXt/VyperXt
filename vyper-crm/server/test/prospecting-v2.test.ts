import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leads } from "../src/db/schema.js";
import {
  isAllowedSocialOrWhatsappLink,
  passesHardFilters,
  type ProspectCriteria,
  type ProspectResult,
} from "../src/services/prospecting.js";
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

const baseCriteria: ProspectCriteria = {
  niche: "consultórios de psicologia",
  location: "Belo Horizonte, MG",
  size: "pequena",
  offer: "Plataforma de prontuário",
  quantity: 5,
  extra: "",
  excludeWithWebsite: false,
  requireWhatsapp: false,
  requireInstagram: false,
};

function dummyProspect(over: Partial<ProspectResult> = {}): ProspectResult {
  return {
    company: "Consultório Psi",
    contactName: "Dra. Paula",
    phone: "5531988887777",
    rawPhone: "(31) 98888-7777",
    isMobile: true,
    email: "paula@psi.com.br",
    website: "",
    bioLink: "",
    instagram: "https://www.instagram.com/dra.paula/",
    address: "Av. Afonso Pena, 1000",
    city: "Belo Horizonte",
    size: "pequena",
    fitReason: "Atendimento presencial e online.",
    approach: "Olá Dra. Paula!",
    score: 85,
    sources: ["https://maps.google.com/?cid=123"],
    duplicateLeadId: null,
    leadId: null,
    whatsapp: null,
    ...over,
  };
}

describe("passesHardFilters e isAllowedSocialOrWhatsappLink", () => {
  it("valida URLs de redes sociais e whatsapp permitidas", () => {
    expect(isAllowedSocialOrWhatsappLink("")).toBe(true);
    expect(isAllowedSocialOrWhatsappLink("https://wa.me/5531988887777")).toBe(true);
    expect(isAllowedSocialOrWhatsappLink("https://api.whatsapp.com/send?phone=5531988887777")).toBe(true);
    expect(isAllowedSocialOrWhatsappLink("https://whatsapp.com/channel/abc")).toBe(true);
    expect(isAllowedSocialOrWhatsappLink("https://instagram.com/meu.perfil")).toBe(true);
    expect(isAllowedSocialOrWhatsappLink("https://instagr.am/meu.perfil")).toBe(true);
    expect(isAllowedSocialOrWhatsappLink("https://facebook.com/minhapagina")).toBe(true);
    expect(isAllowedSocialOrWhatsappLink("https://fb.com/minhapagina")).toBe(true);
    expect(isAllowedSocialOrWhatsappLink("https://fb.me/minhapagina")).toBe(true);

    // Sites e agregadores reprovam
    expect(isAllowedSocialOrWhatsappLink("https://clinica.com.br")).toBe(false);
    expect(isAllowedSocialOrWhatsappLink("https://linktr.ee/clinica")).toBe(false);
    expect(isAllowedSocialOrWhatsappLink("https://beacons.ai/clinica")).toBe(false);
    expect(isAllowedSocialOrWhatsappLink("not a valid url")).toBe(false);
  });

  it("excludeWithWebsite: reprova quem tem site ou link de site/linktree na bio", () => {
    const c: ProspectCriteria = { ...baseCriteria, excludeWithWebsite: true };

    // Sem site nem bioLink -> passa
    expect(passesHardFilters(dummyProspect({ website: "", bioLink: "" }), c)).toBe(true);

    // Site próprio -> reprova
    expect(passesHardFilters(dummyProspect({ website: "https://clinicapsi.com.br" }), c)).toBe(false);

    // Linktree na bio -> reprova
    expect(passesHardFilters(dummyProspect({ bioLink: "https://linktr.ee/dra.paula" }), c)).toBe(false);

    // Beacons na bio -> reprova
    expect(passesHardFilters(dummyProspect({ bioLink: "https://beacons.ai/dra.paula" }), c)).toBe(false);

    // Link na bio apontando para WhatsApp ou Instagram -> passa
    expect(passesHardFilters(dummyProspect({ bioLink: "https://wa.me/5531988887777" }), c)).toBe(true);
    expect(passesHardFilters(dummyProspect({ website: "https://wa.me/5531988887777" }), c)).toBe(true);
  });

  it("requireWhatsapp: reprova sem telefone, com fixo ou com whatsapp === 'no'", () => {
    const c: ProspectCriteria = { ...baseCriteria, requireWhatsapp: true };

    // Sem telefone -> reprova
    expect(passesHardFilters(dummyProspect({ phone: "", isMobile: false }), c)).toBe(false);

    // Telefone fixo -> reprova
    expect(passesHardFilters(dummyProspect({ phone: "553133334444", isMobile: false }), c)).toBe(false);

    // Celular antes da checagem (whatsapp = null) -> passa
    expect(passesHardFilters(dummyProspect({ phone: "5531988887777", isMobile: true, whatsapp: null }), c)).toBe(true);

    // Celular com whatsapp = 'yes' -> passa
    expect(passesHardFilters(dummyProspect({ phone: "5531988887777", isMobile: true, whatsapp: "yes" }), c)).toBe(true);

    // Celular conferido que NÃO tem WhatsApp ('no') -> reprova
    expect(passesHardFilters(dummyProspect({ phone: "5531988887777", isMobile: true, whatsapp: "no" }), c)).toBe(false);
  });

  it("requireInstagram: reprova sem perfil no Instagram", () => {
    const c: ProspectCriteria = { ...baseCriteria, requireInstagram: true };

    expect(passesHardFilters(dummyProspect({ instagram: "" }), c)).toBe(false);
    expect(passesHardFilters(dummyProspect({ instagram: "   " }), c)).toBe(false);
    expect(passesHardFilters(dummyProspect({ instagram: "https://www.instagram.com/dra.paula/" }), c)).toBe(true);
  });
});

describe("várias rodadas de pesquisa com IA", () => {
  it("faz 2ª rodada com lista de exclusão quando 1ª rodada traz menos que o pedido", async () => {
    // Insere um lead pré-existente no CRM com source 'prospeccao-ia' para testar a inclusão na lista de exclusão
    await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: auth(),
      payload: { name: "Lead CRM", company: "Empresa Antiga CRM", phone: "(31) 97777-1111", source: "prospeccao-ia" },
    });

    let calls = 0;
    const promptsSent: string[] = [];
    env.claude.researchHandler = (req) => {
      calls++;
      promptsSent.push(req.prompt);
      if (calls === 1) {
        // 1ª rodada traz 2 empresas
        return {
          prospects: [
            dummyProspect({ company: "Psi Alfa", phone: "5531988881111" }),
            dummyProspect({ company: "Psi Beta", phone: "5531988882222" }),
          ],
          notes: "Poucos resultados na 1ª rodada.",
        };
      }
      // 2ª rodada traz mais 3 empresas para completar 5
      return {
        prospects: [
          dummyProspect({ company: "Psi Gama", phone: "5531988883333" }),
          dummyProspect({ company: "Psi Delta", phone: "5531988884444" }),
          dummyProspect({ company: "Psi Epsilon", phone: "5531988885555" }),
        ],
        notes: "Completado na 2ª rodada.",
      };
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/prospecting/searches",
      headers: auth(),
      payload: { ...baseCriteria, quantity: 5 },
    });
    expect(res.statusCode).toBe(202);
    const searchId = res.json().search.id;

    await env.settle();

    const search = (
      await app.inject({ method: "GET", url: `/api/prospecting/searches/${searchId}`, headers: auth() })
    ).json();

    expect(calls).toBe(2);
    expect(search.status).toBe("done");
    expect(search.results).toHaveLength(5);
    expect(search.results.map((r: ProspectResult) => r.company)).toEqual([
      "Psi Alfa",
      "Psi Beta",
      "Psi Gama",
      "Psi Delta",
      "Psi Epsilon",
    ]);

    // O prompt da 2ª rodada deve conter a lista de exclusão com as empresas da 1ª rodada e o lead do CRM
    const prompt2 = promptsSent[1];
    expect(prompt2).toContain("NÃO repita estas empresas (já encontradas ou já são clientes/leads):");
    expect(prompt2).toContain("Psi Alfa");
    expect(prompt2).toContain("Psi Beta");
    expect(prompt2).toContain("Empresa Antiga CRM");
  });

  it("já na 1ª rodada não traz de novo quem virou lead numa prospecção anterior", async () => {
    await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: auth(),
      payload: { name: "Lead CRM", company: "Empresa Antiga CRM", phone: "(31) 97777-1111", source: "prospeccao-ia" },
    });
    const prompts: string[] = [];
    env.claude.researchHandler = (req) => {
      prompts.push(req.prompt);
      return { prospects: [dummyProspect({ company: "Psi Nova", phone: "5531988881111" })], notes: "" };
    };
    await app.inject({ method: "POST", url: "/api/prospecting/searches", headers: auth(), payload: { ...baseCriteria, quantity: 1 } });
    await env.settle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Empresa Antiga CRM");
    expect(prompts[0]).toContain("Encontre 2 empresa(s)");
  });

  it("com requireWhatsapp, quem não tem WhatsApp abre vaga e a próxima rodada busca mais", async () => {
    const semWhats = new Set(["5531988882222"]);
    env.wa.checkNumber = async (phone: string) => ({ exists: !semWhats.has(phone), jid: `${phone}@s.whatsapp.net` });
    let calls = 0;
    env.claude.researchHandler = () => {
      calls++;
      return calls === 1
        ? {
            prospects: [
              dummyProspect({ company: "Psi Alfa", phone: "5531988881111" }),
              dummyProspect({ company: "Psi Beta", phone: "5531988882222" }),
            ],
            notes: "",
          }
        : { prospects: [dummyProspect({ company: "Psi Gama", phone: "5531988883333" })], notes: "" };
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/prospecting/searches",
      headers: auth(),
      payload: { ...baseCriteria, quantity: 2, requireWhatsapp: true },
    });
    await env.settle();
    const search = (
      await app.inject({ method: "GET", url: `/api/prospecting/searches/${res.json().search.id}`, headers: auth() })
    ).json();
    expect(calls).toBe(2);
    expect(search.results.map((r: ProspectResult) => r.company).sort()).toEqual(["Psi Alfa", "Psi Gama"]);
    expect(search.results.every((r: ProspectResult) => r.whatsapp === "yes")).toBe(true);
    expect(search.progress).toContain("1 sem WhatsApp");
  });

  it("para o loop se uma rodada não trouxer nenhuma empresa nova", async () => {
    let calls = 0;
    env.claude.researchHandler = () => {
      calls++;
      // Sempre retorna as mesmas 2 empresas
      return {
        prospects: [
          dummyProspect({ company: "Psi Repetida 1", phone: "5531988881111" }),
          dummyProspect({ company: "Psi Repetida 2", phone: "5531988882222" }),
        ],
        notes: "Nada mais na região.",
      };
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/prospecting/searches",
      headers: auth(),
      payload: { ...baseCriteria, quantity: 10 },
    });
    expect(res.statusCode).toBe(202);
    await env.settle();

    const search = (
      await app.inject({ method: "GET", url: `/api/prospecting/searches/${res.json().search.id}`, headers: auth() })
    ).json();

    // Rodada 1 traz 2. Rodada 2 traz 0 novas -> para o loop
    expect(calls).toBe(2);
    expect(search.status).toBe("done");
    expect(search.results).toHaveLength(2);
    expect(search.progress).toContain("Encontradas 2 de 10.");
  });

  it("se rodada > 1 falhar, mantém o que já foi aceito na rodada 1 e grava o erro nas notas", async () => {
    let calls = 0;
    env.claude.researchHandler = () => {
      calls++;
      if (calls === 1) {
        return {
          prospects: [dummyProspect({ company: "Psi Salva", phone: "5531988881111" })],
          notes: "Rodada 1 ok.",
        };
      }
      throw new Error("Timeout na conexão externa");
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/prospecting/searches",
      headers: auth(),
      payload: { ...baseCriteria, quantity: 5 },
    });
    expect(res.statusCode).toBe(202);
    await env.settle();

    const search = (
      await app.inject({ method: "GET", url: `/api/prospecting/searches/${res.json().search.id}`, headers: auth() })
    ).json();

    expect(search.status).toBe("done");
    expect(search.results).toHaveLength(1);
    expect(search.results[0].company).toBe("Psi Salva");
    expect(search.progress).toContain("Erro na rodada 2");
  });
});

describe("descarte de quem já é lead no CRM", () => {
  it("descarta quem já é lead no CRM e contabiliza nas notas", async () => {
    // Lead existente
    await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: auth(),
      payload: { name: "Cliente Atual", phone: "(31) 99999-0000" },
    });

    env.claude.researchHandler = () => ({
      prospects: [
        dummyProspect({ company: "Psi Já Cliente", phone: "(31) 99999-0000" }),
        dummyProspect({ company: "Psi Nova", phone: "(31) 98888-1111" }),
      ],
      notes: "",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/prospecting/searches",
      headers: auth(),
      payload: { ...baseCriteria, quantity: 2 },
    });
    expect(res.statusCode).toBe(202);
    await env.settle();

    const search = (
      await app.inject({ method: "GET", url: `/api/prospecting/searches/${res.json().search.id}`, headers: auth() })
    ).json();

    expect(search.results.map((r: ProspectResult) => r.company)).toEqual(["Psi Nova"]);
    expect(search.progress).toContain("Descartadas: 1 já era lead.");
  });
});

describe("PATCH e DELETE de resultados antes da importação", () => {
  let searchId: number;

  beforeEach(async () => {
    env.claude.researchHandler = () => ({
      prospects: [
        dummyProspect({ company: "Empresa 1", phone: "(31) 98888-1111" }),
        dummyProspect({ company: "Empresa 2", phone: "(31) 98888-2222" }),
      ],
      notes: "",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/prospecting/searches",
      headers: auth(),
      payload: { ...baseCriteria, quantity: 2 },
    });
    searchId = res.json().search.id;
    await env.settle();
  });

  it("PATCH atualiza e renormaliza telefone, limpa whatsapp se o número mudou e recalcula duplicateLeadId", async () => {
    // Cria um lead no CRM para testar recalcular duplicateLeadId
    const existing = (
      await app.inject({
        method: "POST",
        url: "/api/leads",
        headers: auth(),
        payload: { name: "Lead Existente", phone: "(31) 97777-8888" },
      })
    ).json();

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/prospecting/searches/${searchId}/results/0`,
      headers: auth(),
      payload: {
        company: "Empresa 1 Editada",
        phone: "(31) 97777-8888",
        email: "novo@empresa.com",
        city: "Nova Lima",
      },
    });

    expect(patchRes.statusCode).toBe(200);
    const updated = patchRes.json();
    expect(updated.company).toBe("Empresa 1 Editada");
    expect(updated.rawPhone).toBe("(31) 97777-8888");
    expect(updated.phone).toBe("5531977778888");
    expect(updated.isMobile).toBe(true);
    expect(updated.whatsapp).toBeNull();
    expect(updated.duplicateLeadId).toBe(existing.id);
    expect(updated.email).toBe("novo@empresa.com");
    expect(updated.city).toBe("Nova Lima");

    // Confere se persistiu
    const search = (
      await app.inject({ method: "GET", url: `/api/prospecting/searches/${searchId}`, headers: auth() })
    ).json();
    expect(search.results[0].company).toBe("Empresa 1 Editada");
  });

  it("PATCH retorna 400 para telefone inválido", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/prospecting/searches/${searchId}/results/0`,
      headers: auth(),
      payload: { phone: "12345" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Telefone inválido/);
  });

  it("PATCH e DELETE retornam 409 se o resultado já foi importado", async () => {
    // Importa o resultado 0
    await app.inject({
      method: "POST",
      url: `/api/prospecting/searches/${searchId}/import`,
      headers: auth(),
      payload: { indexes: [0] },
    });

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/prospecting/searches/${searchId}/results/0`,
      headers: auth(),
      payload: { company: "Tentativa" },
    });
    expect(patchRes.statusCode).toBe(409);
    expect(patchRes.json().error).toMatch(/já foi importado/);

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/prospecting/searches/${searchId}/results/0`,
      headers: auth(),
    });
    expect(delRes.statusCode).toBe(409);
    expect(delRes.json().error).toMatch(/já foi importado/);
  });

  it("DELETE remove o resultado da lista", async () => {
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/prospecting/searches/${searchId}/results/0`,
      headers: auth(),
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json()).toEqual({ ok: true });

    const search = (
      await app.inject({ method: "GET", url: `/api/prospecting/searches/${searchId}`, headers: auth() })
    ).json();
    expect(search.results).toHaveLength(1);
    expect(search.results[0].company).toBe("Empresa 2");
  });

  it("retorna 404 para índice ou pesquisa inexistente", async () => {
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/prospecting/searches/${searchId}/results/99`,
      headers: auth(),
      payload: { company: "Teste" },
    });
    expect(patchRes.statusCode).toBe(404);

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/prospecting/searches/9999/results/0`,
      headers: auth(),
    });
    expect(delRes.statusCode).toBe(404);
  });
});
