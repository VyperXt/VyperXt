import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { PageHeader } from "../components/Layout";
import { NewLeadModal } from "../components/LeadForm";
import { Avatar, Badge, Button, Empty, Modal, Spinner, TemperatureBadge } from "../components/ui";
import { api } from "../lib/api";
import { useErrorToast, useStages, useToast } from "../lib/app-state";
import { formatPhone, leadName, money, SOURCE_LABEL, timeAgo } from "../lib/format";
import type { Lead } from "../lib/types";

export function LeadsPage() {
  const stages = useStages();
  const [search, setSearch] = useState("");
  const [stageId, setStageId] = useState("");
  const [temperature, setTemperature] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);

  const params = new URLSearchParams({ limit: "500" });
  if (search) params.set("search", search);
  if (stageId) params.set("stageId", stageId);
  if (temperature) params.set("temperature", temperature);
  const leads = useQuery({
    queryKey: ["leads", "list", params.toString()],
    queryFn: () => api<{ items: Lead[]; total: number }>(`/leads?${params}`),
  });
  const stageName = (id: number | null) => stages.data?.find((s) => s.id === id)?.name ?? "—";

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
      </div>
      <div className="flex-1 overflow-auto">
        {leads.isLoading && <Spinner className="m-6" />}
        {leads.data?.items.length === 0 && <Empty title="Nenhum lead encontrado" />}
        {!!leads.data?.items.length && (
          <table className="w-full min-w-[800px] text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium md:px-6">Lead</th>
                <th className="px-3 py-2 font-medium">Etapa</th>
                <th className="px-3 py-2 font-medium">Temperatura</th>
                <th className="px-3 py-2 font-medium">Interesse</th>
                <th className="px-3 py-2 font-medium">Origem</th>
                <th className="px-3 py-2 text-right font-medium">Valor</th>
                <th className="px-3 py-2 text-right font-medium">Atividade</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {leads.data.items.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 md:px-6">
                    <Link to={`/leads/${l.id}`} className="flex items-center gap-2.5">
                      <Avatar name={leadName(l)} id={l.id} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-medium hover:underline">{leadName(l)}</p>
                        <p className="truncate text-xs text-slate-500">{formatPhone(l.phone) || l.email}</p>
                      </div>
                    </Link>
                  </td>
                  <td className="px-3 py-2">{stageName(l.stageId)}</td>
                  <td className="px-3 py-2">
                    <TemperatureBadge value={l.temperature} score={l.score} />
                  </td>
                  <td className="max-w-[220px] truncate px-3 py-2 text-slate-600">{l.interest}</td>
                  <td className="px-3 py-2">
                    <Badge className="bg-slate-100 text-slate-600">{SOURCE_LABEL[l.source] ?? l.source}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.value ? money(l.value) : ""}</td>
                  <td className="px-3 py-2 text-right text-xs text-slate-500">{timeAgo(l.lastMessageAt ?? l.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <NewLeadModal key={newOpen ? "aberto" : "fechado"} open={newOpen} onClose={() => setNewOpen(false)} />
      <CaptureModal open={captureOpen} onClose={() => setCaptureOpen(false)} />
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
