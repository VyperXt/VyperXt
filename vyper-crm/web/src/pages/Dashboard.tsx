import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Bot, Clock, Flame, MessageCircle, Send } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { PageHeader } from "../components/Layout";
import { Avatar, Empty, Spinner, TemperatureBadge } from "../components/ui";
import { api } from "../lib/api";
import { useStages } from "../lib/app-state";
import { leadName, money, SOURCE_LABEL, timeAgo } from "../lib/format";
import type { Dashboard } from "../lib/types";

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** Barras verticais de uma série só (leads por dia), com tooltip ao passar o mouse. */
function DailyBars({ data }: { data: Dashboard["leadsPerDay"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.n));
  const label = (day: string) => {
    const [, m, d] = day.split("-");
    return `${d}/${m}`;
  };
  return (
    <div>
      <div className="relative flex h-40 items-end gap-[2px] border-b border-slate-200">
        {data.map((d, i) => (
          <div
            key={d.day}
            className="group relative flex h-full flex-1 items-end"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <div
              className={`w-full rounded-t-[4px] transition-colors ${hover === i ? "bg-brand-700" : "bg-brand-500"}`}
              style={{ height: `${(d.n / max) * 100}%`, minHeight: d.n > 0 ? 3 : 0 }}
            />
            {hover === i && (
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 rounded-md bg-slate-900 px-2 py-1 text-xs whitespace-nowrap text-white">
                {label(d.day)}: <b>{d.n}</b> lead{d.n === 1 ? "" : "s"}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
        <span>{label(data[0]?.day ?? "")}</span>
        <span>{label(data.at(-1)?.day ?? "")}</span>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => api<Dashboard>("/dashboard"), refetchInterval: 60_000 });
  const stages = useStages();
  const d = q.data;

  if (!d) return <div className="grid h-full place-items-center">{q.isError ? <Empty title="Erro ao carregar" /> : <Spinner />}</div>;

  const stageRows = (stages.data ?? []).map((s) => ({
    stage: s,
    n: d.byStage.find((b) => b.stageId === s.id)?.n ?? 0,
    value: d.byStage.find((b) => b.stageId === s.id)?.value ?? 0,
  }));
  const maxStage = Math.max(1, ...stageRows.map((r) => r.n));
  const temp = (t: string) => d.byTemperature.find((x) => x.temperature === t)?.n ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader title="Painel" subtitle="Visão geral dos seus leads e conversas" />
      <div className="space-y-4 p-4 md:p-6">
        {(!d.aiEnabled || d.whatsappProvider === "simulator") && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              {!d.aiEnabled && <p>A IA está desativada — coloque sua ANTHROPIC_API_KEY no arquivo .env.</p>}
              {d.whatsappProvider === "simulator" && (
                <p>
                  WhatsApp em <b>modo simulador</b>. Para conectar seu número, veja <Link to="/configuracoes" className="underline">Configurações → WhatsApp</Link>.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Leads no total" value={d.totals.leads} hint={`+${d.totals.newThisWeek} nos últimos 7 dias`} />
          <Stat
            label="Taxa de conversão"
            value={d.totals.conversionRate == null ? "—" : `${Math.round(d.totals.conversionRate * 100)}%`}
            hint={`${d.totals.won} ganhos · ${d.totals.lost} perdidos`}
          />
          <Stat label="Em negociação" value={money(d.totals.pipelineValue)} hint="Soma do valor dos leads abertos" />
          <Stat label="Vendido" value={money(d.totals.wonValue)} hint="Leads na etapa Ganho" />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="card p-4 lg:col-span-2">
            <h2 className="mb-3 text-sm font-semibold">Novos leads por dia (14 dias)</h2>
            <DailyBars data={d.leadsPerDay} />
          </div>
          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold">Mensagens nas últimas 24h</h2>
            <ul className="space-y-2.5 text-sm">
              <li className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-slate-600"><MessageCircle className="size-4" /> Recebidas</span>
                <b className="tabular-nums">{d.messages24h.received}</b>
              </li>
              <li className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-slate-600"><Send className="size-4" /> Enviadas</span>
                <b className="tabular-nums">{d.messages24h.sent}</b>
              </li>
              <li className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-slate-600"><Bot className="size-4" /> Pela IA</span>
                <b className="tabular-nums">{d.messages24h.byBot}</b>
              </li>
              <li className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-slate-600"><Clock className="size-4" /> Follow-ups automáticos</span>
                <b className="tabular-nums">{d.messages24h.byAutomation}</b>
              </li>
            </ul>
            <h2 className="mt-5 mb-2 text-sm font-semibold">Temperatura</h2>
            <div className="flex flex-wrap gap-2">
              <span className="flex items-center gap-1.5 text-sm"><TemperatureBadge value="quente" /> {temp("quente")}</span>
              <span className="flex items-center gap-1.5 text-sm"><TemperatureBadge value="morno" /> {temp("morno")}</span>
              <span className="flex items-center gap-1.5 text-sm"><TemperatureBadge value="frio" /> {temp("frio")}</span>
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold">Funil</h2>
            <div className="space-y-2">
              {stageRows.map(({ stage, n, value }) => (
                <div key={stage.id} title={`${stage.name}: ${n} leads · ${money(value)}`}>
                  <div className="mb-0.5 flex justify-between text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ background: stage.color }} />
                      {stage.name}
                    </span>
                    <span className="text-slate-500 tabular-nums">{n}</span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100">
                    <div className="h-2 rounded-full bg-brand-500" style={{ width: `${(n / maxStage) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <h2 className="mt-5 mb-2 text-sm font-semibold">Origem</h2>
            <div className="flex flex-wrap gap-1.5">
              {d.bySource.map((s) => (
                <span key={s.source} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs">
                  {SOURCE_LABEL[s.source] ?? s.source}: <b>{s.n}</b>
                </span>
              ))}
            </div>
          </div>

          <LeadList
            title="Aguardando sua resposta"
            icon={<Clock className="size-4 text-amber-600" />}
            leads={d.waitingReply}
            empty="Ninguém esperando. 🎉"
            meta={(l) => timeAgo(l.lastInboundAt)}
          />
          <LeadList
            title="Leads quentes"
            icon={<Flame className="size-4 text-red-600" />}
            leads={d.hotLeads}
            empty="Nenhum lead quente ainda."
            meta={(l) => `nota ${l.score}`}
          />
        </div>
      </div>
    </div>
  );
}

function LeadList({
  title,
  icon,
  leads,
  empty,
  meta,
}: {
  title: string;
  icon: React.ReactNode;
  leads: Dashboard["hotLeads"];
  empty: string;
  meta: (l: Dashboard["hotLeads"][number]) => string;
}) {
  return (
    <div className="card p-4">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        {icon} {title}
      </h2>
      {leads.length === 0 && <p className="text-sm text-slate-500">{empty}</p>}
      <ul className="space-y-1">
        {leads.map((l) => (
          <li key={l.id}>
            <Link to={`/conversas/${l.id}`} className="flex items-center gap-2.5 rounded-lg p-1.5 hover:bg-slate-50">
              <Avatar name={leadName(l)} id={l.id} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{leadName(l)}</p>
                <p className="truncate text-xs text-slate-500">{l.aiSummary ?? l.interest ?? ""}</p>
              </div>
              <span className="shrink-0 text-xs text-slate-400">{meta(l)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
