import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  CalendarClock,
  Check,
  CheckCheck,
  Clock,
  Compass,
  ExternalLink,
  FlaskConical,
  MessageSquarePlus,
  Search,
  Send,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { CopilotPanel } from "../components/CopilotPanel";
import { AutoTextarea } from "../components/AutoTextarea";
import { NewSampleButton, SampleStrip } from "../components/SamplePanel";
import { Avatar, Badge, Button, Empty, Field, Modal, Spinner, TemperatureBadge } from "../components/ui";
import { api } from "../lib/api";
import { useErrorToast, useSettings, useStages, useToast } from "../lib/app-state";
import { formatPhone, formatTime, leadName, NOT_ON_WHATSAPP_ERROR, timeAgo } from "../lib/format";
import type { Conversation, Lead, LeadDetail, Message } from "../lib/types";

const FILTERS = [
  { id: "all", label: "Todas" },
  { id: "waiting", label: "Aguardando você" },
  { id: "unread", label: "Não lidas" },
  { id: "bot", label: "Com a IA" },
  { id: "human", label: "Comigo" },
] as const;

/** Estado da navegação para /conversas/:id: focar a caixa de mensagem ao abrir */
interface ComposerState {
  focusComposer?: boolean;
}

const AUTHOR_LABEL: Record<Message["author"], string> = {
  lead: "",
  agent: "Você",
  phone: "Você (celular)",
  bot: "IA",
  automation: "Follow-up automático",
};

