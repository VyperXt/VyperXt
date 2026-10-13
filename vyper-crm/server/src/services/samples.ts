import { randomBytes } from "node:crypto";
import { and, desc, eq, getTableColumns, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { AiError, AiRefusalError, AiUnavailableError } from "../ai/provider.js";
import { buildTranscript, samplePrompt, sampleSystem } from "../ai/prompts.js";
import { sampleImageSchema, sampleSiteSchema } from "../ai/schemas.js";
import type { AppContext } from "../context.js";
import { leads, leadSamples, type LeadSample, type SampleKind, type SampleTrigger } from "../db/schema.js";
import type { PublishedFile } from "../lib/publisher.js";
import { renderSvgToPng } from "../lib/render-image.js";
import { getSettings } from "../settings.js";
import { getLead, HttpError, stageOf, updateLead } from "./leads.js";
import { getConversation, sendImageToLead, sendToLead } from "./messaging.js";

export type { LeadSample, SampleKind, SampleTrigger };

/** Amostra sem o conteúdo pesado (HTML/SVG/PNG): para listas e eventos do painel. */
export type SampleSummary = Omit<LeadSample, "content" | "imagePng"> & { hasPreview: boolean };

/** Amostra completa; a imagem vai como data URL (data:image/png;base64,...). */
export type SampleDetail = LeadSample;

const GENERATION_TIMEOUT_MS = 10 * 60_000;
const MAX_HTML_BYTES = 400 * 1024;
const MAX_SVG_BYTES = 2 * 1024 * 1024;

const CLAUDE_OFF =
  "As amostras usam o Claude Code: defina CLAUDE_CODE_ENABLED=true no .env (usa a sua assinatura do Claude) e reinicie o CRM.";

// Amostras sendo geradas neste processo (por contexto: os testes sobem vários na mesma execução)
const generating = new WeakMap<AppContext, Set<number>>();
// Publicações no Netlify, uma de cada vez: cada deploy leva o conjunto completo de sites
const publishQueue = new WeakMap<AppContext, Promise<unknown>>();

function liveOf(ctx: AppContext): Set<number> {
  let set = generating.get(ctx);
  if (!set) generating.set(ctx, (set = new Set()));
  return set;
}

export function summarizeSample(row: LeadSample): SampleSummary {
  const { content, imagePng, ...rest } = row;
  return { ...rest, hasPreview: Boolean(content || imagePng) };
}

function emitUpdated(ctx: AppContext, row: LeadSample): void {
  ctx.events.emit("sample.updated", { sample: summarizeSample(row), leadId: row.leadId });
}

export async function getSample(ctx: AppContext, id: number): Promise<LeadSample> {
  const [row] = await ctx.db.select().from(leadSamples).where(eq(leadSamples.id, id));
  if (!row) throw new HttpError(404, "Amostra não encontrada.");
  return row;
}

/** Para o painel: a imagem vira data URL (pronta para <img src>). */
export function sampleDetail(row: LeadSample): SampleDetail {
  return { ...row, imagePng: row.imagePng ? `data:image/png;base64,${row.imagePng}` : null };
}

export async function listLeadSamples(ctx: AppContext, leadId: number): Promise<SampleSummary[]> {
  const { content: _content, imagePng: _imagePng, ...columns } = getTableColumns(leadSamples);
  const rows = await ctx.db
    .select({
      ...columns,
      hasPreview: sql<boolean>`(${leadSamples.content} is not null or ${leadSamples.imagePng} is not null)`,
    })
    .from(leadSamples)
    .where(eq(leadSamples.leadId, leadId))
    .orderBy(desc(leadSamples.createdAt), desc(leadSamples.id));
  return rows as SampleSummary[];
}

/** Só mexe na linha se ela ainda estiver no estado esperado (um descarte no meio do caminho prevalece). */
async function updateIf(
  ctx: AppContext,
  id: number,
  status: LeadSample["status"][],
  patch: Partial<typeof leadSamples.$inferInsert>,
): Promise<LeadSample | undefined> {
  const [row] = await ctx.db
    .update(leadSamples)
    .set({ ...patch, updatedAt: ctx.now() })
    .where(and(eq(leadSamples.id, id), inArray(leadSamples.status, status)))
    .returning();
  if (row) emitUpdated(ctx, row);
  return row;
}

// ---- Gerar ----

export interface SampleRequest {
  kind?: SampleKind;
  trigger: SampleTrigger;
  instruction?: string | null;
  userId?: number | null;
}

/**
 * Cria a amostra e pede ao Claude em segundo plano (leva alguns minutos).
 * O andamento chega ao painel pelo evento "sample.updated". Nada é enviado ao lead aqui.
 */
export async function requestSample(ctx: AppContext, leadId: number, req: SampleRequest): Promise<LeadSample> {
  if (!ctx.claude) throw new HttpError(503, CLAUDE_OFF);
  await getLead(ctx.db, leadId);
  const settings = await getSettings(ctx.db);
  const [row] = await ctx.db
    .insert(leadSamples)
    .values({
      leadId,
      kind: req.kind ?? settings.samples.defaultKind,
      trigger: req.trigger,
      instruction: req.instruction?.trim() || null,
      createdBy: req.userId ?? null,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })
    .onConflictDoNothing() // índice único: uma amostra "generating" por lead
    .returning();
  if (!row) throw new HttpError(409, "O Claude já está criando uma amostra para este lead. Espere terminar.");

  liveOf(ctx).add(row.id);
  emitUpdated(ctx, row);
  ctx.jobs.schedule(`sample:${leadId}`, 0, () => generateSample(ctx, row.id));
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
  ctx.log.error({ err: String(err), sampleId: id }, "erro inesperado ao gerar amostra");
  return "Erro inesperado ao criar a amostra. Veja os logs do servidor.";
}

/** Tira cercas de markdown (```html ... ```) que às vezes vêm em volta do código. */
function stripFences(code: string): string {
  const m = code.trim().match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
  return (m ? m[1]! : code).trim();
}

/** O site demo nunca deve aparecer no Google: garante o noindex mesmo se o Claude esquecer. */
function ensureNoindex(html: string): string {
  if (/<meta[^>]+name=["']?robots["']?[^>]*noindex/i.test(html)) return html;
  const tag = '<meta name="robots" content="noindex, nofollow">';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (h) => `${h}\n${tag}`);
  return `${tag}\n${html}`;
}

function clip(value: string, max: number): string {
  const v = value.trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

async function generateSample(ctx: AppContext, id: number): Promise<void> {
  try {
    const claude = ctx.claude;
    if (!claude) throw new HttpError(503, CLAUDE_OFF);
    const sample = await getSample(ctx, id);
    if (sample.status !== "generating") return; // descartada antes de começar
    const settings = await getSettings(ctx.db);
    const lead = await getLead(ctx.db, sample.leadId);
    const history = await getConversation(ctx, lead.id, 30);
    const base = {
      system: sampleSystem(settings, sample.kind),
      prompt: samplePrompt(
        lead,
        await stageOf(ctx.db, lead),
        buildTranscript(history, ctx.config.APP_TIMEZONE),
        sample.instruction,
      ),
      effort: "medium" as const,
      timeoutMs: GENERATION_TIMEOUT_MS,
    };

    let patch: Partial<typeof leadSamples.$inferInsert>;
    if (sample.kind === "site") {
      const out = await claude.generate({ ...base, task: "sample_site", schema: sampleSiteSchema });
      const html = stripFences(out.html);
      if (!/<html[\s>]|<body[\s>]/i.test(html)) throw new AiError("O Claude não devolveu uma página HTML completa. Tente de novo.");
      if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new AiError("O site gerado ficou grande demais (mais de 400 KB). Tente de novo.");
      patch = {
        title: clip(out.title, 200),
        caption: clip(out.caption, 1000),
        notes: clip(out.notes, 2000) || null,
        content: ensureNoindex(html),
      };
    } else {
      const out = await claude.generate({ ...base, task: "sample_image", schema: sampleImageSchema });
      const svg = stripFences(out.svg);
      if (!/<svg[\s>]/i.test(svg)) throw new AiError("O Claude não devolveu uma imagem SVG. Tente de novo.");
      if (Buffer.byteLength(svg) > MAX_SVG_BYTES) throw new AiError("A arte gerada ficou grande demais (mais de 2 MB). Tente de novo.");
      let png: Buffer;
      try {
        png = await renderSvgToPng(svg, { width: 1080 });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new AiError(`Não foi possível converter a arte em PNG: ${(err as Error).message}`);
      }
      patch = {
        title: clip(out.title, 200),
        caption: clip(out.caption, 1000),
        notes: clip(out.notes, 2000) || null,
        content: svg,
        imagePng: png.toString("base64"),
      };
    }
    await updateIf(ctx, id, ["generating"], { ...patch, status: "ready", error: null });
  } catch (err) {
    await updateIf(ctx, id, ["generating"], { status: "failed", error: publicErrorMessage(ctx, id, err) }).catch((e) =>
      ctx.log.error({ err: String(e), sampleId: id }, "falha ao gravar o erro da amostra"),
    );
  } finally {
    liveOf(ctx).delete(id);
  }
}

/**
 * Chamado quando o lead fica quente ou é passado para você: gera a amostra sozinho, se as
 * configurações permitirem. Nunca lança erro (não pode atrapalhar a qualificação nem o bot).
 */
export async function maybeAutoSample(ctx: AppContext, leadId: number, trigger: "hot" | "handoff"): Promise<void> {
  try {
    if (!ctx.claude) return;
    const { samples } = await getSettings(ctx.db);
    if (!samples.autoGenerate || !(trigger === "hot" ? samples.onHot : samples.onHandoff)) return;
    const lead = await getLead(ctx.db, leadId);
    if (lead.optedOut || !(lead.phone || lead.waJid)) return;
    const [existing] = await ctx.db
      .select({ id: leadSamples.id })
      .from(leadSamples)
      .where(and(eq(leadSamples.leadId, leadId), inArray(leadSamples.status, ["generating", "ready", "sent"])))
      .limit(1);
    if (existing) return;
    await requestSample(ctx, leadId, { trigger });
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 409) return; // outra já começou ao mesmo tempo
    ctx.log.warn({ err: String(err), leadId, trigger }, "não foi possível gerar a amostra automática");
  }
}

/** Na subida do servidor: amostras que estavam sendo geradas morreram junto com o processo anterior. */
export async function recoverInterruptedSamples(ctx: AppContext): Promise<number> {
  const live = [...liveOf(ctx)];
  const rows = await ctx.db
    .update(leadSamples)
    .set({ status: "failed", error: "Interrompida: o servidor reiniciou. Tente de novo.", updatedAt: ctx.now() })
    .where(and(eq(leadSamples.status, "generating"), live.length ? notInArray(leadSamples.id, live) : undefined))
    .returning({ id: leadSamples.id });
  if (rows.length) ctx.log.warn({ ids: rows.map((r) => r.id) }, "amostras interrompidas pelo reinício");
  return rows.length;
}

// ---- Publicar (Netlify) ----

export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "demo";
}

/** Uma publicação por vez: duas ao mesmo tempo poderiam tirar do ar o site que a outra acabou de pôr. */
function serialized<T>(ctx: AppContext, task: () => Promise<T>): Promise<T> {
  const previous = publishQueue.get(ctx) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  publishQueue.set(ctx, run);
  return run;
}

/** Sites que devem continuar no ar: publicados e não descartados (+ um extra, que está entrando). */
async function liveSiteFiles(ctx: AppContext, extra?: { slug: string; content: string }): Promise<PublishedFile[]> {
  const rows = await ctx.db
    .select({ id: leadSamples.id, slug: leadSamples.slug, content: leadSamples.content })
    .from(leadSamples)
    .where(
      and(
        eq(leadSamples.kind, "site"),
        isNotNull(leadSamples.slug),
        isNotNull(leadSamples.content),
        or(eq(leadSamples.status, "ready"), eq(leadSamples.status, "sent")),
      ),
    );
  const files = new Map<string, string>();
  for (const r of rows) files.set(`/${r.slug}/index.html`, r.content!);
  if (extra) files.set(`/${extra.slug}/index.html`, extra.content);
  return [...files].map(([path, content]) => ({ path, content }));
}

/** Publica o site demo no Netlify (os demos anteriores continuam no ar). Devolve a amostra com o link. */
export async function publishSample(ctx: AppContext, id: number): Promise<LeadSample> {
  const sample = await getSample(ctx, id);
  if (sample.kind !== "site") throw new HttpError(400, "Só sites são publicados; a arte é enviada como imagem.");
  if (sample.status !== "ready" && sample.status !== "sent") {
    throw new HttpError(409, "Esta amostra não está pronta para publicar.");
  }
  if (!sample.content) throw new HttpError(409, "Esta amostra não tem conteúdo.");
  const publisher = ctx.publisher;
  if (!publisher) throw new HttpError(503, "Configure NETLIFY_AUTH_TOKEN no .env para publicar sites.");

  return serialized(ctx, async () => {
    let slug = sample.slug;
    if (!slug) {
      const lead = await getLead(ctx.db, sample.leadId);
      slug = `${slugify(lead.company || lead.name || lead.waName || "demo")}-${randomBytes(5).toString("hex")}`;
    }
    const files = await liveSiteFiles(ctx, { slug, content: sample.content! });
    let siteUrl: string;
    try {
      ({ siteUrl } = await publisher.publish(files));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `Falha ao publicar no Netlify: ${(err as Error).message}`);
    }
    // A pasta (slug) só fica gravada depois de publicar: quem tem slug está no ar
    const row = await updateIf(ctx, id, ["ready", "sent"], {
      slug,
      publicUrl: `${siteUrl.replace(/\/+$/, "")}/${slug}/`,
      publishedAt: ctx.now(),
    });
    if (!row) throw new HttpError(409, "A amostra foi descartada durante a publicação.");
    return row;
  });
}

