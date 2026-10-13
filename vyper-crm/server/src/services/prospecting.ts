import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { AiError, type AiProvider, AiRefusalError, AiUnavailableError, type ResearchProgress } from "../ai/provider.js";
import { prospectPrompt, prospectSystem } from "../ai/prompts.js";
import { prospectSchema, type ProspectOutput } from "../ai/schemas.js";
import type { AppContext } from "../context.js";
import {
  prospectSearches,
  type Lead,
  type ProspectCriteria,
  type ProspectResult,
  type ProspectSearch,
  type ProspectWhatsApp,
} from "../db/schema.js";
import { asPhoneInput, normalizePhone } from "../lib/phone.js";
import { getSettings } from "../settings.js";
import { createLead, findLeadByPhone, HttpError } from "./leads.js";
import { scheduleFirstMessages } from "./outreach.js";

export type { ProspectCriteria, ProspectResult, ProspectSearch, ProspectWhatsApp };

/** Origem dos leads importados da prospecção (as automações de "lead criado" ignoram essa origem). */
export const PROSPECT_SOURCE = "prospeccao-ia";

/**
 * Quem faz a pesquisa na web: o Claude Code (assinatura, ctx.claude) e, sem ele, a IA principal se ela pesquisar
 * (ex.: ANTHROPIC_API_KEY). null = ninguém pesquisa.
 */
export function researchProvider(ctx: AppContext): AiProvider | null {
  if (ctx.claude?.research) return ctx.claude;
  return ctx.ai.research ? ctx.ai : null;
}

export const prospectCriteriaSchema = z.object({
  niche: z.string().trim().min(2).max(200),
  location: z.string().trim().min(2).max(200),
  size: z.string().trim().max(100).default(""),
  offer: z.string().trim().max(1000).default(""),
  quantity: z.number().int().min(1).max(25).default(10),
  extra: z.string().trim().max(1000).default(""),
});

/** Pesquisa sem a lista de resultados (para o histórico e para os eventos do painel). */
export type ProspectSearchSummary = Omit<ProspectSearch, "results"> & { resultCount: number };

export function summarizeSearch(row: ProspectSearch): ProspectSearchSummary {
  const { results, ...rest } = row;
  return { ...rest, resultCount: results.length };
}

// Pesquisas em andamento neste processo (por contexto: os testes sobem vários na mesma execução)
const controllers = new WeakMap<AppContext, Map<number, AbortController>>();
// Importação e verificação do WhatsApp regravam a lista de resultados: uma por pesquisa de cada vez
const busySearches = new WeakMap<AppContext, Map<number, "import" | "whatsapp">>();

async function withSearchLock<T>(ctx: AppContext, id: number, kind: "import" | "whatsapp", fn: () => Promise<T>): Promise<T> {
  let busy = busySearches.get(ctx);
  if (!busy) busySearches.set(ctx, (busy = new Map()));
  const current = busy.get(id);
  if (current) {
    throw new HttpError(
      409,
      current === "import"
        ? "Esta importação já está em andamento."
        : "A verificação do WhatsApp desta prospecção já está em andamento.",
    );
  }
  busy.set(id, kind);
  try {
    return await fn();
  } finally {
    busy.delete(id);
  }
}

function runningOf(ctx: AppContext): Map<number, AbortController> {
  let map = controllers.get(ctx);
  if (!map) controllers.set(ctx, (map = new Map()));
  return map;
}

const PROGRESS_INTERVAL_MS = 3_000;

function emitUpdated(ctx: AppContext, row: ProspectSearch): void {
  ctx.events.emit("prospect.updated", { search: summarizeSearch(row) });
}

/** Resultados gravados antes da verificação do WhatsApp não têm o campo: ausente = não verificado (null). */
function withDefaults(row: ProspectSearch): ProspectSearch {
  return { ...row, results: row.results.map((r) => ({ ...r, whatsapp: r.whatsapp ?? null })) };
}

export async function getProspectSearch(ctx: AppContext, id: number): Promise<ProspectSearch> {
  const [row] = await ctx.db.select().from(prospectSearches).where(eq(prospectSearches.id, id));
  if (!row) throw new HttpError(404, "Prospecção não encontrada.");
  return withDefaults(row);
}

