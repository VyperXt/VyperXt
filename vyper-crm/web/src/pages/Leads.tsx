import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { PageHeader } from "../components/Layout";
import { IntervalPicker } from "../components/IntervalPicker";
import { NewLeadModal } from "../components/LeadForm";
import { Avatar, Badge, Button, Empty, Field, Modal, Spinner, TemperatureBadge } from "../components/ui";
import { api } from "../lib/api";
import { useErrorToast, usePlaybooks, useStages, useToast } from "../lib/app-state";
import { formatPhone, formatTime, leadName, money, SOURCE_LABEL, timeAgo } from "../lib/format";
import type { Lead } from "../lib/types";

export function LeadsPage() {
  const stages = useStages();
  const playbooks = usePlaybooks();
  const [search, setSearch] = useState("");
  const [stageId, setStageId] = useState("");
  const [temperature, setTemperature] = useState("");
  const [source, setSource] = useState("");
  const [contact, setContact] = useState("");
  const [playbookId, setPlaybookId] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkModalOpen, setBulkModalOpen] = useState(false);

  const params = new URLSearchParams({ limit: "500" });
  if (search) params.set("search", search);
  if (stageId) params.set("stageId", stageId);
  if (temperature) params.set("temperature", temperature);
  if (source) params.set("source", source);
  if (contact) params.set("contact", contact);
  if (playbookId) params.set("playbookId", playbookId);

  const leads = useQuery({
    queryKey: ["leads", "list", params.toString()],
    queryFn: () => api<{ items: Lead[]; total: number }>(`/leads?${params}`),
  });
  const stageName = (id: number | null) => stages.data?.find((s) => s.id === id)?.name ?? "—";

  const items = leads.data?.items ?? [];
  const allVisibleSelected = items.length > 0 && items.every((l) => selectedIds.has(l.id));

  const toggleAll = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((l) => l.id)));
    }
  };

  const toggleLead = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedLeads = items.filter((l) => selectedIds.has(l.id));

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Leads"
        subtitle={leads.data ? `${leads.data.total} leads` : undefined}
        actions={
          <>
            <Button variant="secondary" icon={<Sparkles className="size-4 text-violet-600" />} onClick={() => setCaptureOpen(true)}>
              Captar com IA
            </Button>
            <Button icon={<Plus className="size-4" />} onClick={() => setNewOpen(true)}>
              Novo lead
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap gap-2 border-b border-slate-200 bg-white px-4 py-2 md:px-6">
        <div className="relative">
          <Search className="absolute top-2.5 left-2.5 size-4 text-slate-400" />
          <input className="input w-64 pl-8" placeholder="Nome, telefone, e-mail, empresa..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="input w-auto" value={stageId} onChange={(e) => setStageId(e.target.value)} aria-label="Etapa">
          <option value="">Todas as etapas</option>
          {stages.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={temperature} onChange={(e) => setTemperature(e.target.value)} aria-label="Temperatura">
          <option value="">Todas as temperaturas</option>
          <option value="quente">Quente</option>
          <option value="morno">Morno</option>
          <option value="frio">Frio</option>
        </select>
        <select className="input w-auto" value={playbookId} onChange={(e) => setPlaybookId(e.target.value)} aria-label="Roteiro">
          <option value="">Todos os roteiros</option>
          <option value="none">Sem roteiro</option>
          {playbooks.data?.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.name}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Origem">
          <option value="">Todas as origens</option>
          {Object.entries(SOURCE_LABEL).map(([val, label]) => (
            <option key={val} value={val}>
              {label}
            </option>
          ))}
        </select>
        <select
          className={`input w-auto ${contact ? "border-brand-500 bg-brand-50 text-brand-700" : ""}`}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          aria-label="Contato"
        >
          <option value="">Todos os contatos</option>
          <option value="never">Ainda não enviei mensagem</option>
          <option value="queued">Na fila de envio</option>
          <option value="sent">Enviei, sem resposta</option>
          <option value="replied">Já responderam</option>
        </select>
      </div>

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-brand-200 bg-brand-50 px-4 py-2.5 md:px-6">
          <div className="flex items-center gap-2 text-sm font-medium text-brand-900">
            <span>{selectedIds.size} lead(s) selecionado(s)</span>
            <button
              className="text-xs text-brand-700 underline hover:text-brand-900 cursor-pointer"
              onClick={() => setSelectedIds(new Set())}
            >
              Desmarcar todos
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              icon={<Sparkles className="size-3.5" />}
              onClick={() => setBulkModalOpen(true)}
            >
              Aplicar roteiro
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {leads.isLoading && <Spinner className="m-6" />}
        {leads.data?.items.length === 0 && <Empty title="Nenhum lead encontrado" />}
        {!!leads.data?.items.length && (
          <table className="w-full min-w-[850px] text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="w-10 px-4 py-2 md:pl-6 md:pr-2">
                  <input
                    type="checkbox"
                    className="size-4 rounded accent-brand-600 cursor-pointer"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    aria-label="Selecionar todos os visíveis"
                    title="Selecionar todos os visíveis"
                  />
                </th>
                <th className="px-3 py-2 font-medium">Lead</th>
                <th className="px-3 py-2 font-medium">Roteiro</th>
                <th className="px-3 py-2 font-medium">Etapa</th>
                <th className="px-3 py-2 font-medium">Temperatura</th>
                <th className="px-3 py-2 font-medium">Interesse</th>
                <th className="px-3 py-2 font-medium">Origem</th>
                <th className="px-3 py-2 text-right font-medium">Valor</th>
                <th className="px-3 py-2 text-right font-medium">Atividade</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {leads.data.items.map((l) => {
                const playbook = playbooks.data?.find((p) => p.id === l.playbookId);
                return (
                  <tr key={l.id} className="hover:bg-slate-50">
                    <td className="w-10 px-4 py-2 md:pl-6 md:pr-2">
                      <input
                        type="checkbox"
                        className="size-4 rounded accent-brand-600 cursor-pointer"
                        checked={selectedIds.has(l.id)}
                        onChange={() => toggleLead(l.id)}
                        aria-label={`Selecionar ${leadName(l)}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Link to={`/leads/${l.id}`} className="flex items-center gap-2.5">
                        <Avatar name={leadName(l)} id={l.id} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate font-medium hover:underline">{leadName(l)}</p>
                          <p className="truncate text-xs text-slate-500">{formatPhone(l.phone) || l.email}</p>
                        </div>
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      {playbook ? (
                        <Badge className="bg-violet-50 text-violet-700 ring-1 ring-violet-200">
                          {playbook.name}
                        </Badge>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{stageName(l.stageId)}</td>
                    <td className="px-3 py-2">
                      <TemperatureBadge value={l.temperature} score={l.score} />
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2 text-slate-600">{l.interest}</td>
                    <td className="px-3 py-2">
                      <Badge className="bg-slate-100 text-slate-600">{SOURCE_LABEL[l.source] ?? l.source}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.value ? money(l.value) : ""}</td>
                    <td className="px-3 py-2 text-right text-xs text-slate-500">{timeAgo(l.lastMessageAt ?? l.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <NewLeadModal key={newOpen ? "aberto" : "fechado"} open={newOpen} onClose={() => setNewOpen(false)} />
      <CaptureModal open={captureOpen} onClose={() => setCaptureOpen(false)} />
      {bulkModalOpen && (
        <BulkPlaybookModal
          open={bulkModalOpen}
          onClose={() => setBulkModalOpen(false)}
          selectedLeads={selectedLeads}
          onApplied={() => setSelectedIds(new Set())}
        />
      )}
    </div>
  );
}

interface Extracted {
  name: string;
  phone: string;
  email: string;
  company: string;
  interest: string;
  notes: string;
}

/** Captador de leads com IA: cole qualquer texto e a IA encontra os contatos. */
function CaptureModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const [text, setText] = useState("");
  const [found, setFound] = useState<Extracted[] | null>(null);

  const extract = useMutation({
    mutationFn: () => api<{ leads: Extracted[] }>("/leads/extract", { body: { text } }),
    onSuccess: (r) => setFound(r.leads),
    onError,
  });
  const save = useMutation({
    mutationFn: () =>
      api<{ created: number; errors: Array<{ index: number; error: string }> }>("/leads/import", {
        body: {
          source: "captador-ia",
          leads: found!.map((l) => ({
            name: l.name || null,
            phone: l.phone || null,
            email: l.email || null,
            company: l.company || null,
            interest: l.interest || null,
            notes: l.notes || null,
            chatMode: "human",
          })),
        },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast({
        kind: r.errors.length ? "info" : "success",
        text: `${r.created} lead(s) criado(s).${r.errors.length ? ` ${r.errors.length} ignorado(s): ${r.errors[0]!.error}` : ""}`,
      });
      setFound(null);
      setText("");
      onClose();
    },
    onError,
  });

  return (
    <Modal open={open} onClose={onClose} title="Captar leads com IA" wide>
      {!found ? (
        <>
          <p className="mb-3 text-sm text-slate-600">
            Cole qualquer texto — uma lista, mensagens do Instagram, assinaturas de e-mail, anotações de um evento, uma planilha copiada — e a
            IA encontra nome, telefone, e-mail, empresa e interesse de cada contato.
          </p>
          <textarea
            className="input font-mono text-xs"
            rows={10}
            placeholder={"Ex.:\nFalei com a Juliana da Padaria Pão Bom, (11) 98888-7777, quer cardápio digital.\nRoberto - roberto@oficina.com - pediu orçamento de site"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button icon={<Sparkles className="size-4" />} loading={extract.isPending} disabled={text.trim().length < 3} onClick={() => extract.mutate()}>
              Encontrar leads
            </Button>
          </div>
        </>
      ) : (
        <>
          {found.length === 0 ? (
            <Empty title="Nenhum contato encontrado neste texto." />
          ) : (
            <div className="scroll-thin max-h-[50vh] space-y-2 overflow-y-auto">
              <p className="text-sm text-slate-600">Confira e edite antes de salvar:</p>
              {found.map((l, i) => (
                <div key={i} className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  {(["name", "phone", "email", "company", "interest", "notes"] as const).map((k) => (
                    <input
                      key={k}
                      className="input py-1.5 text-xs"
                      placeholder={{ name: "Nome", phone: "Telefone", email: "E-mail", company: "Empresa", interest: "Interesse", notes: "Notas" }[k]}
                      value={l[k]}
                      onChange={(e) => setFound(found.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))}
                    />
                  ))}
                  <button
                    className="justify-self-end rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 sm:row-span-2 sm:self-center"
                    onClick={() => setFound(found.filter((_, j) => j !== i))}
                    aria-label="Remover"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setFound(null)}>
              Voltar
            </Button>
            <Button loading={save.isPending} disabled={!found.length} onClick={() => save.mutate()}>
              Salvar {found.length} lead(s)
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

function BulkPlaybookModal({
  open,
  onClose,
  selectedLeads,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  selectedLeads: Lead[];
  onApplied: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const playbooks = usePlaybooks();

  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string>("");
  const [chatMode, setChatMode] = useState<"bot" | "human">("bot");
  const [sendFirst, setSendFirst] = useState(false);
  const [firstMsg, setFirstMsg] = useState("");
  // Minutos entre um envio e outro (o servidor ainda varia ±15% para não parecer robô)
  const [intervalMinutes, setIntervalMinutes] = useState(5);

  const selectedPlaybook = playbooks.data?.find((p) => String(p.id) === selectedPlaybookId);

  const handlePlaybookChange = (idStr: string) => {
    setSelectedPlaybookId(idStr);
    const p = playbooks.data?.find((x) => String(x.id) === idStr);
    if (p && p.firstMessage) {
      setFirstMsg(p.firstMessage);
    }
  };

  const firstLead = selectedLeads[0];

  const previewText = (() => {
    if (!firstLead || !firstMsg) return firstMsg;
    const name = firstLead.name || firstLead.waName || "";
    const firstName = name.trim().split(/\s+/)[0] || "";
    const company = firstLead.company || name || "";
    let res = firstMsg
      .replace(/\{nome\}/g, name)
      .replace(/\{primeiro_nome\}/g, firstName)
      .replace(/\{empresa\}/g, company);
    res = res.replace(/,\s*!/g, "!").replace(/,\s*\?/g, "?").replace(/\s{2,}/g, " ");
    return res;
  })();

  const bulkMutation = useMutation({
    mutationFn: () =>
      api<{ updated: number; queued: number; skipped: Array<{ leadId: number; reason: string }>; lastSendAt?: string | null }>(
        "/leads/bulk/playbook",
        {
          body: {
            leadIds: selectedLeads.map((l) => l.id),
            playbookId: selectedPlaybookId ? Number(selectedPlaybookId) : null,
            chatMode,
            firstMessage: sendFirst ? { send: true, text: firstMsg.trim(), intervalMinutes } : undefined,
          },
        },
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["playbooks"] });
      const parts = [`${res.updated} lead(s) atualizado(s).`];
      if (res.queued > 0)
        parts.push(
          `${res.queued} envio(s) agendado(s)${res.queued > 1 && res.lastSendAt ? `, o último por volta de ${formatTime(res.lastSendAt)}` : ""}.`,
        );
      if (res.skipped?.length) {
        parts.push(`${res.skipped.length} pulado(s): ${res.skipped[0]?.reason}`);
      }
      toast({ kind: res.skipped?.length ? "info" : "success", text: parts.join(" ") });
      onApplied();
      onClose();
    },
    onError,
  });

  return (
    <Modal open={open} onClose={onClose} title="Aplicar roteiro aos leads" wide>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Aplicando configuração para <strong className="font-semibold text-slate-900">{selectedLeads.length} lead(s) selecionado(s)</strong>.
        </p>

        <Field label="Roteiro">
          <select
            className="input"
            value={selectedPlaybookId}
            onChange={(e) => handlePlaybookChange(e.target.value)}
          >
            <option value="">Sem roteiro</option>
            {playbooks.data?.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Modo de atendimento">
          <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:gap-6">
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="radio"
                name="chatMode"
                value="bot"
                checked={chatMode === "bot"}
                onChange={() => setChatMode("bot")}
                className="size-4 accent-brand-600"
              />
              <span>IA responde sozinha (bot)</span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="radio"
                name="chatMode"
                value="human"
                checked={chatMode === "human"}
                onChange={() => setChatMode("human")}
                className="size-4 accent-brand-600"
              />
              <span>Só copiloto (humano responde)</span>
            </label>
          </div>
        </Field>

        <div className="rounded-lg border border-slate-200 p-3.5 space-y-3 bg-slate-50/50">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-800 cursor-pointer select-none">
            <input
              type="checkbox"
              className="size-4 rounded accent-brand-600"
              checked={sendFirst}
              onChange={(e) => {
                const checked = e.target.checked;
                setSendFirst(checked);
                if (checked && !firstMsg && selectedPlaybook?.firstMessage) {
                  setFirstMsg(selectedPlaybook.firstMessage);
                }
              }}
            />
            <span>Enviar a primeira mensagem agora</span>
          </label>

          {sendFirst && (
            <div className="space-y-3 pl-6">
              <Field
                label="Texto da primeira mensagem"
                hint="Variáveis disponíveis: {nome}, {primeiro_nome}, {empresa}"
              >
                <textarea
                  className="input bg-white"
                  rows={4}
                  value={firstMsg}
                  onChange={(e) => setFirstMsg(e.target.value)}
                  placeholder="Ex.: Olá, {primeiro_nome}! Vi seu trabalho e..."
                />
              </Field>

              {firstLead && (
                <div>
                  <p className="mb-1 text-xs font-semibold text-slate-500">
                    Prévia com o 1º lead ({leadName(firstLead)}):
                  </p>
                  <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-700 whitespace-pre-wrap">
                    {previewText || <span className="text-slate-400 italic">Digite uma mensagem para ver a prévia</span>}
                  </div>
                </div>
              )}

              <IntervalPicker value={intervalMinutes} onChange={setIntervalMinutes} count={selectedLeads.length} />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={bulkMutation.isPending}
            onClick={() => bulkMutation.mutate()}
            disabled={sendFirst && !firstMsg.trim()}
          >
            Aplicar aos {selectedLeads.length} lead(s)
          </Button>
        </div>
      </div>
    </Modal>
  );
}


