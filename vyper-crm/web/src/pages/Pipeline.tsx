import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, MessageCircle, Plus, Search } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { PageHeader } from "../components/Layout";
import { NewLeadModal } from "../components/LeadForm";
import { Avatar, Button, Spinner, TemperatureBadge } from "../components/ui";
import { api } from "../lib/api";
import { useErrorToast, useStages } from "../lib/app-state";
import { leadName, money, timeAgo } from "../lib/format";
import type { Lead } from "../lib/types";

export function PipelinePage() {
  const qc = useQueryClient();
  const onError = useErrorToast();
  const stages = useStages();
  const [search, setSearch] = useState("");
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [newLeadStage, setNewLeadStage] = useState<number | null>(null);

  const leads = useQuery({
    queryKey: ["leads", "board", search],
    queryFn: () => api<{ items: Lead[] }>(`/leads?limit=1000${search ? `&search=${encodeURIComponent(search)}` : ""}`),
  });

  const move = useMutation({
    mutationFn: ({ id, stageId }: { id: number; stageId: number }) => api(`/leads/${id}`, { method: "PATCH", body: { stageId } }),
    onMutate: async ({ id, stageId }) => {
      const key = ["leads", "board", search];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ items: Lead[] }>(key);
      qc.setQueryData<{ items: Lead[] }>(key, (old) =>
        old ? { ...old, items: old.items.map((l) => (l.id === id ? { ...l, stageId } : l)) } : old,
      );
      return { prev, key };
    },
    onError: (err, _v, c) => {
      if (c?.prev) qc.setQueryData(c.key, c.prev);
      onError(err);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["leads"] }),
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Funil de vendas"
        subtitle="Arraste os cards entre as etapas"
        actions={
          <>
            <div className="relative">
              <Search className="absolute top-2.5 left-2.5 size-4 text-slate-400" />
              <input className="input w-56 pl-8" placeholder="Buscar..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Button icon={<Plus className="size-4" />} onClick={() => setNewLeadStage(stages.data?.[0]?.id ?? 0)}>
              Novo lead
            </Button>
          </>
        }
      />
      {(stages.isLoading || leads.isLoading) && <Spinner className="m-6" />}
      <div className="scroll-thin flex flex-1 gap-3 overflow-x-auto p-4">
        {stages.data?.map((stage) => {
          const items = (leads.data?.items ?? []).filter((l) => l.stageId === stage.id);
          const total = items.reduce((a, l) => a + (l.value ?? 0), 0);
          return (
            <div
              key={stage.id}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(stage.id);
              }}
              onDragLeave={() => setDragOver((v) => (v === stage.id ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const id = Number(e.dataTransfer.getData("text/lead"));
                const lead = leads.data?.items.find((l) => l.id === id);
                if (lead && lead.stageId !== stage.id) move.mutate({ id, stageId: stage.id });
              }}
              className={`flex w-72 shrink-0 flex-col rounded-xl bg-slate-100 transition ${dragOver === stage.id ? "ring-2 ring-brand-500" : ""}`}
            >
              <div className="flex items-center justify-between px-3 pt-3 pb-2">
                <div className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full" style={{ background: stage.color }} />
                  <h3 className="text-sm font-semibold">{stage.name}</h3>
                  <span className="rounded-full bg-white px-1.5 text-xs text-slate-500">{items.length}</span>
                </div>
                <button
                  className="rounded p-1 text-slate-400 hover:bg-white hover:text-slate-600"
                  onClick={() => setNewLeadStage(stage.id)}
                  aria-label={`Novo lead em ${stage.name}`}
                >
                  <Plus className="size-4" />
                </button>
              </div>
              {total > 0 && <p className="px-3 pb-2 text-xs text-slate-500">{money(total)}</p>}
              <div className="scroll-thin flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {items.map((lead) => (
                  <div
                    key={lead.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/lead", String(lead.id))}
                    className="card cursor-grab p-3 active:cursor-grabbing"
                  >
                    <div className="flex items-start gap-2">
                      <Avatar name={leadName(lead)} id={lead.id} size="sm" />
                      <div className="min-w-0 flex-1">
                        <Link to={`/leads/${lead.id}`} className="block truncate text-sm font-medium hover:underline">
                          {leadName(lead)}
                        </Link>
                        <p className="truncate text-xs text-slate-500">{lead.company || lead.interest || lead.source}</p>
                      </div>
                      {lead.chatMode === "bot" && <Bot className="size-4 shrink-0 text-violet-500" aria-label="IA respondendo" />}
                    </div>
                    {lead.aiSummary && <p className="mt-2 line-clamp-2 text-xs text-slate-600">{lead.aiSummary}</p>}
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <TemperatureBadge value={lead.temperature} score={lead.score} />
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        {lead.value ? <span className="font-medium text-slate-700">{money(lead.value)}</span> : null}
                        {(lead.phone || lead.waJid) && (
                          <Link to={`/conversas/${lead.id}`} className="flex items-center gap-0.5 hover:text-brand-700" title="Abrir conversa">
                            <MessageCircle className="size-3.5" />
                            {lead.unreadCount > 0 ? <b className="text-brand-700">{lead.unreadCount}</b> : timeAgo(lead.lastMessageAt)}
                          </Link>
                        )}
                      </div>
                    </div>
                    {lead.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {lead.tags.slice(0, 3).map((t) => (
                          <span key={t} className="rounded bg-slate-100 px-1.5 text-[10px] text-slate-600">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {/* key: cada abertura monta um formulário novo, já na etapa da coluna clicada */}
      <NewLeadModal
        key={newLeadStage ?? "fechado"}
        open={newLeadStage !== null}
        onClose={() => setNewLeadStage(null)}
        stageId={newLeadStage ?? undefined}
      />
    </div>
  );
}