export function InboxPage() {
  const { leadId } = useParams();
  const selectedId = leadId ? Number(leadId) : null;
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [search, setSearch] = useState("");
  const [simOpen, setSimOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const navigate = useNavigate();
  const settings = useSettings();
  const isSimulator = settings.data?.system.whatsappProvider === "simulator";

  const conversations = useQuery({
    queryKey: ["conversations", filter, search],
    queryFn: () =>
      api<Conversation[]>(`/conversations?filter=${filter}&limit=200${search ? `&search=${encodeURIComponent(search)}` : ""}`),
  });

  // Conversa aberta que não está na lista (ex.: nova conversa, ainda sem mensagens): fica fixada no topo,
  // como no WhatsApp Web. Usa os mesmos dados que o ChatArea já carrega.
  const missingSelected = Boolean(selectedId && conversations.data && !conversations.data.some((c) => c.lead.id === selectedId));
  const selectedDetail = useQuery({
    queryKey: ["lead", selectedId],
    queryFn: () => api<LeadDetail>(`/leads/${selectedId}`),
    enabled: missingSelected,
  });
  const selectedLead = selectedDetail.data?.lead;
  // Com mensagens, só fica de fora por causa da busca/filtro (aí respeita a busca) ou do limite da lista
  const pinned =
    missingSelected && selectedLead?.id === selectedId && (!selectedLead.lastMessageAt || (filter === "all" && !search))
      ? selectedLead
      : null;

  return (
    <div className="flex h-full">
      {/* Lista de conversas */}
      <div className={`flex w-full flex-col border-r border-slate-200 bg-white md:w-80 md:shrink-0 ${selectedId ? "hidden md:flex" : "flex"}`}>
        <div className="space-y-2 border-b border-slate-200 p-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold">Conversas</h1>
            <div className="flex items-center gap-1">
              {isSimulator && (
                <Button variant="ghost" size="sm" icon={<FlaskConical className="size-4" />} onClick={() => setSimOpen(true)}>
                  Simular
                </Button>
              )}
              <Button
                size="sm"
                icon={<MessageSquarePlus className="size-4" />}
                onClick={() => setNewOpen(true)}
                title="Nova conversa"
                aria-label="Nova conversa"
              />
            </div>
          </div>
          <div className="relative">
            <Search className="absolute top-2.5 left-2.5 size-4 text-slate-400" />
            <input className="input pl-8" placeholder="Buscar nome, telefone..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="scroll-thin flex gap-1 overflow-x-auto pb-1">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                  filter === f.id ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto">
          {conversations.isLoading && <Spinner className="m-6" />}
          {pinned && (
            <ConversationRow
              lead={pinned}
              lastMessage={null}
              selected
              isNew={!pinned.lastMessageAt}
              onOpen={() => navigate(`/conversas/${pinned.id}`)}
            />
          )}
          {conversations.data?.length === 0 && !pinned && (
            <Empty icon={<MessageSquarePlus className="size-10" />} title="Nenhuma conversa">
              Quando alguém mandar mensagem no seu WhatsApp, aparece aqui. Para falar com alguém,{" "}
              <button className="font-medium text-brand-700 hover:underline" onClick={() => setNewOpen(true)}>
                comece uma nova conversa
              </button>
              .{isSimulator && <> Use <b>Simular</b> para testar.</>}
            </Empty>
          )}
          {conversations.data?.map(({ lead, lastMessage }) => (
            <ConversationRow
              key={lead.id}
              lead={lead}
              lastMessage={lastMessage}
              selected={selectedId === lead.id}
              onOpen={() => navigate(`/conversas/${lead.id}`)}
            />
          ))}
        </div>
      </div>

      {selectedId ? (
        <ChatArea key={selectedId} leadId={selectedId} />
      ) : (
        <div className="hidden flex-1 items-center justify-center bg-chat md:flex">
          <Empty icon={<Compass className="size-12" />} title="Selecione uma conversa">
            O copiloto acompanha a conversa e sugere caminhos. Você decide o que enviar.
            <div className="mt-4">
              <Button variant="secondary" icon={<MessageSquarePlus className="size-4" />} onClick={() => setNewOpen(true)}>
                Nova conversa
              </Button>
            </div>
          </Empty>
        </div>
      )}
      <SimulateModal open={simOpen} onClose={() => setSimOpen(false)} />
      {/* key nova a cada abertura: o formulário sempre começa limpo */}
      <NewConversationModal key={newOpen ? "aberto" : "fechado"} open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

function ConversationRow({
  lead,
  lastMessage,
  selected,
  isNew,
  onOpen,
}: {
  lead: Lead;
  lastMessage: Conversation["lastMessage"];
  selected: boolean;
  isNew?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className={`flex w-full items-start gap-3 border-b border-slate-100 px-3 py-3 text-left transition hover:bg-slate-50 ${
        selected ? "bg-brand-50" : ""
      }`}
    >
      <Avatar name={leadName(lead)} id={lead.id} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{leadName(lead)}</p>
          {isNew ? (
            <Badge className="shrink-0 bg-brand-100 text-brand-700">nova</Badge>
          ) : (
            <span className="shrink-0 text-[11px] text-slate-400">{timeAgo(lead.lastMessageAt)}</span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs text-slate-500">
            {isNew && !lastMessage ? (
              formatPhone(lead.phone)
            ) : (
              <>
                {lastMessage?.direction === "out" && <span className="text-slate-400">{lastMessage.author === "bot" ? "IA: " : "Você: "}</span>}
                {lastMessage?.body}
              </>
            )}
          </p>
          {lead.unreadCount > 0 && (
            <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-brand-600 px-1 text-[10px] font-bold text-white">
              {lead.unreadCount}
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1">
          {lead.chatMode === "bot" ? (
            <Badge className="bg-violet-50 text-violet-700">
              <Bot className="size-3" /> IA
            </Badge>
          ) : (
            <Badge className="bg-slate-100 text-slate-600">
              <UserRound className="size-3" /> Você
            </Badge>
          )}
          <TemperatureBadge value={lead.temperature} />
        </div>
      </div>
    </button>
  );
}

function ChatArea({ leadId }: { leadId: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const settings = useSettings();
  const stages = useStages();
  const [draft, setDraft] = useState("");
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  // Foco na caixa de mensagem assim que ela aparecer (nova conversa ou texto vindo pela URL).
  // Depende de location.key: abrir de novo a mesma conversa (já montada) também foca.
  const [focusPending, setFocusPending] = useState(false);
  const focusRequested = Boolean((location.state as ComposerState | null)?.focusComposer);
  useEffect(() => {
    if (focusRequested) setFocusPending(true);
  }, [focusRequested, location.key]);

  // /conversas/:id?mensagem=... preenche o rascunho uma vez (ex.: abordagem sugerida na Prospecção)
  const prefill = searchParams.get("mensagem");
  useEffect(() => {
    if (prefill === null) return;
    setDraft(prefill);
    setFocusPending(true);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("mensagem");
        return next;
      },
      { replace: true },
    );
  }, [prefill, setSearchParams]);

  const detail = useQuery({ queryKey: ["lead", leadId], queryFn: () => api<LeadDetail>(`/leads/${leadId}`) });
  const messages = useQuery({ queryKey: ["messages", leadId], queryFn: () => api<Message[]>(`/leads/${leadId}/messages`) });
  const lead = detail.data?.lead;
  // Rola para o fim quando chega mensagem nova (o tamanho da lista para de mudar depois de 200)
  const lastMessageId = messages.data?.at(-1)?.id;
  const isSimulator = settings.data?.system.whatsappProvider === "simulator";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lastMessageId]);

  useEffect(() => {
    if (lead && lead.unreadCount > 0) {
      api(`/leads/${leadId}/read`, { method: "POST" }).then(() => qc.invalidateQueries({ queryKey: ["conversations"] }));
    }
  }, [lead?.unreadCount, leadId, qc]);

  useEffect(() => {
    if (!focusPending || !lead) return;
    const el = textRef.current;
    if (el && !el.disabled) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    setFocusPending(false);
  }, [focusPending, lead]);

  const send = useMutation({
    mutationFn: (body: string) => api<Message>(`/leads/${leadId}/messages`, { body: { body } }),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["messages", leadId] });
      // Primeira mensagem de uma conversa nova: ela entra na lista (sem depender do tempo real)
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (err) => {
      onError(err);
      qc.invalidateQueries({ queryKey: ["messages", leadId] });
    },
  });
  // Trava síncrona: dois Enter seguidos (antes do React redesenhar) não enviam duas vezes
  // Contatos que só têm LID (sem número) também recebem mensagem: o envio usa o LID
  const canMessage = Boolean(lead?.phone || lead?.waJid);
  const sendingRef = useRef(false);
  const sendDraft = () => {
    if (!draft.trim() || sendingRef.current) return;
    sendingRef.current = true;
    send.mutate(draft, { onSettled: () => (sendingRef.current = false) });
  };
  const simulate = useMutation({
    // "+" = número já com DDI (sem isso, um número estrangeiro ganharia um 55 na frente)
    mutationFn: (body: string) => api("/whatsapp/simulate", { body: { phone: `+${lead!.phone}`, body } }),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["messages", leadId] });
    },
    onError,
  });
  const patch = useMutation({
    mutationFn: (body: Partial<Lead>) => api<Lead>(`/leads/${leadId}`, { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead", leadId] }),
    onError,
  });

  const useDraft = (text: string) => {
    setDraft(text);
    setCopilotOpen(false);
    setTimeout(() => textRef.current?.focus(), 0);
  };

  // Último envio recusado porque o número não tem WhatsApp: aviso discreto acima da caixa de mensagem
  const lastOut = messages.data?.findLast((m) => m.direction === "out");
  const notOnWhatsApp = lastOut?.status === "failed" && lastOut.error === NOT_ON_WHATSAPP_ERROR;

  const grouped = useMemo(() => {
    const out: Array<{ day: string; items: Message[] }> = [];
    for (const m of messages.data ?? []) {
      const day = new Date(m.createdAt).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" });
      if (out.at(-1)?.day !== day) out.push({ day, items: [] });
      out.at(-1)!.items.push(m);
    }
    return out;
  }, [messages.data]);

  if (!lead) return <div className="grid flex-1 place-items-center">{detail.isError ? <Empty title="Lead não encontrado" /> : <Spinner />}</div>;

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col bg-chat">
        {/* Cabeçalho */}
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-3 py-2.5">
          <Link to="/conversas" className="rounded p-1 text-slate-500 hover:bg-slate-100 md:hidden" aria-label="Voltar">
            <ArrowLeft className="size-5" />
          </Link>
          <Avatar name={leadName(lead)} id={lead.id} />
          <div className="min-w-0 flex-1">
            <Link to={`/leads/${lead.id}`} className="flex items-center gap-1 truncate font-medium hover:underline">
              {leadName(lead)} <ExternalLink className="size-3 text-slate-400" />
            </Link>
            <p className="truncate text-xs text-slate-500">
              {formatPhone(lead.phone) || (lead.waJid && "WhatsApp sem número (LID)")} {lead.interest && `· ${lead.interest}`}
            </p>
          </div>
          <TemperatureBadge value={lead.temperature} score={lead.score} />
          <select
            className="input w-auto py-1 text-xs"
            value={lead.stageId ?? ""}
            onChange={(e) => patch.mutate({ stageId: Number(e.target.value) })}
            aria-label="Etapa do funil"
          >
            {stages.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium" role="group" aria-label="Quem responde">
            <button
              onClick={() => patch.mutate({ chatMode: "bot" })}
              disabled={lead.optedOut}
              className={`flex items-center gap-1 rounded-md px-2 py-1 ${lead.chatMode === "bot" ? "bg-white text-violet-700 shadow-sm" : "text-slate-500"}`}
            >
              <Bot className="size-3.5" /> IA responde
            </button>
            <button
              onClick={() => patch.mutate({ chatMode: "human" })}
              className={`flex items-center gap-1 rounded-md px-2 py-1 ${lead.chatMode === "human" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500"}`}
            >
              <UserRound className="size-3.5" /> Eu respondo
            </button>
          </div>
          <Button variant="secondary" size="sm" className="xl:hidden" icon={<Compass className="size-4" />} onClick={() => setCopilotOpen(true)}>
            Copiloto
          </Button>
        </div>
        {lead.optedOut && (
          <div className="bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-800">
            Este lead pediu para não receber mensagens automáticas. Só você pode falar com ele.
          </div>
        )}
        {/* Amostra do Claude (site demo / arte) esperando sua revisão */}
        <SampleStrip lead={lead} />

        {/* Mensagens */}
        <div className="scroll-thin flex-1 space-y-1 overflow-y-auto px-3 py-4 md:px-8">
          {messages.data?.length === 0 && <Empty title="Sem mensagens ainda" />}
          {grouped.map((g) => (
            <div key={g.day} className="space-y-1">
              <div className="my-3 text-center">
                <span className="rounded-md bg-white/80 px-2 py-0.5 text-[11px] text-slate-500 shadow-sm">{g.day}</span>
              </div>
              {g.items.map((m) => (
                <Bubble key={m.id} m={m} />
              ))}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Caixa de mensagem */}
        <div className="border-t border-slate-200 bg-slate-100 p-2 md:p-3">
          {notOnWhatsApp && (
            <p className="mb-1.5 flex items-start gap-1.5 px-1 text-xs text-amber-800" role="status">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span>
                Este número não tem WhatsApp.{" "}
                <Link to={`/leads/${lead.id}`} className="font-medium underline hover:text-amber-950">
                  Confira o número na ficha do lead.
                </Link>
              </span>
            </p>
          )}
          {lead.chatMode === "bot" && (
            <p className="mb-1.5 px-1 text-xs text-violet-700">
              A IA está respondendo este lead. Se você enviar uma mensagem, a IA pausa e você assume (com o copiloto).
            </p>
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              sendDraft();
            }}
          >
            <AutoTextarea
              ref={textRef}
              className="input scroll-thin min-h-[42px] leading-snug"
              maxHeight={220}
              placeholder={canMessage ? "Escreva sua mensagem..." : "Este lead não tem telefone"}
              value={draft}
              disabled={!canMessage}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendDraft();
                }
              }}
            />
            <NewSampleButton lead={lead} />
            <Button
              type="button"
              variant="secondary"
              title="Agendar envio"
              aria-label="Agendar envio"
              disabled={!draft.trim()}
              onClick={() => setScheduleOpen(true)}
            >
              <CalendarClock className="size-4" />
            </Button>
            {isSimulator && (
              <Button
                type="button"
                variant="secondary"
                title="Simular: enviar este texto COMO SE FOSSE o lead"
                aria-label="Simular resposta do lead"
                disabled={!draft.trim() || !lead.phone}
                loading={simulate.isPending}
                onClick={() => simulate.mutate(draft)}
              >
                <FlaskConical className="size-4" />
              </Button>
            )}
            <Button type="submit" loading={send.isPending} disabled={!draft.trim()} aria-label="Enviar">
              <Send className="size-4" />
            </Button>
          </form>
          {isSimulator && (
            <p className="mt-1 px-1 text-[11px] text-slate-500">
              Modo simulador: o botão <FlaskConical className="inline size-3" /> envia o texto como se fosse o lead, para testar o bot e o copiloto.
            </p>
          )}
        </div>
      </div>

      {/* Copiloto */}
      <div className="hidden w-96 shrink-0 border-l border-slate-200 xl:block">
        <CopilotPanel lead={lead} onUseDraft={useDraft} draft={draft} />
      </div>
      {copilotOpen && (
        <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30 xl:hidden" onClick={() => setCopilotOpen(false)}>
          <div className="relative h-full w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <button
              className="absolute top-3 right-28 z-10 rounded p-1 text-slate-400 hover:bg-slate-100"
              onClick={() => setCopilotOpen(false)}
              aria-label="Fechar copiloto"
            >
              <X className="size-4" />
            </button>
            <CopilotPanel lead={lead} onUseDraft={useDraft} draft={draft} />
          </div>
        </div>
      )}
      <ScheduleModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        leadId={leadId}
        body={draft}
        onDone={() => {
          setDraft("");
          setScheduleOpen(false);
          toast({ kind: "success", text: "Mensagem agendada." });
          qc.invalidateQueries({ queryKey: ["lead", leadId] });
        }}
      />
    </div>
  );
}

