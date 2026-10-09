import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Clock, MessageSquareText, Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { PageHeader } from "../components/Layout";
import { Badge, Button, Empty, Field, Modal, Spinner, Toggle } from "../components/ui";
import { api } from "../lib/api";
import { useErrorToast } from "../lib/app-state";
import { formatDateTime, formatDelay } from "../lib/format";
import type { Sequence, SequenceStep } from "../lib/types";

const TRIGGER: Record<Sequence["trigger"], { label: string; help: string }> = {
  no_reply: {
    label: "Lead parou de responder",
    help: "Começa a contar a cada mensagem enviada por você ou pela IA. Se o lead responder, para.",
  },
  lead_created: {
    label: "Lead novo (formulário / n8n / cadastro)",
    help: "Para leads que entram por formulário, n8n, importação ou cadastro manual. Leads que chegam pelo WhatsApp já estão conversando e não entram.",
  },
  manual: { label: "Manual", help: "Você (ou o n8n) inscreve o lead quando quiser." },
};

type Draft = Omit<Sequence, "id" | "stats"> & { id?: number };

const blank: Draft = {
  name: "",
  description: "",
  active: true,
  trigger: "no_reply",
  stopOnReply: true,
  steps: [{ delayMinutes: 60 * 24, mode: "ai", message: "Retomar a conversa de forma leve." }],
};

