import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { leads, messages, stages } from "../db/schema.js";

export async function dashboardRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.get("/api/dashboard", async () => {
    const now = ctx.now();
    const tz = ctx.config.APP_TIMEZONE;
    const day = 24 * 60 * 60 * 1000;
    const since7 = new Date(now.getTime() - 7 * day);
    const since14 = new Date(now.getTime() - 13 * day);
    const since24h = new Date(now.getTime() - day);
    const count = sql<number>`count(*)::int`;

    const [
      [total],
      [newWeek],
      byStage,
      byTemperature,
      bySource,
      perDay,
      msgs24h,
      hotLeads,
      waiting,
      allStages,
    ] = await Promise.all([
      db.select({ n: count }).from(leads),
      db.select({ n: count }).from(leads).where(gte(leads.createdAt, since7)),
      db
        .select({ stageId: leads.stageId, n: count, value: sql<number>`coalesce(sum(${leads.value}), 0)::float` })
        .from(leads)
        .groupBy(leads.stageId),
      db.select({ temperature: leads.temperature, n: count }).from(leads).groupBy(leads.temperature),
      db.select({ source: leads.source, n: count }).from(leads).groupBy(leads.source),
      db
        .select({
          day: sql<string>`to_char(${leads.createdAt} at time zone ${sql.raw(`'${tz.replace(/'/g, "")}'`)}, 'YYYY-MM-DD')`,
          n: count,
        })
        .from(leads)
        .where(gte(leads.createdAt, since14))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      db
        .select({ direction: messages.direction, author: messages.author, n: count })
        .from(messages)
        .where(gte(messages.createdAt, since24h))
        .groupBy(messages.direction, messages.author),
      db.select().from(leads).where(eq(leads.temperature, "quente")).orderBy(desc(leads.score)).limit(6),
      db
        .select()
        .from(leads)
        .where(and(eq(leads.chatMode, "human"), sql`${leads.lastInboundAt} = ${leads.lastMessageAt}`))
        .orderBy(desc(leads.lastInboundAt))
        .limit(6),
      db.select().from(stages),
    ]);

    const wonIds = new Set(allStages.filter((s) => s.kind === "won").map((s) => s.id));
    const lostIds = new Set(allStages.filter((s) => s.kind === "lost").map((s) => s.id));
    const won = byStage.filter((s) => s.stageId && wonIds.has(s.stageId)).reduce((a, s) => a + s.n, 0);
    const lost = byStage.filter((s) => s.stageId && lostIds.has(s.stageId)).reduce((a, s) => a + s.n, 0);
    const pipelineValue = byStage
      .filter((s) => s.stageId && !wonIds.has(s.stageId) && !lostIds.has(s.stageId))
      .reduce((a, s) => a + Number(s.value), 0);
    const wonValue = byStage.filter((s) => s.stageId && wonIds.has(s.stageId)).reduce((a, s) => a + Number(s.value), 0);

    // Série dos últimos 14 dias com zeros nos dias sem leads
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const perDayMap = new Map(perDay.map((d) => [d.day, d.n]));
    const series = Array.from({ length: 14 }, (_, i) => {
      const d = fmt.format(new Date(since14.getTime() + i * day));
      return { day: d, n: perDayMap.get(d) ?? 0 };
    });

    const sum = (fn: (m: (typeof msgs24h)[number]) => boolean) => msgs24h.filter(fn).reduce((a, m) => a + m.n, 0);

    return {
      totals: {
        leads: total?.n ?? 0,
        newThisWeek: newWeek?.n ?? 0,
        won,
        lost,
        conversionRate: won + lost > 0 ? won / (won + lost) : null,
        pipelineValue,
        wonValue,
      },
      byStage: byStage.map((s) => ({ ...s, value: Number(s.value) })),
      byTemperature,
      bySource,
      leadsPerDay: series,
      messages24h: {
        received: sum((m) => m.direction === "in"),
        sent: sum((m) => m.direction === "out"),
        byBot: sum((m) => m.author === "bot"),
        byAutomation: sum((m) => m.author === "automation"),
      },
      hotLeads,
      waitingReply: waiting,
      aiEnabled: ctx.ai.enabled,
      whatsappProvider: ctx.wa.name,
    };
  });
}
