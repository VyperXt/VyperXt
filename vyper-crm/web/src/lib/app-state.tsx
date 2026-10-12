import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Flame, MessageCircle, Sparkles, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, getToken } from "./api";
import { leadName } from "./format";
import type { CrmEvent, Lead, LeadDetail, Playbook, ProspectSearchSummary, SampleSummary, SettingsResponse, Stage, User } from "./types";

// ---------- Toasts ----------
interface Toast {
  id: number;
  kind: "success" | "error" | "info" | "hot" | "sample";
  text: string;
  onClick?: () => void;
}

const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), 5000);
  }, []);
  const icon = {
    success: <CheckCircle2 className="size-4 text-brand-600" />,
    error: <XCircle className="size-4 text-red-600" />,
    info: <MessageCircle className="size-4 text-sky-600" />,
    hot: <Flame className="size-4 text-red-600" />,
    sample: <Sparkles className="size-4 text-violet-600" />,
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            onClick={t.onClick}
            className={`card pointer-events-auto flex items-start gap-2 px-3 py-2.5 text-sm shadow-lg ${t.onClick ? "cursor-pointer hover:bg-slate-50" : ""}`}
          >
            <span className="mt-0.5">{icon[t.kind]}</span>
            <span className="flex-1">{t.text}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setToasts((all) => all.filter((x) => x.id !== t.id));
              }}
              className="text-slate-400 hover:text-slate-600"
              aria-label="Fechar"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Usuário logado ----------
export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api<User>("/auth/me"), enabled: Boolean(getToken()), staleTime: 60_000 });
}

// ---------- Tempo real (SSE) ----------
type Listener = (e: CrmEvent) => void;
const EventsCtx = createContext<{ subscribe: (l: Listener) => () => void; connected: boolean }>({
  subscribe: () => () => {},
  connected: false,
});
export const useRealtime = () => useContext(EventsCtx);