function Bubble({ m }: { m: Message }) {
  const out = m.direction === "out";
  const color = !out ? "bg-white" : m.author === "bot" ? "bg-violet-100" : m.author === "automation" ? "bg-sky-100" : "bg-[#d9fdd3]";
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm shadow-sm md:max-w-[70%] ${color}`}>
        {out && m.author !== "agent" && (
          <p className={`mb-0.5 text-[11px] font-semibold ${m.author === "bot" ? "text-violet-700" : "text-sky-700"}`}>
            {m.author === "bot" && <Bot className="mr-1 inline size-3" />}
            {AUTHOR_LABEL[m.author]}
          </p>
        )}
        <p className="break-words whitespace-pre-wrap">{m.body}</p>
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-slate-500">
          {formatTime(m.createdAt)}
          {out && <StatusIcon m={m} />}
        </div>
        {m.status === "failed" && <p className="mt-1 text-[11px] text-red-600">Falhou: {m.error}</p>}
      </div>
    </div>
  );
}

function StatusIcon({ m }: { m: Message }) {
  if (m.status === "pending") return <Clock className="size-3" />;
  if (m.status === "sent") return <Check className="size-3.5" />;
  if (m.status === "delivered") return <CheckCheck className="size-3.5" />;
  if (m.status === "read") return <CheckCheck className="size-3.5 text-sky-500" />;
  if (m.status === "failed") return <X className="size-3.5 text-red-600" />;
  return null;
}

function ScheduleModal({
  open,
  onClose,
  leadId,
  body,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  leadId: number;
  body: string;
  onDone: () => void;
}) {
  const onError = useErrorToast();
  const defaultTime = () => {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setMinutes(0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const [when, setWhen] = useState(defaultTime);
  const m = useMutation({
    mutationFn: () => api(`/leads/${leadId}/schedule`, { body: { body, sendAt: new Date(when).toISOString() } }),
    onSuccess: onDone,
    onError,
  });
  return (
    <Modal open={open} onClose={onClose} title="Agendar mensagem">
      <p className="mb-3 rounded-lg bg-slate-50 p-3 text-sm whitespace-pre-wrap">{body}</p>
      <label className="label" htmlFor="when">Enviar em</label>
      <input id="when" type="datetime-local" className="input" value={when} onChange={(e) => setWhen(e.target.value)} />
      <p className="mt-1 text-xs text-slate-500">Respeita a janela de horário configurada em Configurações → Automação.</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancelar
        </Button>
        <Button loading={m.isPending} onClick={() => m.mutate()}>
          Agendar
        </Button>
      </div>
    </Modal>
  );
}

function SimulateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const onError = useErrorToast();
  const [form, setForm] = useState({ phone: "11999990000", name: "Lead de Teste", body: "Oi! Vi o anúncio de vocês, quanto custa?" });
  const m = useMutation({
    mutationFn: () => api<{ message: Message | null }>("/whatsapp/simulate", { body: form }),
    onSuccess: (res) => {
      onClose();
      if (res.message) navigate(`/conversas/${res.message.leadId}`);
    },
    onError,
  });
  return (
    <Modal open={open} onClose={onClose} title="Simular mensagem recebida">
      <p className="mb-4 text-sm text-slate-600">
        Finge que alguém mandou uma mensagem no seu WhatsApp. Ótimo para testar o bot, a qualificação e o copiloto sem celular.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Telefone</label>
          <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div>
          <label className="label">Nome no WhatsApp</label>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
      </div>
      <label className="label mt-3">Mensagem</label>
      <textarea className="input" rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancelar
        </Button>
        <Button loading={m.isPending} onClick={() => m.mutate()}>
          Simular
        </Button>
      </div>
    </Modal>
  );
}

interface StartConversationResponse {
  lead: Lead;
  created: boolean;
  /** Aviso para mostrar antes de escrever (ex.: API oficial da Meta fora da janela de 24h) */
  warning: string | null;
}

/** Nova conversa com qualquer número, como no WhatsApp Web: acha o lead pelo telefone ou cria um. */
function NewConversationModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ phone: "", name: "" });
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () =>
      api<StartConversationResponse>("/conversations/start", { body: { phone: form.phone, name: form.name.trim() || null } }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      if (res.created) qc.invalidateQueries({ queryKey: ["leads"] });
      onClose();
      navigate(`/conversas/${res.lead.id}`, { state: { focusComposer: true } satisfies ComposerState });
      if (res.warning) toast({ kind: "info", text: res.warning });
      else if (!res.created) toast({ kind: "info", text: `${leadName(res.lead)} já está no CRM — abrindo a conversa.` });
    },
    // Número inválido, sem WhatsApp etc.: mostra aqui mesmo, para corrigir sem fechar
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.target.value });
    setError(null);
  };

  return (
    <Modal open={open} onClose={onClose} title="Nova conversa">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.phone.trim() && !m.isPending) m.mutate();
        }}
      >
        <Field label="WhatsApp (com DDD)" hint="Outros países: comece com + e o código do país (ex.: +351 912 345 678).">
          <input
            className="input"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="11 99999-8888"
            value={form.phone}
            onChange={set("phone")}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "nova-conversa-erro" : undefined}
            autoFocus
            required
          />
        </Field>
        <Field label="Nome (opcional)">
          <input className="input" autoComplete="off" placeholder="Como você chama o contato" value={form.name} onChange={set("name")} />
        </Field>
        {error && (
          <p id="nova-conversa-erro" role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 sm:col-span-2">
            {error}
          </p>
        )}
        <p className="text-xs text-slate-500 sm:col-span-2">
          Se o número já for um lead, a conversa dele abre. Nada é enviado até você escrever a primeira mensagem.
        </p>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={m.isPending} disabled={!form.phone.trim()} icon={<MessageSquarePlus className="size-4" />}>
            Abrir conversa
          </Button>
        </div>
      </form>
    </Modal>
  );
}