export async function listProspectSearches(ctx: AppContext, limit = 50): Promise<ProspectSearchSummary[]> {
  return ctx.db
    .select({
      id: prospectSearches.id,
      status: prospectSearches.status,
      criteria: prospectSearches.criteria,
      progress: prospectSearches.progress,
      error: prospectSearches.error,
      createdBy: prospectSearches.createdBy,
      createdAt: prospectSearches.createdAt,
      finishedAt: prospectSearches.finishedAt,
      resultCount: sql<number>`jsonb_array_length(${prospectSearches.results})::int`,
    })
    .from(prospectSearches)
    .orderBy(desc(prospectSearches.id))
    .limit(limit);
}

/**
 * Cria a pesquisa e roda a IA em segundo plano (pode levar vários minutos).
 * O andamento chega ao painel pelo evento "prospect.updated".
 */
export async function startProspectSearch(
  ctx: AppContext,
  criteria: ProspectCriteria,
  userId: number | null,
): Promise<ProspectSearch> {
  if (!researchProvider(ctx)) {
    throw new HttpError(
      503,
      "A prospecção usa o Claude Code: defina CLAUDE_CODE_ENABLED=true no .env (sua assinatura do Claude, com o Claude " +
        "Code instalado e logado) e reinicie o CRM.",
    );
  }
  const [row] = await ctx.db
    .insert(prospectSearches)
    .values({ criteria, createdBy: userId, progress: "Iniciando a pesquisa…", createdAt: ctx.now() })
    .onConflictDoNothing() // índice único: só uma pesquisa "running" por vez
    .returning();
  if (!row) throw new HttpError(409, "Já existe uma prospecção em andamento. Espere terminar ou cancele.");

  const controller = new AbortController();
  runningOf(ctx).set(row.id, controller);
  emitUpdated(ctx, row);
  ctx.jobs.schedule(`prospect:${row.id}`, 0, () => runSearch(ctx, row.id, criteria, controller));
  return row;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function progressText(p: ResearchProgress): string {
  const counts = `${plural(p.searches, "busca", "buscas")}, ${plural(p.fetches, "página lida", "páginas lidas")}`;
  const last = p.lastAction?.replace(/\s+/g, " ").trim();
  return last ? `${counts} — última: ${last.length > 120 ? `${last.slice(0, 119)}…` : last}` : counts;
}

/** Só mexe na linha se ela ainda estiver rodando (um cancelamento no meio do caminho prevalece). */
async function updateIfRunning(
  ctx: AppContext,
  id: number,
  patch: Partial<typeof prospectSearches.$inferInsert>,
): Promise<ProspectSearch | undefined> {
  const [row] = await ctx.db
    .update(prospectSearches)
    .set(patch)
    .where(and(eq(prospectSearches.id, id), eq(prospectSearches.status, "running")))
    .returning();
  if (row) emitUpdated(ctx, row);
  return row;
}

function publicErrorMessage(ctx: AppContext, id: number, err: unknown): string {
  if (
    err instanceof AiError ||
    err instanceof AiRefusalError ||
    err instanceof AiUnavailableError ||
    err instanceof HttpError
  ) {
    return err.message;
  }
  ctx.log.error({ err: String(err), searchId: id }, "erro inesperado na prospecção");
  return "Erro inesperado na pesquisa. Veja os logs do servidor.";
}

async function runSearch(
  ctx: AppContext,
  id: number,
  criteria: ProspectCriteria,
  controller: AbortController,
): Promise<void> {
  // Andamento com no máximo uma gravação a cada 3 s; a última sempre é gravada
  let lastSaved = 0;
  let latest: ResearchProgress | null = null;
  let timer: NodeJS.Timeout | null = null;
  const flushProgress = () => {
    timer = null;
    if (!latest || controller.signal.aborted) return;
    lastSaved = Date.now();
    const text = progressText(latest);
    latest = null;
    updateIfRunning(ctx, id, { progress: text }).catch((err) =>
      ctx.log.warn({ err: String(err), searchId: id }, "falha ao gravar o andamento da prospecção"),
    );
  };
  const onProgress = (p: ResearchProgress) => {
    latest = { ...p };
    if (timer) return;
    const wait = PROGRESS_INTERVAL_MS - (Date.now() - lastSaved);
    if (wait <= 0) flushProgress();
    else timer = setTimeout(flushProgress, wait);
  };

  try {
    const provider = researchProvider(ctx);
    if (!provider?.research) throw new AiUnavailableError();
    const settings = await getSettings(ctx.db);
    const out = await provider.research({
      task: "prospect",
      system: prospectSystem(settings),
      prompt: prospectPrompt(criteria),
      schema: prospectSchema,
      effort: "medium",
      signal: controller.signal,
      onProgress,
    });
    if (timer) clearTimeout(timer);
    let results = await processProspects(ctx, out.prospects, criteria.quantity);
    // Confere quem tem WhatsApp antes de mostrar (falhas e demora não derrubam a pesquisa)
    if (ctx.wa.checkNumber && results.some((r) => r.phone) && !controller.signal.aborted) {
      await updateIfRunning(ctx, id, { progress: "Conferindo quem tem WhatsApp…" });
      results = await checkProspectsWhatsApp(ctx, results, { signal: controller.signal });
    }
    await updateIfRunning(ctx, id, {
      status: "done",
      results,
      progress: out.notes.trim().slice(0, 2000) || null,
      finishedAt: ctx.now(),
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (controller.signal.aborted) {
      await updateIfRunning(ctx, id, { status: "canceled", progress: null, finishedAt: ctx.now() });
    } else {
      await updateIfRunning(ctx, id, {
        status: "failed",
        error: publicErrorMessage(ctx, id, err),
        progress: null,
        finishedAt: ctx.now(),
      });
    }
  } finally {
    runningOf(ctx).delete(id);
  }
}

// ---- Tratamento do que a IA trouxe ----

const NON_GEOGRAPHIC = /^0?(300|500|800|900)/;

/** Um telefone do texto da fonte → dígitos com DDI, ou "" se não der para confiar no número. */
function parseOnePhone(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  const international = /^(\+|00)/.test(text);
  let digits = text.replace(/\D/g, "");
  if (!international) {
    // 0800, 0300, 4004-xxxx...: não são números de WhatsApp
    if (NON_GEOGRAPHIC.test(digits) || digits.length < 10) return "";
    // Prefixo de discagem nacional: "(011) 3333-4444" → 1133334444
    if (/^0\d{10,11}$/.test(digits)) digits = digits.slice(1);
  }
  const phone = normalizePhone(international ? text : digits);
  if (!phone) return "";
  // Sem DDI explícito, só números brasileiros; DDD brasileiro nunca termina em 0
  if (!international && !phone.startsWith("55")) return "";
  if (phone.startsWith("55") && !/^55[1-9][1-9]\d{8,9}$/.test(phone)) return "";
  return phone;
}

export function isBrazilianMobile(phone: string): boolean {
  return /^55\d{2}9\d{8}$/.test(phone);
}

/** A fonte pode listar vários números ("(11) 3333-4444 / (11) 99999-8888"): prefere o celular. */
export function parseProspectPhone(raw: string): string {
  const candidates = raw
    .split(/\s*(?:\/|,|;|\||\bou\b|\be\b)\s*/i)
    .map(parseOnePhone)
    .filter(Boolean);
  return candidates.find(isBrazilianMobile) ?? candidates[0] ?? "";
}

function clip(value: string, max: number): string {
  const v = value.replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/** Só links http(s) (nada de "javascript:" chegando ao painel). */
function safeUrl(value: string): string {
  let v = value.trim();
  if (!v) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = `https://${v.replace(/^\/+/, "")}`;
  try {
    const url = new URL(v);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.hostname.includes(".")) return "";
    return url.toString().slice(0, 500);
  } catch {
    return "";
  }
}

function instagramUrl(value: string): string {
  const v = value.trim();
  const handle = v.match(/^@?([A-Za-z0-9._]{1,30})$/);
  if (handle) return `https://www.instagram.com/${handle[1]}/`;
  const url = safeUrl(v);
  return url && /(^|\.)instagram\.com$/i.test(new URL(url).hostname) ? url : "";
}

function cleanEmail(value: string): string {
  const v = value.trim().replace(/^mailto:/i, "").toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/.test(v) && v.length <= 200 ? v : "";
}

function dedupeKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Limpa e confere os resultados: telefone normalizado (o original fica em rawPhone), links seguros,
 * nota entre 0 e 100, sem repetidos, sem empresas sem nenhum contato, e marca quem já é lead.
 */
export async function processProspects(
  ctx: AppContext,
  prospects: ProspectOutput["prospects"],
  quantity: number,
): Promise<ProspectResult[]> {
  const cleaned = prospects
    .map((p) => {
      const phone = parseProspectPhone(p.phone);
      return {
        company: clip(p.company, 200),
        contactName: clip(p.contactName, 200),
        phone,
        rawPhone: clip(p.phone, 100),
        isMobile: isBrazilianMobile(phone),
        email: cleanEmail(p.email),
        website: safeUrl(p.website),
        instagram: instagramUrl(p.instagram),
        address: clip(p.address, 300),
        city: clip(p.city, 120),
        size: clip(p.size, 200),
        fitReason: clip(p.fitReason, 1000),
        approach: p.approach.trim().slice(0, 1000),
        score: Math.max(0, Math.min(100, Math.round(Number.isFinite(p.score) ? p.score : 0))),
        sources: [...new Set(p.sources.map(safeUrl).filter(Boolean))].slice(0, 10),
        duplicateLeadId: null as number | null,
        leadId: null as number | null,
        whatsapp: null as ProspectWhatsApp | null,
      };
    })
    .filter((p) => p.phone || p.email || p.website || p.instagram)
    .sort((a, b) => b.score - a.score);

  // Mesma empresa repetida (mesmo telefone, ou mesmo nome na mesma cidade): fica a de nota maior
  const seen = new Set<string>();
  const unique: ProspectResult[] = [];
  for (const p of cleaned) {
    const keys = [p.phone && `tel:${p.phone}`, p.company && `emp:${dedupeKey(p.company)}|${dedupeKey(p.city)}`].filter(
      Boolean,
    ) as string[];
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    unique.push(p);
    if (unique.length >= quantity) break;
  }

  for (const p of unique) {
    if (p.phone) p.duplicateLeadId = (await findLeadByPhone(ctx.db, p.phone))?.id ?? null;
  }
  return unique;
}

// ---- Conferir quem tem WhatsApp ----

/** Tempo máximo da verificação de uma pesquisa inteira (o que não deu tempo fica "não verificado"). */
export const WHATSAPP_CHECK_BUDGET_MS = 30_000;
const WHATSAPP_CHECK_CONCURRENCY = 3;

/**
 * Confere no WhatsApp cada resultado com telefone: whatsapp "yes"/"no". Tolerante: se a conferência
 * falhar (desconectado, fora do ar) ou o tempo acabar, o resultado fica como estava (null = não verificado).
 * Devolve uma cópia; sem checkNumber no provedor (API da Meta), devolve a lista sem mudanças.
 */
export async function checkProspectsWhatsApp(
  ctx: AppContext,
  results: ProspectResult[],
  opts: { budgetMs?: number; signal?: AbortSignal } = {},
): Promise<ProspectResult[]> {
  const out = results.map((r) => ({ ...r, whatsapp: r.whatsapp ?? null }));
  const check = ctx.wa.checkNumber?.bind(ctx.wa);
  if (!check) return out;
  const found = new Map<number, ProspectWhatsApp>();
  const queue = out.map((r, i) => ({ phone: r.phone, i })).filter((q) => q.phone);
  let stopped = false;
  const worker = async () => {
    for (let item = queue.shift(); item && !stopped && !opts.signal?.aborted; item = queue.shift()) {
      try {
        const { exists } = await check(item.phone);
        if (!stopped) found.set(item.i, exists ? "yes" : "no");
      } catch (err) {
        ctx.log.warn({ err: String(err), phone: item.phone }, "não deu para conferir o WhatsApp do resultado");
      }
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, opts.budgetMs ?? WHATSAPP_CHECK_BUDGET_MS);
  });
  const workers = Array.from({ length: Math.min(WHATSAPP_CHECK_CONCURRENCY, queue.length) }, worker);
  await Promise.race([Promise.all(workers), timeout]);
  stopped = true;
  clearTimeout(timer);
  if (queue.length > 0) ctx.log.warn({ left: queue.length }, "verificação do WhatsApp parou no limite de tempo");
  for (const [i, value] of found) out[i]!.whatsapp = value;
  return out;
}

/** Confere de novo o WhatsApp dos resultados de uma pesquisa pronta (ex.: pesquisas de antes da verificação). */
export async function recheckProspectsWhatsApp(
  ctx: AppContext,
  id: number,
): Promise<{ search: ProspectSearch; yes: number; no: number; unchecked: number }> {
  if (!ctx.wa.checkNumber) {
    throw new HttpError(400, "Este provedor de WhatsApp não confere números (só a Evolution e o simulador).");
  }
  return withSearchLock(ctx, id, "whatsapp", async () => {
    const search = await getProspectSearch(ctx, id);
    if (search.status !== "done") throw new HttpError(409, "Só dá para verificar depois que a pesquisa terminar.");
    const checked = await checkProspectsWhatsApp(ctx, search.results);
    const [row] = await ctx.db
      .update(prospectSearches)
      .set({ results: checked })
      .where(eq(prospectSearches.id, id))
      .returning();
    if (!row) throw new HttpError(404, "Prospecção não encontrada.");
    emitUpdated(ctx, row);
    const withPhone = checked.filter((r) => r.phone);
    return {
      search: withDefaults(row),
      yes: withPhone.filter((r) => r.whatsapp === "yes").length,
      no: withPhone.filter((r) => r.whatsapp === "no").length,
      unchecked: withPhone.filter((r) => r.whatsapp == null).length,
    };
  });
}

// ---- Cancelar, apagar, recuperar ----

export async function cancelProspectSearch(ctx: AppContext, id: number): Promise<ProspectSearch> {
  const current = await getProspectSearch(ctx, id);
  if (current.status !== "running") throw new HttpError(409, "Esta prospecção não está em andamento.");
  const row = await updateIfRunning(ctx, id, { status: "canceled", progress: null, finishedAt: ctx.now() });
  // Interrompe a IA (o processo da pesquisa é encerrado pelo provedor)
  runningOf(ctx).get(id)?.abort();
  return row ?? (await getProspectSearch(ctx, id));
}

export async function deleteProspectSearch(ctx: AppContext, id: number): Promise<void> {
  const current = await getProspectSearch(ctx, id);
  if (current.status === "running") throw new HttpError(409, "Cancele a prospecção antes de apagar.");
  await ctx.db.delete(prospectSearches).where(eq(prospectSearches.id, id));
}

/** Na subida do servidor: pesquisas que estavam rodando morreram junto com o processo anterior. */
export async function recoverInterruptedSearches(ctx: AppContext): Promise<number> {
  const live = [...runningOf(ctx).keys()];
  const rows = await ctx.db
    .update(prospectSearches)
    .set({ status: "failed", error: "Interrompida: o servidor reiniciou.", progress: null, finishedAt: ctx.now() })
    .where(
      and(
        eq(prospectSearches.status, "running"),
        live.length ? notInArray(prospectSearches.id, live) : undefined,
      ),
    )
    .returning({ id: prospectSearches.id });
  if (rows.length) ctx.log.warn({ ids: rows.map((r) => r.id) }, "prospecções interrompidas pelo reinício");
  return rows.length;
}

// ---- Importar como leads ----

function prospectNotes(r: ProspectResult, search: ProspectSearch): string {
  const lines = [
    `Encontrado pela prospecção com IA (pesquisa #${search.id}: ${search.criteria.niche} — ${search.criteria.location}).`,
    r.fitReason && `Por que tem fit: ${r.fitReason}`,
    r.approach && `Sugestão de abordagem:\n${r.approach}`,
    r.contactName && `Contato: ${r.contactName}`,
    r.size && `Porte: ${r.size}`,
    r.website && `Site: ${r.website}`,
    r.instagram && `Instagram: ${r.instagram}`,
    r.address && `Endereço: ${r.address}`,
    r.rawPhone && !r.phone && `Telefone na fonte (não validado): ${r.rawPhone}`,
    r.sources.length > 0 && `Fontes:\n${r.sources.map((s) => `- ${s}`).join("\n")}`,
  ];
  const text = lines.filter(Boolean).join("\n\n");
  return text.length > 5000 ? `${text.slice(0, 4999)}…` : text;
}

export interface ImportResult {
  created: number;
  ids: number[];
  // Já tinham sido importados antes
  skipped: number;
  errors: Array<{ index: number; error: string }>;
  queued: number;
  // Importados que não receberam a 1ª mensagem (sem telefone, sem WhatsApp...)
  sendSkipped: Array<{ leadId: number; reason: string }>;
  lastSendAt: string | null;
}

/** Cria leads a partir dos resultados escolhidos. Já importados são pulados; duplicados ficam marcados. */
export async function importProspects(
  ctx: AppContext,
  id: number,
  indexes: number[],
  opts: {
    stageId?: number;
    userId?: number | null;
    playbookId?: number | null;
    chatMode?: "bot" | "human";
    firstMessage?: {
      send: boolean;
      text: string;
      intervalMinutes?: number;
    };
  } = {},
): Promise<ImportResult> {
  return withSearchLock(ctx, id, "import", async () => {
    const search = await getProspectSearch(ctx, id);
    if (search.status !== "done") throw new HttpError(409, "Só dá para importar depois que a pesquisa terminar.");
    const results = search.results.map((r) => ({ ...r }));
    const out: ImportResult = {
      created: 0,
      ids: [],
      skipped: 0,
      errors: [],
      queued: 0,
      sendSkipped: [],
      lastSendAt: null,
    };
    const createdLeads: Lead[] = [];
    const niche = search.criteria.niche.trim().toLowerCase().slice(0, 50);

    for (const index of [...new Set(indexes)]) {
      const r = results[index];
      if (!r) {
        out.errors.push({ index, error: "Resultado não encontrado." });
        continue;
      }
      if (r.leadId) {
        out.skipped++;
        continue;
      }
      if (!r.phone && !r.email) {
        out.errors.push({ index, error: "Sem telefone nem e-mail: não dá para criar o lead." });
        continue;
      }
      const tags = [...new Set([niche, r.city.trim().toLowerCase().slice(0, 50)].filter(Boolean))];
      try {
        const lead = await createLead(
          ctx,
          {
            name: r.contactName || null,
            company: r.company || null,
            email: r.email || null,
            phone: r.phone ? asPhoneInput(r.phone) : null,
            source: PROSPECT_SOURCE,
            chatMode: opts.chatMode ?? "human",
            playbookId: opts.playbookId ?? null,
            stageId: opts.stageId,
            interest: search.criteria.offer.slice(0, 500) || null,
            tags,
            notes: prospectNotes(r, search),
          },
          { userId: opts.userId },
        );
        r.leadId = lead.id;
        out.created++;
        out.ids.push(lead.id);
        createdLeads.push(lead);
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 409 && r.phone) {
          r.duplicateLeadId = (await findLeadByPhone(ctx.db, r.phone))?.id ?? r.duplicateLeadId;
        }
        if (!(err instanceof HttpError)) ctx.log.error({ err: String(err), searchId: id, index }, "erro ao importar prospecção");
        out.errors.push({ index, error: err instanceof HttpError ? err.message : "Erro inesperado ao criar este lead." });
      }
    }

    const [row] = await ctx.db
      .update(prospectSearches)
      .set({ results })
      .where(eq(prospectSearches.id, id))
      .returning();
    if (row) emitUpdated(ctx, row);

    if (opts.firstMessage?.send && createdLeads.length > 0) {
      const scheduled = await scheduleFirstMessages(ctx, createdLeads, {
        text: opts.firstMessage.text,
        intervalMinutes: opts.firstMessage.intervalMinutes,
        userId: opts.userId,
      });
      out.queued = scheduled.queued;
      out.sendSkipped = scheduled.skipped;
      out.lastSendAt = scheduled.lastSendAt;
    }

    return out;
  });
}
