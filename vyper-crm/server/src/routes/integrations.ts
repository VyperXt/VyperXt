import { and, asc, desc, eq, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { leads, sequences, stages, type Lead } from "../db/schema.js";
import { HttpError, idParam, parse } from "../http.js";
import { normalizePhone } from "../lib/phone.js";
import { safeEqual } from "../lib/password.js";
import { composeFollowup, extractLeadsFromText, runQualification } from "../services/ai-flows.js";
import { enroll, renderTemplate } from "../services/automation.js";
import { addActivity, createLead, getLead, leadInputSchema, updateLead } from "../services/leads.js";
import { sendToLead } from "../services/messaging.js";
import { getSettings } from "../settings.js";
import { leadFilters, listQuerySchema } from "./leads.js";

const upsertSchema = leadInputSchema.extend({
  stage: z.string().optional(),
  message: z.string().max(10_000).optional(),
  rawText: z.string().max(50_000).optional(),
  qualify: z.boolean().default(false),
  welcomeMessage: z.string().max(4096).optional(),
  sequenceId: z.number().int().optional(),
});

async function stageIdByName(ctx: AppContext, name?: string): Promise<number | undefined> {
  if (!name) return undefined;
  const all = await ctx.db.select().from(stages);
  const found = all.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  if (!found) throw new HttpError(400, `Etapa "${name}" não existe. Etapas: ${all.map((s) => s.name).join(", ")}`);
  return found.id;
}

/**
 * API para o n8n (ou Zapier, Make, seu site...). Autenticação: header x-api-key = CRM_API_KEY.
 */
export async function integrationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.addHook("onRequest", async (req) => {
    if (!ctx.config.CRM_API_KEY) throw new HttpError(503, "API de integração desativada: defina CRM_API_KEY no .env.");
    const key = req.headers["x-api-key"];
    if (typeof key !== "string" || !safeEqual(key, ctx.config.CRM_API_KEY)) throw new HttpError(401, "x-api-key inválida.");
  });

  // Cria ou atualiza um lead (procura por telefone e depois por e-mail)
  app.post("/api/integrations/leads", async (req) => {
    const body = parse(upsertSchema, req.body);
    const input = { ...body };

    // Captador com IA: transforma texto solto em campos
    if (body.rawText?.trim()) {
      const [found] = await extractLeadsFromText(ctx, body.rawText);
      if (found) {
        input.name ||= found.name || undefined;
        input.phone ||= found.phone || undefined;
        input.email ||= found.email || undefined;
        input.company ||= found.company || undefined;
        input.interest ||= found.interest || undefined;
        if (found.notes) input.notes = [input.notes, found.notes].filter(Boolean).join("\n");
      }
    }
    if (body.message?.trim()) input.notes = [input.notes, `Mensagem: ${body.message.trim()}`].filter(Boolean).join("\n");

    const phone = input.phone ? normalizePhone(input.phone) : null;
    if (input.phone && !phone) throw new HttpError(400, "Telefone inválido.");
    if (!phone && !input.email) throw new HttpError(400, "Informe pelo menos telefone ou e-mail.");
    const stageId = (await stageIdByName(ctx, body.stage)) ?? input.stageId ?? undefined;

    let existing: Lead | undefined;
    if (phone) [existing] = await db.select().from(leads).where(eq(leads.phone, phone));
    if (!existing && input.email) [existing] = await db.select().from(leads).where(eq(leads.email, input.email.toLowerCase()));

    let lead: Lead;
    let created = false;
    if (existing) {
      const patch: z.infer<typeof leadInputSchema> = {};
      if (input.name && !existing.name) patch.name = input.name;
      if (phone && !existing.phone) patch.phone = phone;
      if (input.email && !existing.email) patch.email = input.email;
      if (input.company && !existing.company) patch.company = input.company;
      if (input.interest) patch.interest = input.interest;
      if (input.budget) patch.budget = input.budget;
      if (input.timeline) patch.timeline = input.timeline;
      if (input.value != null) patch.value = input.value;
      if (input.notes) patch.notes = [existing.notes, input.notes].filter(Boolean).join("\n");
      if (input.tags?.length) patch.tags = [...existing.tags, ...input.tags];
      if (stageId) patch.stageId = stageId;
      lead = await updateLead(ctx, existing.id, patch, { reason: "integração" });
      await addActivity(db, lead.id, "integration", `Lead atualizado via integração (${input.source ?? "n8n"})`);
    } else {
      lead = await createLead(ctx, { ...input, phone, source: input.source ?? "n8n", stageId });
      created = true;
    }

    if (body.qualify && ctx.ai.enabled) lead = await runQualification(ctx, lead.id);

    let welcome: { sent: boolean; error?: string } | undefined;
    if (body.welcomeMessage?.trim() && lead.phone) {
      try {
        const settings = await getSettings(db);
        await sendToLead(ctx, lead.id, renderTemplate(body.welcomeMessage, lead, settings), { author: "automation" });
        welcome = { sent: true };
      } catch (err) {
        welcome = { sent: false, error: (err as Error).message };
      }
    }
    if (body.sequenceId) await enroll(ctx, lead.id, body.sequenceId, "integração");

    return { created, lead: await getLead(db, lead.id), welcome };
  });

  app.get("/api/integrations/leads", async (req) => {
    const q = parse(
      listQuerySchema.extend({
        stage: z.string().optional(),
        // Leads sem nenhuma mensagem há X horas
        inactiveHours: z.coerce.number().positive().optional(),
        // Leads que mandaram a última mensagem há X horas e ninguém respondeu
        unansweredHours: z.coerce.number().positive().optional(),
        updatedSince: z.coerce.date().optional(),
        // true = só quem pode receber automação: tem WhatsApp, não pediu para sair e está em etapa aberta
        automatable: z
          .enum(["true", "false"])
          .optional()
          .transform((v) => v === "true"),
      }),
      req.query,
    );
    const where: SQL[] = [];
    const base = leadFilters(q);
    if (base) where.push(base);
    const stageId = await stageIdByName(ctx, q.stage);
    if (stageId) where.push(eq(leads.stageId, stageId));
    const hoursAgo = (h: number) => new Date(ctx.now().getTime() - h * 3_600_000);
    if (q.inactiveHours) where.push(lt(leads.lastMessageAt, hoursAgo(q.inactiveHours)));
    if (q.unansweredHours)
      where.push(
        and(sql`${leads.lastInboundAt} = ${leads.lastMessageAt}`, lt(leads.lastInboundAt, hoursAgo(q.unansweredHours)))!,
      );
    if (q.updatedSince) where.push(sql`${leads.updatedAt} >= ${q.updatedSince}`);
    if (q.automatable) {
      where.push(
        and(
          isNotNull(leads.phone),
          eq(leads.optedOut, false),
          inArray(leads.stageId, db.select({ id: stages.id }).from(stages).where(eq(stages.kind, "open"))),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(leads)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(leads.updatedAt))
      .limit(q.limit)
      .offset(q.offset);
    return { items: rows, count: rows.length };
  });

  app.get("/api/integrations/leads/:id", async (req) => getLead(db, idParam(req)));

  app.patch("/api/integrations/leads/:id", async (req) => {
    const body = parse(leadInputSchema.extend({ stage: z.string().optional(), addTags: z.array(z.string()).optional() }), req.body);
    const id = idParam(req);
    const { stage, addTags, ...patch } = body;
    const stageId = await stageIdByName(ctx, stage);
    if (stageId) patch.stageId = stageId;
    if (addTags?.length) patch.tags = [...(await getLead(db, id)).tags, ...addTags];
    return updateLead(ctx, id, patch, { reason: "integração" });
  });

  // Envia WhatsApp: texto pronto ({ text }) ou escrito pela IA ({ ai: true, instruction })
  app.post("/api/integrations/leads/:id/messages", async (req) => {
    const id = idParam(req);
    const body = parse(
      z.object({ text: z.string().max(4096).optional(), ai: z.boolean().default(false), instruction: z.string().max(2000).optional() }),
      req.body,
    );
    const lead = await getLead(db, id);
    let text = body.text?.trim() ?? "";
    if (body.ai) {
      const out = await composeFollowup(ctx, id, body.instruction ?? "");
      if (!out.send) return { sent: false, reason: out.reason };
      text = out.message;
    } else if (text) {
      text = renderTemplate(text, lead, await getSettings(db));
    }
    if (!text) throw new HttpError(400, "Envie { text } ou { ai: true }.");
    const message = await sendToLead(ctx, id, text, { author: "automation" });
    return { sent: true, message };
  });

  app.post("/api/integrations/leads/:id/notes", async (req) => {
    const body = parse(z.object({ text: z.string().trim().min(1).max(5000) }), req.body);
    const id = idParam(req);
    await getLead(db, id);
    await addActivity(db, id, "note", body.text);
    return { ok: true };
  });

  app.post("/api/integrations/leads/:id/qualify", async (req) => runQualification(ctx, idParam(req)));

  app.post("/api/integrations/leads/:id/enroll", async (req) => {
    const body = parse(z.object({ sequenceId: z.number().int() }), req.body);
    await enroll(ctx, idParam(req), body.sequenceId, "integração");
    return { ok: true };
  });

  app.get("/api/integrations/stages", async () => db.select().from(stages).orderBy(asc(stages.position)));
  app.get("/api/integrations/sequences", async () => db.select().from(sequences).orderBy(asc(sequences.id)));
}
