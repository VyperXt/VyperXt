import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCheck,
  ExternalLink,
  Eye,
  Globe,
  ImageIcon,
  Maximize2,
  Monitor,
  RefreshCw,
  Send,
  Smartphone,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useErrorToast, useSettings, useToast } from "../lib/app-state";
import { formatDateTime, leadName, timeAgo } from "../lib/format";
import type { Lead, SampleDetail, SampleKind, SampleSummary } from "../lib/types";
import { Badge, Button, Modal, Spinner } from "./ui";

// Amostras feitas pelo Claude (site demo ou arte) para o lead revisar e enviar.
// O HTML gerado só é exibido dentro de <iframe sandbox="allow-scripts"> (sem allow-same-origin):
// ele roda isolado, sem acesso ao painel, ao login nem aos cookies.

const KIND_LABEL: Record<SampleKind, string> = { site: "Site demo", image: "Arte" };

const STATUS_BADGE: Record<SampleSummary["status"], { label: string; cls: string }> = {
  generating: { label: "Criando…", cls: "bg-violet-50 text-violet-700 ring-1 ring-violet-200" },
  ready: { label: "Pronta", cls: "bg-brand-50 text-brand-700 ring-1 ring-brand-100" },
  failed: { label: "Falhou", cls: "bg-red-50 text-red-700 ring-1 ring-red-200" },
  sent: { label: "Enviada", cls: "bg-sky-50 text-sky-700 ring-1 ring-sky-200" },
  discarded: { label: "Descartada", cls: "bg-slate-100 text-slate-500" },
};

// ---------- Dados ----------

/** Claude Code ligado no servidor (CLAUDE_CODE_ENABLED=true)? */
export function useSamplesEnabled(): boolean {
  return useSettings().data?.system.claudeCode?.enabled ?? false;
}

function useLeadSamples(leadId: number) {
  return useQuery({
    queryKey: ["samples", leadId],
    queryFn: () => api<SampleSummary[]>(`/leads/${leadId}/samples`),
    // O tempo real avisa quando fica pronta; a consulta periódica é só um reforço enquanto gera
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === "generating") ? 5000 : false),
  });
}

function useSampleDetail(sample: SampleSummary | null | undefined) {
  return useQuery({
    queryKey: ["sample", sample?.id],
    queryFn: () => api<SampleDetail>(`/samples/${sample!.id}`),
    enabled: Boolean(sample?.hasPreview),
    staleTime: 60_000,
  });
}

function useSampleActions(leadId: number) {
  const qc = useQueryClient();
  const onError = useErrorToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ["samples", leadId] });
  const discard = useMutation({
    mutationFn: (s: SampleSummary) => api<SampleSummary>(`/samples/${s.id}/discard`, { method: "POST" }),
    onSuccess: refresh,
    onError,
  });
  const confirmDiscard = (s: SampleSummary, after?: () => void) => {
    if (s.status === "generating" && !confirm("Cancelar esta amostra? O Claude termina em segundo plano, mas o resultado é ignorado.")) return;
    if (s.publicUrl && !confirm("Descartar esta amostra? O link publicado deixa de funcionar.")) return;
    discard.mutate(s, { onSuccess: () => after?.() });
  };
  return { discard, confirmDiscard };
}

/** Relógio que anda a cada segundo (só enquanto `active`). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function elapsed(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Amostras já enviadas que você escondeu da conversa (só neste navegador)
const HIDDEN_KEY = "vyper-crm-hidden-samples";
function readHidden(): number[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function hideSample(id: number) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...readHidden(), id].slice(-200)));
  } catch {
    /* sem armazenamento: só não lembra */
  }
}

// ---------- Prévias ----------

/**
 * O site gerado, isolado: sandbox só com scripts (sem allow-same-origin), então ele não enxerga
 * o painel, o login nem os cookies. Sem transform/scale de propósito: páginas com efeitos pesados
 * (ex.: backdrop-filter) travam o navegador quando o iframe é reduzido com CSS.
 */
