import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Flame, MessageCircle, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, getToken } from "./api";
import { leadName } from "./format";
import type { CrmEvent, Lead, SettingsResponse, Stage, User } from "./types";

// ---------- Toasts ----------
interface Toast {
  id: number;
  kind: "success" | "error" | "info" | "hot";
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

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      es.addEventListener("ready", () => setConnected(true));
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
          }
        }
        if (event.type === "copilot.updated" && leadId) qc.invalidateQueries({ queryKey: ["copilot", leadId] });
        if (event.type === "whatsapp.connection") qc.invalidateQueries({ queryKey: ["whatsapp-status"] });

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