export function AutomationsPage() {
  const qc = useQueryClient();
  const onError = useErrorToast();
  const [editing, setEditing] = useState<Draft | null>(null);
  const sequences = useQuery({ queryKey: ["sequences"], queryFn: () => api<Sequence[]>("/sequences") });
  const scheduled = useQuery({
    queryKey: ["scheduled"],
    queryFn: () =>
      api<Array<{ id: number; body: string; sendAt: string; status: string; leadId: number; leadName: string; error: string | null }>>(
        "/scheduled",
      ),
  });

  const toggle = useMutation({
    mutationFn: (s: Sequence) => api(`/sequences/${s.id}`, { method: "PATCH", body: { active: !s.active } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sequences"] }),
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/sequences/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sequences"] }),
    onError,
  });

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Automações"
        subtitle="Follow-ups automáticos pelo WhatsApp"
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ ...blank, steps: [...blank.steps] })}>
            Nova automação
          </Button>
        }
      />
      <div className="space-y-4 p-4 md:p-6">
        <div className="rounded-xl bg-sky-50 p-3 text-sm text-sky-900">
          Os envios respeitam a janela de horário (Configurações → Automação), param quando o lead responde e nunca vão para quem pediu
          para sair. Passos do tipo <b>IA</b> escrevem uma mensagem personalizada a partir da conversa — e podem decidir não enviar se não
          fizer sentido.
        </div>
        {sequences.isLoading && <Spinner />}
        {sequences.data?.length === 0 && <Empty icon={<Workflow className="size-10" />} title="Nenhuma automação" />}
        <div className="grid gap-3 lg:grid-cols-2">
          {sequences.data?.map((s) => (
            <div key={s.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-semibold">{s.name}</h3>
                  {s.description && <p className="text-sm text-slate-500">{s.description}</p>}
                </div>
                <Toggle checked={s.active} onChange={() => toggle.mutate(s)} label={<span className="text-xs">{s.active ? "Ativa" : "Pausada"}</span>} />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge className="bg-slate-100 text-slate-700">Gatilho: {TRIGGER[s.trigger].label}</Badge>
                {s.stopOnReply && <Badge className="bg-slate-100 text-slate-700">Para se o lead responder</Badge>}
              </div>
              <ol className="mt-3 space-y-1.5">
                {s.steps.map((st, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    <span className="flex shrink-0 items-center gap-1 text-xs text-slate-500">
                      <Clock className="size-3" /> {formatDelay(st.delayMinutes)}
                    </span>
                    {st.mode === "ai" ? <Bot className="size-4 shrink-0 text-violet-600" /> : <MessageSquareText className="size-4 shrink-0 text-slate-400" />}
                    <span className="line-clamp-2 text-slate-700">{st.message}</span>
                  </li>
                ))}
              </ol>
              <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
                <p className="text-xs text-slate-500">
                  {s.stats?.active ?? 0} em andamento · {s.stats?.completed ?? 0} concluídas · {s.stats?.stopped ?? 0} paradas
                </p>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing({ ...s })}>
                    Editar
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600"
                    icon={<Trash2 className="size-3.5" />}
                    onClick={() => confirm(`Excluir "${s.name}"?`) && remove.mutate(s.id)}
                  >
                    Excluir
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Mensagens agendadas</h2>
          {scheduled.data?.length === 0 && (
            <p className="text-sm text-slate-500">Nenhuma. Agende pelo botão de relógio na tela de conversa.</p>
          )}
          <ul className="divide-y divide-slate-100">
            {scheduled.data?.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <Link to={`/conversas/${m.leadId}`} className="font-medium hover:underline">
                    {m.leadName}
                  </Link>
                  <p className="truncate text-slate-600">{m.body}</p>
                  {m.error && <p className="text-xs text-red-600">{m.error}</p>}
                </div>
                <div className="shrink-0 text-right text-xs text-slate-500">
                  <p>{formatDateTime(m.sendAt)}</p>
                  <p>{{ pending: "pendente", sent: "enviada", failed: "falhou", canceled: "cancelada" }[m.status] ?? m.status}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {editing && <SequenceEditor draft={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

const UNITS = [
  { label: "minutos", f: 1 },
  { label: "horas", f: 60 },
  { label: "dias", f: 1440 },
];

function splitDelay(min: number) {
  if (min > 0 && min % 1440 === 0) return { n: min / 1440, f: 1440 };
  if (min > 0 && min % 60 === 0) return { n: min / 60, f: 60 };
  return { n: min, f: 1 };
}

// No editor, cada passo guarda o texto digitado e a unidade escolhida: assim apagar o número
// para digitar outro não troca "dias" por "minutos" sem a pessoa perceber.
type EditorStep = SequenceStep & { delayText: string; unit: number };

const toEditorStep = (st: SequenceStep): EditorStep => {
  const { n, f } = splitDelay(st.delayMinutes);
  return { ...st, delayText: String(n), unit: f };
};

const validDelay = (text: string) => /^\d+([.,]\d+)?$/.test(text.trim());

function SequenceEditor({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const qc = useQueryClient();
  const onError = useErrorToast();
  const [d, setD] = useState<Omit<Draft, "steps"> & { steps: EditorStep[] }>(() => ({ ...draft, steps: draft.steps.map(toEditorStep) }));
  const save = useMutation({
    mutationFn: () => {
      const { id, steps, ...rest } = d;
      const body = {
        ...rest,
        steps: steps.map(({ delayText, unit, ...st }) => ({
          ...st,
          delayMinutes: Math.round(Number(delayText.trim().replace(",", ".")) * unit),
        })),
      };
      return id ? api(`/sequences/${id}`, { method: "PATCH", body }) : api("/sequences", { body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sequences"] });
      onClose();
    },
    onError,
  });
  const setStep = (i: number, patch: Partial<EditorStep>) => setD({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  return (
    <Modal open onClose={onClose} title={d.id ? "Editar automação" : "Nova automação"} wide>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome">
            <input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </Field>
          <Field label="Gatilho" hint={TRIGGER[d.trigger].help}>
            <select className="input" value={d.trigger} onChange={(e) => setD({ ...d, trigger: e.target.value as Sequence["trigger"] })}>
              {Object.entries(TRIGGER).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Descrição">
          <input className="input" value={d.description ?? ""} onChange={(e) => setD({ ...d, description: e.target.value })} />
        </Field>
        <div className="flex flex-wrap gap-4">
          <Toggle checked={d.active} onChange={(v) => setD({ ...d, active: v })} label="Ativa" />
          <Toggle checked={d.stopOnReply} onChange={(v) => setD({ ...d, stopOnReply: v })} label="Parar quando o lead responder" />
        </div>

        <div>
          <p className="label">Passos</p>
          <div className="space-y-2">
            {d.steps.map((st, i) => {
              return (
                <div key={i} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{i + 1}.</span>
                    <span className="text-slate-500">{i === 0 ? "Esperar" : "Depois de mais"}</span>
                    <input
                      inputMode="decimal"
                      className={`input w-20 py-1 ${validDelay(st.delayText) ? "" : "border-red-400"}`}
                      value={st.delayText}
                      onChange={(e) => setStep(i, { delayText: e.target.value })}
                      aria-label="Tempo de espera"
                    />
                    <select className="input w-auto py-1" value={st.unit} onChange={(e) => setStep(i, { unit: Number(e.target.value) })} aria-label="Unidade">
                      {UNITS.map((u) => (
                        <option key={u.f} value={u.f}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                    <span className="text-slate-500">e enviar</span>
                    <select className="input w-auto py-1" value={st.mode} onChange={(e) => setStep(i, { mode: e.target.value as SequenceStep["mode"] })}>
                      <option value="ai">mensagem escrita pela IA</option>
                      <option value="text">texto fixo</option>
                    </select>
                    <button
                      className="ml-auto rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      onClick={() => setD({ ...d, steps: d.steps.filter((_, j) => j !== i) })}
                      aria-label="Remover passo"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                  <textarea
                    className="input mt-2"
                    rows={2}
                    value={st.message}
                    onChange={(e) => setStep(i, { message: e.target.value })}
                    placeholder={st.mode === "ai" ? "Instrução para a IA (ex.: lembrar da proposta e perguntar se ficou alguma dúvida)" : "Texto da mensagem"}
                  />
                  {st.mode === "text" && (
                    <p className="mt-1 text-xs text-slate-500">
                      Variáveis: {"{{primeiro_nome}} {{nome}} {{empresa}} {{interesse}} {{empresa_nome}}"}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            icon={<Plus className="size-3.5" />}
            onClick={() => setD({ ...d, steps: [...d.steps, toEditorStep({ delayMinutes: 1440, mode: "ai", message: "" })] })}
          >
            Adicionar passo
          </Button>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={save.isPending}
            disabled={!d.name.trim() || d.steps.some((s) => !s.message.trim() || !validDelay(s.delayText))}
            onClick={() => save.mutate()}
          >
            Salvar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