function SiteFrame({ html, title, className = "", style }: { html: string; title: string; className?: string; style?: CSSProperties }) {
  return (
    <iframe
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={html}
      className={`block border-0 bg-white ${className}`}
      style={style}
    />
  );
}

/** Miniatura: a arte de verdade; para sites, um ícone (a página só é carregada na prévia). */
function Thumb({ sample, className = "" }: { sample: SampleSummary; className?: string }) {
  const detail = useSampleDetail(sample.kind === "image" ? sample : null);
  const frame = `shrink-0 overflow-hidden rounded-md ring-1 ${className}`;
  if (sample.kind === "image") {
    const png = detail.data?.imagePng;
    return png ? (
      <img src={png} alt="" className={`${frame} aspect-[4/5] bg-white object-cover ring-slate-200`} />
    ) : (
      <div className={`${frame} grid aspect-[4/5] place-items-center bg-white text-slate-300 ring-slate-200`}>
        <ImageIcon className="size-4" />
      </div>
    );
  }
  return (
    <div className={`${frame} flex aspect-[16/10] flex-col bg-gradient-to-br from-violet-100 to-fuchsia-50 ring-violet-200`}>
      <div className="flex gap-0.5 bg-white/70 px-1 py-[3px]">
        <span className="size-1 rounded-full bg-violet-300" />
        <span className="size-1 rounded-full bg-violet-200" />
        <span className="size-1 rounded-full bg-violet-200" />
      </div>
      <div className="grid flex-1 place-items-center text-violet-500">
        <Globe className="size-4" />
      </div>
    </div>
  );
}

// ---------- Conversa: faixa discreta no topo do chat ----------

/**
 * Faixa no topo da conversa com a amostra mais recente do lead (criando, pronta, falhou ou enviada).
 * Não aparece quando o lead não tem amostra.
 */
