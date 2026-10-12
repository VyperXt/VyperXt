import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronDown, Clock, History, PauseCircle, Play, RotateCcw, Send, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { useErrorToast, useToast } from "../lib/app-state";
import { formatDateTime, formatPhone, formatTime } from "../lib/format";
import { IntervalPicker } from "./IntervalPicker";
import { Badge, Button, Modal, Spinner } from "./ui";

export interface ScheduledItem {
  id: number;
  body: string;
  sendAt: string;
  status: "pending" | "sent" | "failed" | "canceled";
  error: string | null;
  leadId: number;
  leadName: string;
  leadPhone: string | null;
  author: "agent" | "automation";
  batchId: string | null;
  playbookName: string | null;
  createdAt: string;
}

const STATUS: Record<ScheduledItem["status"], { label: string; cls: string }> = {
  pending: { label: "na fila", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  sent: { label: "enviada", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  failed: { label: "falhou", cls: "bg-red-50 text-red-700 ring-red-200" },
  canceled: { label: "cancelada", cls: "bg-slate-100 text-slate-500 ring-slate-200" },
};

/** Relógio que anda sozinho: a cada segundo quando algo sai em menos de 2 min, senão a cada 20 s. */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), fast ? 1000 : 20_000);
    return () => clearInterval(t);
  }, [fast]);
  return now;
}

/** Traduz os erros técnicos mais comuns do envio (o texto completo fica no title). */
function friendlyError(error: string): string {
  if (/connection closed|not connected|desconectad|ECONNREFUSED|fetch failed|timeout/i.test(error))
    return "O WhatsApp estava desconectado (ex.: computador suspenso). Nada foi enviado.";
  if (/n[aã]o tem WhatsApp|exists.{0,4}false/i.test(error)) return "Este número não tem WhatsApp.";
  return error.length > 160 ? `${error.slice(0, 160)}…` : error;
}

function countdown(sendAt: string, now: number): string {
  const s = Math.round((new Date(sendAt).getTime() - now) / 1000);
  if (s <= 5) return "saindo agora…";
  if (s < 60) return `em ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `em ${m} min${s % 60 && m < 5 ? ` ${s % 60} s` : ""}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `em ${h}h${String(m % 60).padStart(2, "0")}`;
  return formatDateTime(sendAt);
}

interface Group {
  key: string;
  batchId: string | null;
  title: string;
  items: ScheduledItem[];
}