// ---- Enviar, descartar ----

/** Envia a amostra ao lead pelo WhatsApp (site: publica e manda o link; arte: manda a imagem). */
export async function sendSample(
  ctx: AppContext,
  id: number,
  opts: { caption: string; userId?: number | null },
): Promise<LeadSample> {
  let sample = await getSample(ctx, id);
  if (sample.status !== "ready" && sample.status !== "sent") {
    throw new HttpError(409, "Esta amostra não está pronta para enviar.");
  }
  const caption = opts.caption.trim();
  const sendOpts = { author: "agent" as const, userId: opts.userId ?? null };

  if (sample.kind === "site") {
    if (!sample.publicUrl) sample = await publishSample(ctx, id);
    await sendToLead(ctx, sample.leadId, caption ? `${caption}\n\n${sample.publicUrl}` : sample.publicUrl!, sendOpts);
  } else {
    if (!sample.imagePng) throw new HttpError(409, "Esta amostra não tem imagem.");
    await sendImageToLead(
      ctx,
      sample.leadId,
      {
        data: Buffer.from(sample.imagePng, "base64"),
        mimeType: "image/png",
        caption,
        fileName: `${slugify(sample.title || "amostra")}.png`,
      },
      sendOpts,
    );
  }

  // Como numa mensagem enviada pelo painel: zera os não lidos e, se o bot estava respondendo, você assume
  const lead = await getLead(ctx.db, sample.leadId);
  if (lead.unreadCount > 0) await ctx.db.update(leads).set({ unreadCount: 0 }).where(eq(leads.id, lead.id));
  if (lead.chatMode === "bot" && (await getSettings(ctx.db)).bot.pauseOnPhoneReply) {
    await updateLead(ctx, lead.id, { chatMode: "human" }, { userId: opts.userId ?? null, reason: "você respondeu" });
  }

  const row = await updateIf(ctx, id, ["ready", "sent"], { status: "sent", caption, sentAt: ctx.now() });
  return row ?? (await getSample(ctx, id));
}

/** Descarta a amostra. Se o site estava publicado, ele sai do ar na próxima publicação (feita já). */
export async function discardSample(ctx: AppContext, id: number): Promise<LeadSample> {
  const sample = await getSample(ctx, id);
  if (sample.status === "discarded") return sample;
  const row = await updateIf(ctx, id, ["generating", "ready", "failed", "sent"], { status: "discarded" });
  if (sample.slug && ctx.publisher) {
    const publisher = ctx.publisher;
    // Em segundo plano: o deploy leva alguns segundos e uma falha aqui não desfaz o descarte
    ctx.jobs.schedule("samples:republish", 0, () =>
      serialized(ctx, async () => {
        try {
          await publisher.publish(await liveSiteFiles(ctx));
        } catch (err) {
          ctx.log.warn({ err: String(err), sampleId: id }, "não foi possível tirar o site descartado do ar");
        }
      }),
    );
  }
  return row ?? (await getSample(ctx, id));
}