export function SampleStrip({ lead }: { lead: Lead }) {
  const enabled = useSamplesEnabled();
  const samples = useLeadSamples(lead.id);
  const { confirmDiscard } = useSampleActions(lead.id);
  const [hidden, setHidden] = useState(readHidden);
  const [view, setView] = useState<SampleSummary | null>(null);
  const [sending, setSending] = useState<SampleSummary | null>(null);
  const [redo, setRedo] = useState<SampleSummary | null>(null);
  const current = samples.data?.find((s) => s.status !== "discarded");
  const now = useNow(current?.status === "generating");

  if (!current || (current.status === "sent" && hidden.includes(current.id))) return null;
  // Sem o Claude ligado, só mostra o que já existe e ainda pode ser enviado
  if (!enabled && current.status !== "ready" && current.status !== "sent") return null;

  const kind = KIND_LABEL[current.kind];
  let body: ReactNode;
  if (current.status === "generating") {
    body = (
      <Row
        tone="violet"
        lead={
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-violet-100 text-violet-600">
            <Sparkles className="size-4 animate-pulse" />
          </span>
        }
        title={`Claude está criando ${current.kind === "site" ? "um site demo" : "uma arte"}…`}
        subtitle={`${elapsed(current.createdAt, now)} · costuma levar de 1 a 5 min. Você revisa antes de enviar.`}
        actions={
          <Button variant="ghost" size="sm" onClick={() => confirmDiscard(current)} title="Cancelar esta amostra">
            Cancelar
          </Button>
        }
      />
    );
  } else if (current.status === "failed") {
    body = (
      <Row
        tone="red"
        lead={
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-red-100 text-red-600">
            <TriangleAlert className="size-4" />
          </span>
        }
        title={`Não deu para criar ${current.kind === "site" ? "o site demo" : "a arte"}`}
        subtitle={<span title={current.error ?? ""}>{current.error || "Erro desconhecido."}</span>}
        actions={
          <>
            {enabled && (
              <Button variant="secondary" size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => setRedo(current)}>
                <span className="hidden sm:inline">Tentar de novo</span>
                <span className="sm:hidden">De novo</span>
              </Button>
            )}
            <IconButton title="Dispensar" onClick={() => confirmDiscard(current)}>
              <X className="size-4" />
            </IconButton>
          </>
        }
      />
    );
  } else if (current.status === "ready") {
    body = (
      <Row
        tone="violet"
        lead={
          <button onClick={() => setView(current)} className="shrink-0 rounded-md focus:ring-2 focus:ring-violet-300 focus:outline-none" aria-label="Ver amostra">
            <Thumb sample={current} className={current.kind === "site" ? "w-16" : "w-9"} />
          </button>
        }
        title={current.title || `${kind} ${current.kind === "site" ? "pronto" : "pronta"}`}
        subtitle={`${current.kind === "site" ? "Pronto" : "Pronta"} para revisar e enviar · feito pelo Claude ${timeAgo(current.updatedAt) === "agora" ? "agora" : `há ${timeAgo(current.updatedAt)}`}`}
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<Eye className="size-4" />} onClick={() => setView(current)} title="Ver amostra">
              <span className="hidden sm:inline">Ver</span>
            </Button>
            <Button size="sm" icon={<Send className="size-3.5" />} onClick={() => setSending(current)}>
              Enviar
            </Button>
            {enabled && (
              <IconButton title="Refazer" className="hidden sm:grid" onClick={() => setRedo(current)}>
                <RefreshCw className="size-4" />
              </IconButton>
            )}
            <IconButton title="Descartar" className="hidden sm:grid" onClick={() => confirmDiscard(current)}>
              <X className="size-4" />
            </IconButton>
          </>
        }
      />
    );
  } else {
    body = (
      <Row
        tone="slate"
        lead={
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-sky-100 text-sky-600">
            <CheckCheck className="size-4" />
          </span>
        }
        title={`${kind} ${current.kind === "site" ? "enviado" : "enviada"}${current.sentAt ? ` · ${formatDateTime(current.sentAt)}` : ""}`}
        subtitle={
          current.publicUrl ? (
            <a href={current.publicUrl} target="_blank" rel="noreferrer" className="hover:underline">
              {current.publicUrl.replace(/^https?:\/\//, "")}
            </a>
          ) : (
            current.title ?? ""
          )
        }
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<Eye className="size-4" />} onClick={() => setView(current)} title="Ver amostra">
              <span className="hidden sm:inline">Ver</span>
            </Button>
            <IconButton
              title="Ocultar da conversa"
              onClick={() => {
                hideSample(current.id);
                setHidden(readHidden());
              }}
            >
              <X className="size-4" />
            </IconButton>
          </>
        }
      />
    );
  }

  return (
    <>
      {body}
      <SampleModals
        lead={lead}
        view={view}
        sending={sending}
        redo={redo}
        setView={setView}
        setSending={setSending}
        setRedo={setRedo}
      />
    </>
  );
}

const TONES = {
  violet: "border-violet-200/80 bg-violet-50/95",
  red: "border-red-200/80 bg-red-50/95",
  slate: "border-slate-200 bg-white/95",
};

function Row({
  tone,
  lead,
  title,
  subtitle,
  actions,
}: {
  tone: keyof typeof TONES;
  lead: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className={`flex items-center gap-2.5 border-b px-3 py-2 sm:gap-3 md:px-4 ${TONES[tone]}`} role="status">
      {lead}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-800">{title}</p>
        <p className="truncate text-xs text-slate-500">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
  className = "grid",
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`size-8 place-items-center rounded-lg text-slate-500 transition hover:bg-black/5 hover:text-slate-700 ${className}`}
    >
      {children}
    </button>
  );
}

/** Botão ao lado da caixa de mensagem: pede uma amostra nova ao Claude. */
export function NewSampleButton({ lead }: { lead: Lead }) {
  const enabled = useSamplesEnabled();
  const samples = useLeadSamples(lead.id);
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  const busy = samples.data?.some((s) => s.status === "generating");
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        disabled={busy}
        title={busy ? "O Claude já está criando uma amostra" : "Gerar amostra com o Claude (site demo ou arte)"}
        aria-label="Gerar amostra com o Claude"
        onClick={() => setOpen(true)}
      >
        <Sparkles className={`size-4 ${busy ? "text-slate-300" : "text-violet-600"}`} />
      </Button>
      {/* Fora do formulário da conversa (no DOM); os eventos do React ainda sobem, por isso o stopPropagation */}
      {createPortal(<RequestModal open={open} onClose={() => setOpen(false)} lead={lead} />, document.body)}
    </>
  );
}