/** Fila de envios: o que ainda vai sair (por disparo), com contagem regressiva e cancelamento, e o histórico. */
export function ScheduledQueue() {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; body: { ids: number[] } | { batchId: string } | { all: true } } | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ["scheduled"],
    queryFn: () => api<ScheduledItem[]>("/scheduled"),
    // O painel já atualiza pelos eventos ao vivo; isto é só uma rede de segurança
    refetchInterval: 60_000,
  });

  const cancel = useMutation({
    mutationFn: (body: { ids: number[] } | { batchId: string } | { all: true }) =>
      api<{ canceled: number }>("/scheduled/cancel", { body }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["scheduled"] });
      qc.invalidateQueries({ queryKey: ["lead"] });
      setConfirm(null);
      toast({ kind: "success", text: r.canceled === 1 ? "Envio cancelado." : `${r.canceled} envios cancelados.` });
    },
    onError,
  });

  // Fila pausada (ex.: WhatsApp caiu): o servidor tenta de novo sozinho depois de 30 min
  const status = useQuery({
    queryKey: ["scheduled", "status"],
    queryFn: () => api<{ pausedUntil: string | null; reason: string | null }>("/scheduled/status"),
    refetchInterval: 60_000,
  });
  const resume = useMutation({
    mutationFn: () => api("/scheduled/resume", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scheduled"] }),
    onError,
  });
  const [retryOpen, setRetryOpen] = useState(false);
  const [retryInterval, setRetryInterval] = useState(5);
  const retry = useMutation({
    mutationFn: (body: ({ ids: number[] } | { all: true }) & { intervalMinutes?: number }) =>
      api<{ requeued: number; lastSendAt: string | null }>("/scheduled/retry", { body }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["scheduled"] });
      setRetryOpen(false);
      toast({
        kind: r.requeued ? "success" : "info",
        text: r.requeued
          ? `${r.requeued} mensagem(ns) de volta na fila${r.requeued > 1 && r.lastSendAt ? `, a última por volta de ${formatTime(r.lastSendAt)}` : ""}.`
          : "Nada para reenviar.",
      });
    },
    onError,
  });

  const items = q.data ?? [];
  const pending = items.filter((m) => m.status === "pending");
  const history = items.filter((m) => m.status !== "pending");

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const m of pending) {
      const key = m.batchId ?? "manual";
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          batchId: m.batchId,
          title: m.batchId ? `Disparo${m.playbookName ? ` · ${m.playbookName}` : ""}` : "Agendadas por você",
          items: [],
        };
        map.set(key, g);
      }
      g.items.push(m);
    }
    // Disparo com o próximo envio mais cedo primeiro
    return [...map.values()].sort((a, b) => a.items[0]!.sendAt.localeCompare(b.items[0]!.sendAt));
  }, [pending]);

  const failed = history.filter((m) => m.status === "failed");
  const next = pending[0];
  const now = useNow(Boolean(next && new Date(next.sendAt).getTime() - Date.now() < 120_000));

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 font-semibold">
            <CalendarClock className="size-4 text-brand-600" /> Fila de envios
          </h2>
          <p className="text-xs text-slate-500">
            {pending.length === 0
              ? "Nada na fila agora."
              : `${pending.length} mensagem(ns) na fila · próxima ${countdown(next!.sendAt, now)} · última às ${formatTime(pending.at(-1)!.sendAt)}`}
          </p>
        </div>
        {pending.length > 1 && (
          <Button
            variant="secondary"
            size="sm"
            icon={<X className="size-3.5" />}
            onClick={() => setConfirm({ title: `Cancelar todas as ${pending.length} mensagens da fila?`, body: { all: true } })}
          >
            Cancelar tudo
          </Button>
        )}
      </div>

      {status.data?.pausedUntil && new Date(status.data.pausedUntil).getTime() > now && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <PauseCircle className="size-5 shrink-0 text-amber-600" />
          <p className="min-w-0 flex-1">
            <b>Fila pausada</b> ({status.data.reason ?? "falha no envio"}). Nova tentativa {countdown(status.data.pausedUntil, now)}, às{" "}
            {formatTime(status.data.pausedUntil)}. Se o WhatsApp já voltou, você pode retomar agora.
          </p>
          <Button size="sm" variant="secondary" icon={<Play className="size-3.5" />} loading={resume.isPending} onClick={() => resume.mutate()}>
            Retomar agora
          </Button>
        </div>
      )}

      {failed.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-red-100 bg-red-50/60 px-4 py-2.5 text-sm text-red-800">
          <p className="min-w-0 flex-1">
            <b>{failed.length} mensagem(ns) não saíram.</b> Veja o motivo no histórico abaixo.
          </p>
          <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} onClick={() => setRetryOpen(true)}>
            Tentar de novo
          </Button>
        </div>
      )}

      {q.isLoading && (
        <div className="p-4">
          <Spinner />
        </div>
      )}

      {!q.isLoading && pending.length === 0 && (
        <p className="px-4 py-6 text-center text-sm text-slate-500">
          Os envios do <b>Aplicar roteiro</b> (Leads), do <b>Importar e disparar</b> (Prospecção) e as mensagens agendadas pelo relógio da
          conversa aparecem aqui, na ordem em que vão sair.
        </p>
      )}

      {groups.map((g) => (
        <section key={g.key} className="border-b border-slate-100 last:border-b-0">
          <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-4 py-2">
            <p className="text-xs font-semibold text-slate-700">
              {g.title}
              <span className="ml-1.5 font-normal text-slate-500">
                · {g.items.length} na fila · até {formatTime(g.items.at(-1)!.sendAt)}
              </span>
            </p>
            {g.batchId && g.items.length > 1 && (
              <button
                onClick={() =>
                  setConfirm({ title: `Cancelar os ${g.items.length} envios pendentes deste disparo?`, body: { batchId: g.batchId! } })
                }
                className="text-xs font-medium text-red-600 hover:underline"
              >
                Cancelar disparo
              </button>
            )}
          </div>
          <ol className="divide-y divide-slate-100">
            {g.items.map((m, i) => {
              const isNext = m.id === next?.id;
              return (
                <li key={m.id} className={`flex items-start gap-3 px-4 py-2.5 ${isNext ? "bg-amber-50/40" : ""}`}>
                  <span
                    className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                      isNext ? "bg-amber-500 text-white" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <Link to={`/conversas/${m.leadId}`} className="font-medium hover:underline">
                        {m.leadName}
                      </Link>
                      {m.leadPhone && <span className="text-xs text-slate-500">{formatPhone(m.leadPhone)}</span>}
                    </p>
                    <button
                      onClick={() => setExpanded(expanded === m.id ? null : m.id)}
                      className={`block w-full text-left text-sm text-slate-600 ${expanded === m.id ? "whitespace-pre-wrap" : "truncate"}`}
                      title={expanded === m.id ? undefined : "Ver mensagem inteira"}
                    >
                      {m.body}
                    </button>
                    {m.error && <p className="text-xs text-amber-700">{m.error}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`flex items-center justify-end gap-1 text-xs font-medium ${isNext ? "text-amber-700" : "text-slate-700"}`}>
                      <Clock className="size-3" /> {countdown(m.sendAt, now)}
                    </p>
                    <p className="text-[11px] text-slate-400">{formatDateTime(m.sendAt)}</p>
                  </div>
                  <button
                    onClick={() => cancel.mutate({ ids: [m.id] })}
                    disabled={cancel.isPending}
                    className="mt-0.5 rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    title="Cancelar este envio"
                    aria-label={`Cancelar envio para ${m.leadName}`}
                  >
                    <X className="size-4" />
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}

      {history.length > 0 && (
        <div className="border-t border-slate-200">
          <button
            onClick={() => setHistoryOpen((o) => !o)}
            className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <span className="flex items-center gap-1.5">
              <History className="size-4" /> Histórico ({history.length})
            </span>
            <ChevronDown className={`size-4 transition-transform ${historyOpen ? "rotate-180" : ""}`} />
          </button>
          {historyOpen && (
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {history.map((m) => (
                <li key={m.id} className="flex items-start justify-between gap-3 px-4 py-2 text-sm">
                  <div className="min-w-0">
                    <Link to={`/conversas/${m.leadId}`} className="font-medium hover:underline">
                      {m.leadName}
                    </Link>
                    {m.playbookName && m.author === "automation" && (
                      <Badge className="ml-2 bg-violet-50 align-middle text-violet-700">{m.playbookName}</Badge>
                    )}
                    <p className="truncate text-slate-600">{m.body}</p>
                    {m.error && (
                      <p className="text-xs text-red-600" title={m.error}>
                        {friendlyError(m.error)}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right text-xs text-slate-500">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${STATUS[m.status].cls}`}>
                      {m.status === "sent" && <Send className="size-3" />}
                      {STATUS[m.status].label}
                    </span>
                    <p className="mt-0.5">{formatDateTime(m.sendAt)}</p>
                    {m.status === "failed" && (
                      <button
                        onClick={() => retry.mutate({ ids: [m.id] })}
                        disabled={retry.isPending}
                        className="mt-1 inline-flex items-center gap-1 font-medium text-brand-700 hover:underline disabled:opacity-50"
                      >
                        <RotateCcw className="size-3" /> Tentar de novo
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Modal open={retryOpen} onClose={() => !retry.isPending && setRetryOpen(false)} title="Tentar de novo">
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            As <b>{failed.length}</b> mensagem(ns) que falharam voltam para a fila, na ordem original. A primeira sai em cerca de 1 min.
            Quem pediu para não receber mensagens fica de fora.
          </p>
          <IntervalPicker value={retryInterval} onChange={setRetryInterval} count={failed.length} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRetryOpen(false)} disabled={retry.isPending}>
              Voltar
            </Button>
            <Button
              icon={<RotateCcw className="size-4" />}
              loading={retry.isPending}
              onClick={() => retry.mutate({ all: true, intervalMinutes: retryInterval })}
            >
              Colocar de volta na fila
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(confirm)} onClose={() => !cancel.isPending && setConfirm(null)} title="Cancelar envios">
        <p className="text-sm text-slate-700">{confirm?.title}</p>
        <p className="mt-1 text-xs text-slate-500">Os leads continuam no CRM com o roteiro; só as mensagens que ainda não saíram são canceladas.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(null)} disabled={cancel.isPending}>
            Voltar
          </Button>
          <Button variant="danger" loading={cancel.isPending} onClick={() => confirm && cancel.mutate(confirm.body)}>
            Cancelar envios
          </Button>
        </div>
      </Modal>
    </div>
  );
}
