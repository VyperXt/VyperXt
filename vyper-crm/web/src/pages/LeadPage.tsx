import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, MessageCircle, Sparkles, StopCircle, Trash2, Workflow, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Avatar, Badge, Button, Empty, Field, Spinner, TemperatureBadge } from "../components/ui";
import { api } from "../lib/api";
import { useErrorToast, useStages, useToast } from "../lib/app-state";
import { formatDateTime, formatPhone, leadName, parseBRL, SOURCE_LABEL, toBRLInput } from "../lib/format";
import type { Lead, LeadDetail, Sequence } from "../lib/types";

type Form = {
  name: string;
  phone: string;
  email: string;
  company: string;
  interest: string;
  budget: string;
  timeline: string;
  value: string;
  notes: string;
};

const toForm = (l: Lead): Form => ({
  name: l.name ?? "",
  // Com "+": o número já tem DDI e não pode ganhar outro 55 se for salvo de novo
  phone: l.phone ? `+${l.phone}` : "",
  email: l.email ?? "",
  company: l.company ?? "",
  interest: l.interest ?? "",
  budget: l.budget ?? "",
  timeline: l.timeline ?? "",
  value: toBRLInput(l.value),
  notes: l.notes ?? "",
});

export function LeadPage() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const onError = useErrorToast();
  const stages = useStages();
  const q = useQuery({ queryKey: ["lead", id], queryFn: () => api<LeadDetail>(`/leads/${id}`) });
  const sequences = useQuery({ queryKey: ["sequences"], queryFn: () => api<Sequence[]>("/sequences") });
  // Só guarda o que a pessoa editou; o resto vem sempre do lead mais recente
  // (assim atualizações da IA/n8n aparecem e não são sobrescritas ao salvar)
  const [edits, setEdits] = useState<Partial<Form>>({});
  const [note, setNote] = useState("");
  const [tag, setTag] = useState("");
  const [seqId, setSeqId] = useState("");

  const lead = q.data?.lead;
  useEffect(() => setEdits({}), [id]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["lead", id] });
  // Controles rápidos (etapa, modo, temperatura, etiquetas): não mexem no que está sendo digitado
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Lead>(`/leads/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate,
    onError,
  });
  const saveFields = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Lead>(`/leads/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      setEdits({});
      invalidate();
      toast({ kind: "success", text: "Lead salvo." });
    },
    onError,
  });
  const qualify = useMutation({
    mutationFn: () => api<Lead>(`/leads/${id}/qualify`, { method: "POST" }),
    onSuccess: () => {
      invalidate();
      toast({ kind: "success", text: "Ficha atualizada pela IA." });
    },
    onError,
  });
  const addNote = useMutation({
    mutationFn: () => api(`/leads/${id}/notes`, { body: { text: note } }),
    onSuccess: () => {
      setNote("");
      invalidate();
    },
    onError,
  });
  const enroll = useMutation({
    mutationFn: () => api(`/leads/${id}/enroll`, { body: { sequenceId: Number(seqId) } }),
    onSuccess: () => {
      setSeqId("");
      invalidate();
      toast({ kind: "success", text: "Lead inscrito na automação." });
    },
    onError,
  });
  const stopEnrollment = useMutation({
    mutationFn: (eid: number) => api(`/enrollments/${eid}/stop`, { method: "POST" }),
    onSuccess: invalidate,
    onError,
  });
  const cancelScheduled = useMutation({
    mutationFn: (sid: number) => api(`/scheduled/${sid}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api(`/leads/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      navigate("/leads");
    },
    onError,
  });

  if (!lead) return <div className="grid h-full place-items-center">{q.isError ? <Empty title="Lead não encontrado" /> : <Spinner />}</div>;

  const base = toForm(lead);
  const form: Form = { ...base, ...edits };
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = e.target.value;
    setEdits((prev) => ({ ...prev, [k]: value }));
  };
  const changed = (Object.keys(edits) as Array<keyof Form>).filter((k) => edits[k] !== base[k]);
  const dirty = changed.length > 0;
  const parsedValue = parseBRL(form.value);
  const valueInvalid = Number.isNaN(parsedValue);
  const save = () => {
    if (valueInvalid) return toast({ kind: "error", text: "Valor inválido. Use, por exemplo, 1.500,00" });
    // Envia só os campos alterados
    const body: Record<string, unknown> = {};
    for (const k of changed) body[k] = k === "value" ? parsedValue : form[k].trim() || null;
    saveFields.mutate(body);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:px-6">
        <button onClick={() => navigate(-1)} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Voltar">
          <ArrowLeft className="size-5" />
        </button>
        <Avatar name={leadName(lead)} id={lead.id} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{leadName(lead)}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
            {formatPhone(lead.phone)}
            <TemperatureBadge value={lead.temperature} score={lead.score} />
            <Badge className="bg-slate-100 text-slate-600">{SOURCE_LABEL[lead.source] ?? lead.source}</Badge>
            {lead.optedOut && <Badge className="bg-amber-100 text-amber-800">Não quer automações</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Sparkles className="size-4 text-violet-600" />} loading={qualify.isPending} onClick={() => qualify.mutate()}>
            Qualificar com IA
          </Button>
          {lead.phone && (
            <Link to={`/conversas/${lead.id}`}>
              <Button icon={<MessageCircle className="size-4" />}>Conversa</Button>
            </Link>
          )}
        </div>
      </div>

      <div className="grid gap-4 p-4 md:p-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {lead.aiSummary && (
            <div className="rounded-xl bg-violet-50 p-4 ring-1 ring-violet-200">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-violet-700 uppercase">
                <Bot className="size-3.5" /> Resumo da IA
              </p>
              <p className="text-sm text-violet-950">{lead.aiSummary}</p>
            </div>
          )}

          <div className="card p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nome">
                <input className="input" value={form.name} onChange={set("name")} placeholder={lead.waName ?? ""} />
              </Field>
              <Field label="WhatsApp">
                <input className="input" value={form.phone} onChange={set("phone")} />
              </Field>
              <Field label="E-mail">
                <input className="input" value={form.email} onChange={set("email")} />
              </Field>
              <Field label="Empresa">
                <input className="input" value={form.company} onChange={set("company")} />
              </Field>
              <Field label="Interesse">
                <input className="input" value={form.interest} onChange={set("interest")} />
              </Field>
              <Field label="Valor (R$)" hint={valueInvalid ? "Valor inválido. Ex.: 1.500,00" : undefined}>
                <input className="input" inputMode="decimal" placeholder="1.500,00" value={form.value} onChange={set("value")} />
              </Field>
              <Field label="Orçamento">
                <input className="input" value={form.budget} onChange={set("budget")} />
              </Field>
              <Field label="Prazo">
                <input className="input" value={form.timeline} onChange={set("timeline")} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Anotações">
                  <textarea className="input" rows={3} value={form.notes} onChange={set("notes")} />
                </Field>
              </div>
            </div>
            <div className="mt-3 flex justify-between gap-2">
              <Button
                variant="ghost"
                className="text-red-600"
                icon={<Trash2 className="size-4" />}
                onClick={() => confirm("Excluir este lead e todo o histórico?") && remove.mutate()}
              >
                Excluir
              </Button>
              <div className="flex gap-2">
                {dirty && (
                  <Button variant="secondary" onClick={() => setEdits({})}>
                    Descartar
                  </Button>
                )}
                <Button disabled={!dirty || valueInvalid} loading={saveFields.isPending} onClick={save}>
                  Salvar
                </Button>
              </div>
            </div>
          </div>

          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold">Linha do tempo</h2>
            <form
              className="mb-4 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim()) addNote.mutate();
              }}
            >
              <input className="input" placeholder="Adicionar uma anotação..." value={note} onChange={(e) => setNote(e.target.value)} />
              <Button type="submit" variant="secondary" loading={addNote.isPending} disabled={!note.trim()}>
                Anotar
              </Button>
            </form>
            <ol className="space-y-3 border-l border-slate-200 pl-4">
              {q.data!.activities.map((a) => (
                <li key={a.id} className="relative">
                  <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-white bg-slate-300" />
                  <p className="text-sm whitespace-pre-wrap">{a.description}</p>
                  <p className="text-xs text-slate-400">
                    {formatDateTime(a.createdAt)}
                    {a.userName && ` · ${a.userName}`}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="space-y-4">
          <div className="card space-y-3 p-4">
            <Field label="Etapa do funil">
              <select className="input" value={lead.stageId ?? ""} onChange={(e) => patch.mutate({ stageId: Number(e.target.value) })}>
                {stages.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quem responde no WhatsApp">
              <select className="input" value={lead.chatMode} onChange={(e) => patch.mutate({ chatMode: e.target.value })}>
                <option value="bot">IA responde sozinha</option>
                <option value="human">Eu respondo (IA como copiloto)</option>
              </select>
            </Field>
            <Field label="Temperatura">
              <select className="input" value={lead.temperature} onChange={(e) => patch.mutate({ temperature: e.target.value })}>
                <option value="quente">Quente</option>
                <option value="morno">Morno</option>
                <option value="frio">Frio</option>
              </select>
            </Field>
            <div>
              <label className="label">Etiquetas</label>
              <div className="flex flex-wrap gap-1">
                {lead.tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs">
                    {t}
                    <button onClick={() => patch.mutate({ tags: lead.tags.filter((x) => x !== t) })} aria-label={`Remover ${t}`}>
                      <X className="size-3 text-slate-400 hover:text-red-600" />
                    </button>
                  </span>
                ))}
              </div>
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (tag.trim()) patch.mutate({ tags: [...lead.tags, tag.trim().toLowerCase()] }, { onSuccess: () => setTag("") });
                }}
              >
                <input className="input py-1 text-xs" placeholder="nova etiqueta" value={tag} onChange={(e) => setTag(e.target.value)} />
              </form>
            </div>
            {lead.optedOut && (
              <Button variant="secondary" size="sm" onClick={() => patch.mutate({ optedOut: false })}>
                Liberar mensagens automáticas de novo
              </Button>
            )}
          </div>

          <div className="card p-4">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <Workflow className="size-4" /> Automações
            </h2>
            {q.data!.enrollments.length === 0 && <p className="text-sm text-slate-500">Nenhuma automação.</p>}
            <ul className="space-y-2">
              {q.data!.enrollments.map((e) => (
                <li key={e.id} className="rounded-lg bg-slate-50 p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{e.sequenceName}</span>
                    {e.status === "active" ? (
                      <button onClick={() => stopEnrollment.mutate(e.id)} className="text-red-600 hover:underline" title="Parar">
                        <StopCircle className="size-4" />
                      </button>
                    ) : (
                      <span className="text-slate-500">{e.status === "completed" ? "concluída" : "parada"}</span>
                    )}
                  </div>
                  <p className="text-slate-500">
                    Passo {Math.min(e.stepIndex + 1, e.totalSteps)}/{e.totalSteps}
                    {e.status === "active" && e.nextRunAt && ` · próximo envio ${formatDateTime(e.nextRunAt)}`}
                    {e.stopReason && ` · ${e.stopReason}`}
                  </p>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <select className="input py-1.5 text-xs" value={seqId} onChange={(e) => setSeqId(e.target.value)} aria-label="Automação">
                <option value="">Inscrever em...</option>
                {sequences.data?.filter((s) => s.active).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <Button size="sm" disabled={!seqId} loading={enroll.isPending} onClick={() => enroll.mutate()}>
                OK
              </Button>
            </div>
          </div>

          {q.data!.scheduled.length > 0 && (
            <div className="card p-4">
              <h2 className="mb-2 text-sm font-semibold">Mensagens agendadas</h2>
              <ul className="space-y-2">
                {q.data!.scheduled.map((s) => (
                  <li key={s.id} className="rounded-lg bg-slate-50 p-2 text-xs">
                    <p className="whitespace-pre-wrap">{s.body}</p>
                    <div className="mt-1 flex items-center justify-between text-slate-500">
                      <span>
                        {formatDateTime(s.sendAt)} · {s.status === "pending" ? "pendente" : s.status === "sent" ? "enviada" : s.status === "canceled" ? "cancelada" : "falhou"}
                      </span>
                      {s.status === "pending" && (
                        <button className="text-red-600 hover:underline" onClick={() => cancelScheduled.mutate(s.id)}>
                          cancelar
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