// ---------- Ficha do lead: todas as amostras ----------

export function SampleList({ lead }: { lead: Lead }) {
  const enabled = useSamplesEnabled();
  const samples = useLeadSamples(lead.id);
  const { confirmDiscard } = useSampleActions(lead.id);
  const [view, setView] = useState<SampleSummary | null>(null);
  const [sending, setSending] = useState<SampleSummary | null>(null);
  const [redo, setRedo] = useState<SampleSummary | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [showDiscarded, setShowDiscarded] = useState(false);
  const all = samples.data ?? [];
  const visible = all.filter((s) => showDiscarded || s.status !== "discarded");
  const discardedCount = all.length - all.filter((s) => s.status !== "discarded").length;
  const now = useNow(all.some((s) => s.status === "generating"));

  if (!enabled && all.length === 0) return null;
  const busy = all.some((s) => s.status === "generating");

  return (
    <div className="card min-w-0 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-4 text-violet-600" /> Amostras do Claude
        </h2>
        {enabled && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRequesting(true)}>
            Gerar
          </Button>
        )}
      </div>
      {samples.isLoading && <Spinner />}
      {!samples.isLoading && visible.length === 0 && (
        <p className="text-xs text-slate-500">
          Quando o lead esquenta ou é passado para você, o Claude cria um site demo ou uma arte para você revisar e enviar.
        </p>
      )}
      <ul className="space-y-2">
        {visible.map((s) => (
          <li key={s.id} className="flex items-center gap-3 rounded-lg border border-slate-200 p-2">
            {s.hasPreview ? (
              <button onClick={() => setView(s)} className="shrink-0 rounded-md" aria-label="Ver amostra">
                <Thumb sample={s} className={s.kind === "site" ? "w-16" : "w-10"} />
              </button>
            ) : (
              <span className="grid size-10 shrink-0 place-items-center rounded-md bg-slate-50 text-slate-400">
                {s.status === "generating" ? <Sparkles className="size-4 animate-pulse text-violet-500" /> : s.kind === "site" ? <Globe className="size-4" /> : <ImageIcon className="size-4" />}
              </span>
            )}
            <div className="min-w-0 flex-1">
              {/* line-clamp em vez de truncate: texto sem quebra alargaria a coluna da ficha no celular */}
              <p className="line-clamp-1 text-sm font-medium break-all">{s.title || KIND_LABEL[s.kind]}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500" title={s.error ?? undefined}>
                <Badge className={`shrink-0 ${STATUS_BADGE[s.status].cls}`}>{STATUS_BADGE[s.status].label}</Badge>
                <span className="line-clamp-1 break-all">
                {s.status === "generating"
                  ? `${KIND_LABEL[s.kind]} · ${elapsed(s.createdAt, now)}`
                  : s.status === "failed"
                    ? s.error
                    : `${KIND_LABEL[s.kind]} · ${formatDateTime(s.sentAt ?? s.createdAt)}`}
                </span>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {s.status === "ready" && (
                <Button size="sm" icon={<Send className="size-3.5" />} onClick={() => setSending(s)} aria-label="Enviar">
                  <span className="hidden sm:inline">Enviar</span>
                </Button>
              )}
              {s.status === "failed" && enabled && (
                <IconButton title="Tentar de novo" onClick={() => setRedo(s)}>
                  <RefreshCw className="size-4" />
                </IconButton>
              )}
              {s.publicUrl && s.status !== "discarded" && (
                <a href={s.publicUrl} target="_blank" rel="noreferrer" title="Abrir o link publicado" className="grid size-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100">
                  <ExternalLink className="size-4" />
                </a>
              )}
              {s.status !== "discarded" && (
                <IconButton title={s.status === "generating" ? "Cancelar" : "Descartar"} onClick={() => confirmDiscard(s)}>
                  <X className="size-4" />
                </IconButton>
              )}
            </div>
          </li>
        ))}
      </ul>
      {discardedCount > 0 && (
        <button className="mt-2 text-xs text-slate-500 hover:underline" onClick={() => setShowDiscarded((v) => !v)}>
          {showDiscarded ? "Esconder descartadas" : `Mostrar ${discardedCount} descartada(s)`}
        </button>
      )}
      <RequestModal open={requesting} onClose={() => setRequesting(false)} lead={lead} />
      <SampleModals lead={lead} view={view} sending={sending} redo={redo} setView={setView} setSending={setSending} setRedo={setRedo} />
    </div>
  );
}