export function RealtimeProvider({ children, onNavigate }: { children: ReactNode; onNavigate: (path: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);
  const navRef = useRef(onNavigate);
  navRef.current = onNavigate;
  // Último status visto de cada prospecção (para avisar quando uma que estava rodando termina)
  const prospectStatus = useRef(new Map<number, string>());
  // Último status visto de cada amostra (para avisar quando a que estava sendo criada fica pronta)
  const sampleStatus = useRef(new Map<number, string>());

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let hadConnection = false;

    const connect = () => {
      // Lê o token a cada (re)conexão: ele muda quando a senha é trocada
      es = new EventSource(`/api/events?token=${encodeURIComponent(getToken() ?? token)}`);
      es.addEventListener("ready", () => {
        setConnected(true);
        // Reconectou depois de uma queda: pode ter perdido eventos → recarrega tudo
        if (hadConnection) qc.invalidateQueries();
        hadConnection = true;
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) retry = setTimeout(connect, 3000);
      };
      es.onmessage = (msg) => {
        const event = JSON.parse(msg.data) as CrmEvent;
        listeners.current.forEach((l) => l(event));
        const leadId: number | undefined = event.data.lead?.id ?? event.data.leadId ?? event.data.message?.leadId;

        // Atualiza as telas abertas
        if (event.type.startsWith("lead.") || event.type.startsWith("message.")) {
          qc.invalidateQueries({ queryKey: ["leads"] });
          qc.invalidateQueries({ queryKey: ["conversations"] });
          qc.invalidateQueries({ queryKey: ["dashboard"] });
          if (leadId) {
            qc.invalidateQueries({ queryKey: ["lead", leadId] });
            qc.invalidateQueries({ queryKey: ["messages", leadId] });
            // atualiza o aviso "teve mensagem nova depois desta análise" do copiloto
            if (event.type.startsWith("message.")) qc.invalidateQueries({ queryKey: ["copilot", leadId] });
          }
        }
        if (event.type === "copilot.updated" && leadId) qc.invalidateQueries({ queryKey: ["copilot", leadId] });
        // Fila de envios: uma mensagem saiu, falhou ou foi cancelada (ou um disparo entrou na fila)
        if (event.type === "scheduled.updated" || event.type === "message.sent") {
          qc.invalidateQueries({ queryKey: ["scheduled"] });
          if (leadId) qc.invalidateQueries({ queryKey: ["lead", leadId] });
        }
        if (event.type === "whatsapp.connection") qc.invalidateQueries({ queryKey: ["whatsapp-status"] });
        const search = event.data.search as ProspectSearchSummary | undefined;
        if (event.type === "prospect.updated" && search) {
          qc.invalidateQueries({ queryKey: ["prospect-searches"] });
          qc.invalidateQueries({ queryKey: ["prospect-search", search.id] });
          const before = prospectStatus.current.get(search.id);
          prospectStatus.current.set(search.id, search.status);
          // Pesquisa leva minutos: se você saiu da tela, avisa quando terminar
          if (before === "running" && search.status !== "running" && !location.pathname.startsWith("/prospeccao")) {
            const goTo = () => navRef.current(`/prospeccao?pesquisa=${search.id}`);
            if (search.status === "done")
              toast({ kind: "success", text: `Prospecção pronta: ${search.resultCount} empresa(s) encontrada(s).`, onClick: goTo });
            if (search.status === "failed") toast({ kind: "error", text: `A prospecção falhou: ${search.error ?? ""}`, onClick: goTo });
          }
        }

        const sample = event.data.sample as SampleSummary | undefined;
        if (event.type === "sample.updated" && sample) {
          qc.invalidateQueries({ queryKey: ["samples", sample.leadId] });
          qc.invalidateQueries({ queryKey: ["sample", sample.id] });
          const before = sampleStatus.current.get(sample.id);
          sampleStatus.current.set(sample.id, sample.status);
          // Ficou pronta (não é só a publicação) e você não está nessa conversa → avisa
          if (
            sample.status === "ready" &&
            before !== "ready" &&
            !sample.publishedAt &&
            !location.pathname.endsWith(`/${sample.leadId}`)
          ) {
            const goTo = () => navRef.current(`/conversas/${sample.leadId}`);
            const what = sample.kind === "site" ? "Site demo pronto" : "Arte pronta";
            qc.fetchQuery({ queryKey: ["lead", sample.leadId], queryFn: () => api<LeadDetail>(`/leads/${sample.leadId}`) })
              .then((d) => toast({ kind: "sample", text: `${what} para ${leadName(d.lead)} — revise e envie.`, onClick: goTo }))
              .catch(() => toast({ kind: "sample", text: `${what} — revise e envie.`, onClick: goTo }));
          }
          if (sample.status === "failed" && before === "generating" && !location.pathname.endsWith(`/${sample.leadId}`)) {
            toast({ kind: "error", text: `Não foi possível criar a amostra: ${sample.error ?? ""}`, onClick: () => navRef.current(`/conversas/${sample.leadId}`) });
          }
        }

        // Avisos
        const lead = event.data.lead as Lead | undefined;
        const open = () => leadId && navRef.current(`/conversas/${leadId}`);
        if (event.type === "lead.hot" && lead) toast({ kind: "hot", text: `${leadName(lead)} está quente! 🔥`, onClick: open });
        if (event.type === "lead.handoff" && lead)
          toast({ kind: "info", text: `A IA passou ${leadName(lead)} para você: ${event.data.reason ?? ""}`, onClick: open });
        if (event.type === "message.received" && lead && lead.chatMode === "human" && !location.pathname.endsWith(`/${lead.id}`))
          toast({ kind: "info", text: `${leadName(lead)}: ${String(event.data.message?.body ?? "").slice(0, 80)}`, onClick: open });
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [qc, toast]);

  const subscribe = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => void listeners.current.delete(l);
  }, []);

  return <EventsCtx.Provider value={{ subscribe, connected }}>{children}</EventsCtx.Provider>;
}

// ---------- Utilitário de mutação com aviso de erro ----------
export function useErrorToast() {
  const toast = useToast();
  return (err: unknown) => toast({ kind: "error", text: err instanceof Error ? err.message : String(err) });
}

// ---------- Etapas (usadas em várias telas) ----------
export function useStages() {
  return useQuery({ queryKey: ["stages"], queryFn: () => api<Stage[]>("/stages"), staleTime: 30_000 });
}

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsResponse>("/settings") });
}

export function usePlaybooks() {
  return useQuery({ queryKey: ["playbooks"], queryFn: () => api<Playbook[]>("/playbooks") });
}