// ---------- Modais ----------

function SampleModals({
  lead,
  view,
  sending,
  redo,
  setView,
  setSending,
  setRedo,
}: {
  lead: Lead;
  view: SampleSummary | null;
  sending: SampleSummary | null;
  redo: SampleSummary | null;
  setView: (s: SampleSummary | null) => void;
  setSending: (s: SampleSummary | null) => void;
  setRedo: (s: SampleSummary | null) => void;
}) {
  const enabled = useSamplesEnabled();
  const { confirmDiscard } = useSampleActions(lead.id);
  return (
    <>
      {view && (
        <PreviewModal
          sample={view}
          onClose={() => setView(null)}
          onSend={view.status === "ready" ? () => (setView(null), setSending(view)) : undefined}
          onRedo={enabled ? () => (setView(null), setRedo(view)) : undefined}
          onDiscard={view.status !== "discarded" ? () => confirmDiscard(view, () => setView(null)) : undefined}
        />
      )}
      {sending && <SendModal key={sending.id} sample={sending} lead={lead} onClose={() => setSending(null)} />}
      <RequestModal open={Boolean(redo)} onClose={() => setRedo(null)} lead={lead} redo={redo} key={redo?.id ?? "novo"} />
    </>
  );
}

function PreviewModal({
  sample,
  onClose,
  onSend,
  onRedo,
  onDiscard,
}: {
  sample: SampleSummary;
  onClose: () => void;
  onSend?: () => void;
  onRedo?: () => void;
  onDiscard?: () => void;
}) {
  const detail = useSampleDetail(sample);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [fullscreen, setFullscreen] = useState(false);
  const d = detail.data;
  // Esc na tela cheia só sai dela (sem fechar a prévia)
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setFullscreen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen]);
  // A prévia ocupa ~50% da altura da tela (a página rola dentro dela)
  const frameFit = Math.max(320, Math.round(window.innerHeight * 0.5));
  return (
    <Modal open onClose={onClose} title={sample.title || KIND_LABEL[sample.kind]} wide>
      <div className="space-y-3">
        {sample.kind === "site" && (
          <div className="flex items-center justify-between gap-2">
            <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium" role="group" aria-label="Tamanho da tela">
              {(
                [
                  ["desktop", "Computador", Monitor],
                  ["mobile", "Celular", Smartphone],
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  onClick={() => setDevice(id)}
                  aria-pressed={device === id}
                  className={`flex items-center gap-1 rounded-md px-2.5 py-1 ${device === id ? "bg-white text-slate-800 shadow-sm" : "text-slate-500"}`}
                >
                  <Icon className="size-3.5" /> {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              {sample.publicUrl && (
                <a href={sample.publicUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-brand-700 hover:underline">
                  Abrir publicado <ExternalLink className="size-3" />
                </a>
              )}
              {d?.content && (
                <button onClick={() => setFullscreen(true)} className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900">
                  <Maximize2 className="size-3.5" /> Tela cheia
                </button>
              )}
            </div>
          </div>
        )}
        <div className="overflow-hidden rounded-lg bg-slate-100 p-2 ring-1 ring-slate-200">
          {!d ? (
            <div className="grid h-64 place-items-center">
              <Spinner />
            </div>
          ) : sample.kind === "image" ? (
            d.imagePng ? (
              <img src={d.imagePng} alt={sample.title ?? "Arte"} className="mx-auto max-h-[62vh] w-auto rounded shadow-sm" />
            ) : (
              <p className="p-6 text-center text-sm text-slate-500">Sem imagem.</p>
            )
          ) : d.content ? (
            device === "desktop" ? (
              <SiteFrame html={d.content} title="Prévia do site" className="w-full rounded shadow-sm" style={{ height: frameFit }} />
            ) : (
              <SiteFrame
                html={d.content}
                title="Prévia do site (celular)"
                className="mx-auto w-[390px] max-w-full rounded-[1.25rem] shadow-sm ring-4 ring-slate-800"
                style={{ height: frameFit }}
              />
            )
          ) : (
            <p className="p-6 text-center text-sm text-slate-500">Sem conteúdo.</p>
          )}
        </div>
        {sample.kind === "site" && d?.content && (
          <p className="text-[11px] text-slate-500">
            Role dentro da prévia para ver a página inteira{device === "desktop" ? " — em “Tela cheia” ela aparece como num computador" : ""}.
          </p>
        )}
        {fullscreen && d?.content && (
          <div className="fixed inset-0 z-[70] flex flex-col bg-slate-900" role="dialog" aria-label="Site em tela cheia">
            <div className="flex items-center justify-between gap-2 px-4 py-2 text-sm text-white">
              <span className="truncate">{sample.title || "Site demo"}</span>
              <button onClick={() => setFullscreen(false)} className="flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-white/10" autoFocus>
                <X className="size-4" /> Fechar
              </button>
            </div>
            <SiteFrame html={d.content} title="Site em tela cheia" className="w-full flex-1" />
          </div>
        )}
        {(d?.notes || sample.instruction) && (
          <div className="space-y-1 rounded-lg bg-violet-50 p-3 text-xs text-violet-950 ring-1 ring-violet-200">
            {d?.notes && (
              <p>
                <span className="font-semibold">Observações do Claude: </span>
                {d.notes}
              </p>
            )}
            {sample.instruction && (
              <p>
                <span className="font-semibold">Seu pedido: </span>
                {sample.instruction}
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex gap-1">
            {onDiscard && (
              <Button variant="ghost" size="sm" className="text-red-600" onClick={onDiscard}>
                Descartar
              </Button>
            )}
            {onRedo && (
              <Button variant="ghost" size="sm" icon={<RefreshCw className="size-3.5" />} onClick={onRedo}>
                Refazer
              </Button>
            )}
          </div>
          {onSend && (
            <Button icon={<Send className="size-4" />} onClick={onSend}>
              Enviar ao lead
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function SendModal({ sample, lead, onClose }: { sample: SampleSummary; lead: Lead; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useSettings();
  const [caption, setCaption] = useState(sample.caption ?? "");
  const [error, setError] = useState<string | null>(null);
  const needsPublish = sample.kind === "site" && !sample.publicUrl;
  const noPublisher = needsPublish && settings.data?.system.publisher == null;
  const send = useMutation({
    mutationFn: () => api<SampleSummary>(`/samples/${sample.id}/send`, { body: { caption } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["samples", lead.id] });
      qc.invalidateQueries({ queryKey: ["messages", lead.id] });
      qc.invalidateQueries({ queryKey: ["lead", lead.id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      toast({ kind: "success", text: `Amostra enviada para ${leadName(lead)}.` });
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });
  return (
    <Modal open onClose={onClose} title={`Enviar ${sample.kind === "site" ? "site demo" : "arte"} para ${leadName(lead)}`}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation(); // o modal pode estar dentro do formulário da conversa
          send.mutate();
        }}
      >
        <div className="flex gap-3">
          <Thumb sample={sample} className={sample.kind === "site" ? "w-28" : "w-20"} />
          <div className="min-w-0 text-sm">
            <p className="font-medium">{sample.title || KIND_LABEL[sample.kind]}</p>
            <p className="text-xs text-slate-500">
              {sample.kind === "site"
                ? needsPublish
                  ? "O site será publicado no Netlify e o link vai no fim da mensagem."
                  : "O link publicado vai no fim da mensagem."
                : "A imagem vai pelo WhatsApp com esta legenda."}
            </p>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="sample-caption">
            Mensagem
          </label>
          <textarea
            id="sample-caption"
            className="input"
            rows={4}
            maxLength={1000}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            autoFocus
          />
          {sample.kind === "site" && (
            <p className="mt-1 truncate text-xs text-slate-500">
              + link: <span className="text-slate-700">{sample.publicUrl ?? "https://…netlify.app/…"}</span>
            </p>
          )}
        </div>
        {noPublisher && (
          <p className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800 ring-1 ring-amber-200">
            Para publicar o site, configure <code>NETLIFY_AUTH_TOKEN</code> no .env e reinicie o CRM.
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-2.5 text-xs text-red-700 ring-1 ring-red-200">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" icon={<Send className="size-4" />} loading={send.isPending} disabled={noPublisher}>
            {send.isPending && needsPublish ? "Publicando…" : "Enviar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RequestModal({
  open,
  onClose,
  lead,
  redo,
}: {
  open: boolean;
  onClose: () => void;
  lead: Lead;
  redo?: SampleSummary | null;
}) {
  const qc = useQueryClient();
  const settings = useSettings();
  const defaultKind = redo?.kind ?? settings.data?.settings.samples?.defaultKind ?? "site";
  const [kind, setKind] = useState<SampleKind | null>(null);
  const [instruction, setInstruction] = useState(redo?.instruction ?? "");
  const [error, setError] = useState<string | null>(null);
  const chosen = kind ?? defaultKind;
  const request = useMutation({
    mutationFn: () =>
      api<{ sample: SampleSummary }>(`/leads/${lead.id}/samples`, {
        body: { kind: chosen, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["samples", lead.id] });
      setInstruction("");
      setKind(null);
      setError(null);
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });
  const options: Array<{ id: SampleKind; title: string; text: string; icon: ReactNode }> = [
    { id: "site", title: "Site demo", text: "Uma página para o negócio do lead, enviada como link.", icon: <Globe className="size-5" /> },
    { id: "image", title: "Arte", text: "Uma imagem (post/banner) enviada pelo WhatsApp.", icon: <ImageIcon className="size-5" /> },
  ];
  return (
    <Modal open={open} onClose={onClose} title={redo ? "Refazer amostra" : `Gerar amostra para ${leadName(lead)}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation(); // o modal pode estar dentro do formulário da conversa
          request.mutate();
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Tipo de amostra">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={chosen === o.id}
              onClick={() => setKind(o.id)}
              className={`flex gap-3 rounded-xl border p-3 text-left transition ${
                chosen === o.id ? "border-violet-400 bg-violet-50 ring-2 ring-violet-100" : "border-slate-200 hover:bg-slate-50"
              }`}
            >
              <span className={chosen === o.id ? "text-violet-600" : "text-slate-400"}>{o.icon}</span>
              <span>
                <span className="block text-sm font-medium">{o.title}</span>
                <span className="block text-xs text-slate-500">{o.text}</span>
              </span>
            </button>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="sample-instruction">
            {redo ? "O que mudar?" : "Pedido para o Claude (opcional)"}
          </label>
          <textarea
            id="sample-instruction"
            className="input"
            rows={3}
            maxLength={1000}
            placeholder={redo ? "Ex.: cores mais sóbrias, destacar o delivery, menos texto" : "Ex.: foco em agendamento online, tons de azul"}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">
            Leva alguns minutos e usa o limite da sua assinatura do Claude. Nada é enviado ao lead sem você revisar.
          </p>
        </div>
        {chosen === "site" && settings.data?.system.publisher == null && (
          <p className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800 ring-1 ring-amber-200">
            O site pode ser criado, mas para enviar o link é preciso configurar <code>NETLIFY_AUTH_TOKEN</code> no .env.
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-2.5 text-xs text-red-700 ring-1 ring-red-200">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" icon={<Sparkles className="size-4" />} loading={request.isPending}>
            {redo ? "Refazer" : "Gerar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
