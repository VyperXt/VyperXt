import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  AtSign,
  CircleStop,
  Copy,
  ExternalLink,
  Globe,
  Mail,
  MapPin,
  MessageCircle,
  MessageCircleOff,
  Phone,
  Radar,
  RotateCcw,
  SearchX,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  UserPlus,
  UserRound,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { PageHeader } from "../components/Layout";
import { IntervalPicker, previewFirstMessage } from "../components/IntervalPicker";
import { Badge, Button, Empty, Field, Modal, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useErrorToast, usePlaybooks, useSettings, useStages, useToast } from "../lib/app-state";
import { formatDateTime, formatPhone, formatTime } from "../lib/format";
import type { ProspectCriteria, ProspectResult, ProspectSearch, ProspectSearchSummary, ProspectStatus } from "../lib/types";

const SIZES = [
  { value: "", label: "Qualquer porte" },
  { value: "MEI/autônomo", label: "MEI / autônomo" },
  { value: "Pequena", label: "Pequena" },
  { value: "Média", label: "Média" },
  { value: "Grande", label: "Grande" },
];
const OTHER_SIZE = "__outro";

const STATUS: Record<ProspectStatus, { label: string; cls: string }> = {
  running: { label: "Pesquisando", cls: "bg-violet-50 text-violet-700 ring-1 ring-violet-200" },
  done: { label: "Concluída", cls: "bg-brand-50 text-brand-700 ring-1 ring-brand-100" },
  failed: { label: "Falhou", cls: "bg-red-50 text-red-700 ring-1 ring-red-200" },
  canceled: { label: "Cancelada", cls: "bg-slate-100 text-slate-600 ring-1 ring-slate-200" },
};

const BLANK: ProspectCriteria = { niche: "", location: "", size: "", offer: "", quantity: 10, extra: "" };

/** Só links da web (o servidor já filtra; aqui é a segunda trava antes de virar href). */
const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? url : null);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Relógio que anda sozinho enquanto `active` (para o tempo decorrido da pesquisa). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function StatusBadge({ status }: { status: ProspectStatus }) {
  const s = STATUS[status];
  return (
    <Badge className={s.cls}>
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-violet-500" />}
      {s.label}
    </Badge>
  );
}

/** Resultado conferido no WhatsApp: "yes", "no" ou não verificado (null/ausente em pesquisas antigas). */
const whatsappOf = (r: ProspectResult) => r.whatsapp ?? null;

function WhatsAppBadge({ value }: { value: "yes" | "no" | null }) {
  const canCheck = useSettings().data?.system.whatsappProvider !== "meta";
  if (value === "yes")
    return (
      <span title="Conferido: este número tem WhatsApp">
        <Badge className="bg-brand-50 text-brand-700 ring-1 ring-brand-100">WhatsApp ✓</Badge>
      </span>
    );
  if (value === "no")
    return (
      <span title="Conferido com e sem o 9: este número não tem WhatsApp">
        <Badge className="bg-red-50 text-red-700 ring-1 ring-red-200">Sem WhatsApp</Badge>
      </span>
    );
  return (
    <span
      title={
        canCheck
          ? "WhatsApp não verificado — use “Verificar WhatsApp” no topo da pesquisa"
          : "WhatsApp não verificado — a API oficial da Meta não confere números"
      }
    >
      <Badge className="bg-slate-100 text-slate-500">não verificado</Badge>
    </span>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const cls =
    score >= 75
      ? "bg-brand-50 text-brand-700 ring-1 ring-brand-100"
      : score >= 50
        ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
        : "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
  return (
    <Badge className={cls}>
      <span title="Encaixe com a sua oferta (0 a 100)">Fit {score}</span>
    </Badge>
  );
}

export function ProspectingPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = Number(params.get("pesquisa")) || null;
  const select = (id: number | null) => setParams(id ? { pesquisa: String(id) } : {});
  const [criteria, setCriteria] = useState<ProspectCriteria>(BLANK);
  const toast = useToast();

  const searches = useQuery({
    queryKey: ["prospect-searches"],
    queryFn: () => api<ProspectSearchSummary[]>("/prospecting/searches"),
    // O tempo real já avisa; a consulta periódica é a reserva caso a conexão caia
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === "running") ? 5000 : false),
  });
  const running = searches.data?.find((s) => s.status === "running");

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Prospecção com IA" subtitle="A IA pesquisa na web empresas do seu público e traz os contatos para você abordar" />
      <div className="min-h-0 flex-1 lg:grid lg:grid-cols-[400px_minmax(0,1fr)]">
        <aside
          className={`${selectedId ? "hidden lg:block" : "block"} h-full space-y-4 overflow-y-auto border-slate-200 p-4 md:p-6 lg:border-r`}
        >
          <SearchForm
            value={criteria}
            onChange={setCriteria}
            running={running}
            onStarted={(id) => select(id)}
            onOpenRunning={() => running && select(running.id)}
          />
          <History items={searches.data} loading={searches.isLoading} selectedId={selectedId} onSelect={select} />
        </aside>
        <section className={`${selectedId ? "block" : "hidden lg:block"} h-full overflow-y-auto bg-slate-50`}>
          {selectedId ? (
            <SearchDetail
              key={selectedId}
              id={selectedId}
              onBack={() => select(null)}
              onReuse={(c) => {
                setCriteria(c);
                select(null);
                toast({ kind: "info", text: "Critérios copiados para o formulário. Ajuste e pesquise de novo." });
              }}
            />
          ) : (
            <HowItWorks />
          )}
        </section>
      </div>
    </div>
  );
}

function HowItWorks() {
  return (
    <div className="mx-auto max-w-xl p-6 lg:pt-16">
      <Empty icon={<Radar className="size-12" />} title="Encontre empresas para prospectar">
        Escolha uma pesquisa no histórico ou comece uma nova.
      </Empty>
      <ol className="mt-2 space-y-3 text-sm text-slate-600">
        {[
          "Diga o nicho, a região, o porte e o que você quer oferecer.",
          "A IA pesquisa no Google Maps, em sites, no Instagram e em guias locais — e só traz contatos que encontrou de verdade, com as fontes.",
          "Você revisa, importa as que fazem sentido como leads e começa a conversa com a mensagem sugerida. Nada é enviado automaticamente.",
        ].map((text, i) => (
          <li key={i} className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-violet-100 text-xs font-semibold text-violet-700">
              {i + 1}
            </span>
            <span>{text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ResearchDisabled() {
  return (
    <div className="flex gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-medium">A prospecção usa o Claude Code, que está desligado.</p>
        <p className="mt-1">
          No arquivo <code>.env</code>, coloque <code>CLAUDE_CODE_ENABLED=true</code> (usa a sua assinatura do Claude; no Docker,
          também <code>CLAUDE_CODE_OAUTH_TOKEN</code> gerado com <code>claude setup-token</code>) e reinicie o servidor. O bot
          continua no OpenRouter.
        </p>
      </div>
    </div>
  );
}

function SearchForm({
  value,
  onChange,
  running,
  onStarted,
  onOpenRunning,
}: {
  value: ProspectCriteria;
  onChange: (c: ProspectCriteria) => void;
  running: ProspectSearchSummary | undefined;
  onStarted: (id: number) => void;
  onOpenRunning: () => void;
}) {
  const qc = useQueryClient();
  const settings = useSettings();
  const sys = settings.data?.system;
  // Enquanto as configurações carregam, não bloqueia (o servidor responde 503 se não der)
  const canResearch = sys?.aiResearch !== false;
  const [customSize, setCustomSize] = useState(false);
  const sizeIsOther = customSize || !SIZES.some((s) => s.value === value.size);
  const set = (patch: Partial<ProspectCriteria>) => onChange({ ...value, ...patch });

  const start = useMutation({
    mutationFn: () =>
      api<{ search: ProspectSearch }>("/prospecting/searches", {
        body: {
          niche: value.niche.trim(),
          location: value.location.trim(),
          size: value.size.trim(),
          offer: value.offer.trim(),
          quantity: value.quantity,
          extra: value.extra.trim(),
        },
      }),
    onSuccess: ({ search }) => {
      qc.setQueryData(["prospect-search", search.id], search);
      qc.invalidateQueries({ queryKey: ["prospect-searches"] });
      onStarted(search.id);
    },
  });

  const quantityOk = Number.isInteger(value.quantity) && value.quantity >= 1 && value.quantity <= 25;
  const valid = value.niche.trim().length >= 2 && value.location.trim().length >= 2 && quantityOk;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && canResearch && !running) start.mutate();
  };

  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-violet-600" />
        <h2 className="text-sm font-semibold">Nova pesquisa</h2>
      </div>
      {!canResearch && <ResearchDisabled />}
      <fieldset disabled={!canResearch} className="space-y-3">
        <Field label="Nicho / segmento *">
          <input
            className="input"
            placeholder="Ex.: clínicas odontológicas"
            value={value.niche}
            maxLength={200}
            onChange={(e) => set({ niche: e.target.value })}
            required
          />
        </Field>
        <Field label="Onde *">
          <input
            className="input"
            placeholder="Ex.: Pinheiros, São Paulo — ou: Campinas e região"
            value={value.location}
            maxLength={200}
            onChange={(e) => set({ location: e.target.value })}
            required
          />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
          <Field label="Porte">
            <select
              className="input"
              value={sizeIsOther ? OTHER_SIZE : value.size}
              onChange={(e) => {
                const v = e.target.value;
                setCustomSize(v === OTHER_SIZE);
                set({ size: v === OTHER_SIZE ? "" : v });
              }}
            >
              {SIZES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
              <option value={OTHER_SIZE}>Outro (descrever)</option>
            </select>
          </Field>
          <Field label="Quantidade">
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={1}
              max={25}
              value={value.quantity || ""}
              onChange={(e) => set({ quantity: Math.trunc(Number(e.target.value)) })}
              aria-invalid={!quantityOk}
            />
          </Field>
        </div>
        {sizeIsOther && (
          <input
            className="input"
            placeholder="Ex.: de 5 a 20 funcionários"
            value={value.size}
            maxLength={100}
            onChange={(e) => set({ size: e.target.value })}
            aria-label="Porte (descrição)"
            autoFocus={customSize}
          />
        )}
        {!quantityOk && <p className="text-xs text-red-600">A quantidade vai de 1 a 25 empresas por pesquisa.</p>}
        <Field
          label="O que você quer oferecer"
          hint={
            <>
              A IA também usa o que está em{" "}
              <Link to="/configuracoes" className="underline hover:text-slate-700">
                Configurações → Empresa
              </Link>{" "}
              (descrição e produtos).
            </>
          }
        >
          <textarea
            className="input"
            rows={3}
            placeholder="Ex.: sistema de agendamento online com lembrete pelo WhatsApp"
            value={value.offer}
            maxLength={1000}
            onChange={(e) => set({ offer: e.target.value })}
          />
        </Field>
        <Field label="Observações">
          <textarea
            className="input"
            rows={2}
            placeholder="Ex.: só quem tem Instagram ativo; evitar franquias"
            value={value.extra}
            maxLength={1000}
            onChange={(e) => set({ extra: e.target.value })}
          />
        </Field>
      </fieldset>

      {running ? (
        <div className="rounded-lg bg-violet-50 p-3 text-sm text-violet-900">
          Já tem uma pesquisa rodando ({running.criteria.niche}).{" "}
          <button type="button" onClick={onOpenRunning} className="font-medium underline">
            Acompanhar
          </button>
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          Leva alguns minutos
          {sys?.aiProvider === "claude-code" ? " e usa o limite da sua assinatura do Claude" : " e consome créditos da IA"}. Pode sair desta
          tela: avisamos quando terminar.
        </p>
      )}
      {start.error && <p className="text-sm text-red-600">{start.error.message}</p>}
      <Button
        type="submit"
        className="w-full"
        icon={<Radar className="size-4" />}
        loading={start.isPending}
        disabled={!valid || !canResearch || Boolean(running)}
      >
        Pesquisar empresas
      </Button>
    </form>
  );
}

function History({
  items,
  loading,
  selectedId,
  onSelect,
}: {
  items: ProspectSearchSummary[] | undefined;
  loading: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="card overflow-hidden">
      <h2 className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold">Pesquisas</h2>
      {loading && <Spinner className="m-4" />}
      {items?.length === 0 && <p className="px-4 py-3 text-sm text-slate-500">Nenhuma pesquisa ainda.</p>}
      <ul className="divide-y divide-slate-100">
        {items?.map((s) => (
          <li key={s.id}>
            <button
              onClick={() => onSelect(s.id)}
              className={`w-full px-4 py-2.5 text-left transition hover:bg-slate-50 ${s.id === selectedId ? "bg-slate-50" : ""}`}
              aria-current={s.id === selectedId ? "true" : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium">{s.criteria.niche}</p>
                <StatusBadge status={s.status} />
              </div>
              <p className="truncate text-xs text-slate-500">
                {s.criteria.location}
                {s.criteria.size && ` · ${s.criteria.size}`}
              </p>
              <p className="mt-0.5 text-xs text-slate-400">
                {formatDateTime(s.createdAt)}
                {s.status === "done" && ` · ${s.resultCount} empresa(s)`}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SearchDetail({ id, onBack, onReuse }: { id: number; onBack: () => void; onReuse: (c: ProspectCriteria) => void }) {
  const qc = useQueryClient();
  const onError = useErrorToast();
  const q = useQuery({
    queryKey: ["prospect-search", id],
    queryFn: () => api<ProspectSearch>(`/prospecting/searches/${id}`),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 5000 : false),
  });
  const search = q.data;
  const isRunning = search?.status === "running";
  const now = useNow(isRunning);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["prospect-search", id] });
    qc.invalidateQueries({ queryKey: ["prospect-searches"] });
  };
  const cancel = useMutation({
    mutationFn: () => api(`/prospecting/searches/${id}/cancel`, { method: "POST" }),
    onSuccess: refresh,
    onError,
  });
  const toast = useToast();
  // A API da Meta não confere números (o servidor responde 400): nem mostra o botão
  const canCheckWhatsApp = useSettings().data?.system.whatsappProvider !== "meta";
  const checkWhatsApp = useMutation({
    mutationFn: () =>
      api<{ yes: number; no: number; unchecked: number }>(`/prospecting/searches/${id}/check-whatsapp`, { method: "POST" }),
    onSuccess: (r) => {
      refresh();
      const parts = [`${r.yes} com WhatsApp, ${r.no} sem WhatsApp.`];
      if (r.unchecked) parts.push(`Não deu para conferir ${r.unchecked} (o WhatsApp está conectado?).`);
      toast({ kind: r.unchecked ? "info" : "success", text: parts.join(" ") });
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api(`/prospecting/searches/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ["prospect-search", id] });
      qc.invalidateQueries({ queryKey: ["prospect-searches"] });
      onBack();
    },
    onError,
  });

  const back = (
    <button onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 lg:hidden">
      <ArrowLeft className="size-4" /> Pesquisas
    </button>
  );

  if (q.isLoading) return <Spinner className="m-6" />;
  if (!search)
    return (
      <div className="p-4 md:p-6">
        {back}
        <Empty icon={<SearchX className="size-10" />} title="Pesquisa não encontrada">
          {q.error?.message}
        </Empty>
      </div>
    );

  const c = search.criteria;
  const withPhone = search.results.filter((r) => r.phone);
  const unchecked = withPhone.filter((r) => whatsappOf(r) === null).length;
  const elapsed = (search.finishedAt ? new Date(search.finishedAt).getTime() : now) - new Date(search.createdAt).getTime();

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        {back}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{c.niche}</h2>
              <StatusBadge status={search.status} />
            </div>
            <p className="text-sm text-slate-600">
              {c.location}
              {c.size && ` · ${c.size}`} · até {c.quantity} empresa(s)
            </p>
            <p className="text-xs text-slate-400">
              {formatDateTime(search.createdAt)}
              {search.finishedAt && ` · levou ${formatElapsed(elapsed)}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isRunning ? (
              <Button variant="danger" size="sm" icon={<CircleStop className="size-3.5" />} loading={cancel.isPending} onClick={() => cancel.mutate()}>
                Cancelar
              </Button>
            ) : (
              <>
                {search.status === "done" && withPhone.length > 0 && canCheckWhatsApp && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ShieldCheck className="size-3.5" />}
                    loading={checkWhatsApp.isPending}
                    onClick={() => checkWhatsApp.mutate()}
                    title={
                      unchecked
                        ? `${unchecked} telefone(s) ainda não conferido(s) no WhatsApp`
                        : "Conferir de novo quem tem WhatsApp"
                    }
                  >
                    {checkWhatsApp.isPending ? "Verificando…" : unchecked ? "Verificar WhatsApp" : "Verificar de novo"}
                  </Button>
                )}
                <Button variant="secondary" size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => onReuse({ ...c })}>
                  Usar estes critérios
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-600"
                  icon={<Trash2 className="size-3.5" />}
                  loading={remove.isPending}
                  onClick={() => confirm("Apagar esta pesquisa? Os leads já importados continuam no CRM.") && remove.mutate()}
                >
                  Apagar
                </Button>
              </>
            )}
          </div>
        </div>
        {(c.offer || c.extra) && (
          <div className="mt-2 space-y-0.5 text-sm text-slate-600">
            {c.offer && (
              <p>
                <span className="text-slate-400">Oferta:</span> {c.offer}
              </p>
            )}
            {c.extra && (
              <p>
                <span className="text-slate-400">Observações:</span> {c.extra}
              </p>
            )}
          </div>
        )}
      </div>

      {isRunning && (
        <div className="card flex flex-col items-center gap-3 p-6 text-center sm:p-8">
          <div className="relative grid size-14 place-items-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-violet-200 opacity-60" />
            <Radar className="relative size-8 text-violet-600" />
          </div>
          <div>
            <p className="font-medium">A IA está pesquisando na web…</p>
            <p className="text-sm text-slate-500 tabular-nums">{formatElapsed(elapsed)} — costuma levar de 2 a 10 minutos</p>
          </div>
          {search.progress && (
            <p className="max-w-full rounded-lg bg-slate-50 px-3 py-2 text-sm break-words text-slate-600">{search.progress}</p>
          )}
          <p className="text-xs text-slate-400">Pode sair desta tela: avisamos quando terminar.</p>
        </div>
      )}

      {search.status === "failed" && (
        <div className="flex gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-800 ring-1 ring-red-200">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">A pesquisa não terminou.</p>
            <p className="mt-1 break-words">{search.error}</p>
          </div>
        </div>
      )}

      {search.status === "canceled" && (
        <div className="rounded-xl bg-slate-100 p-4 text-sm text-slate-600">Pesquisa cancelada.</div>
      )}

      {search.status === "done" && (
        <>
          {search.progress && (
            <div className="rounded-xl bg-sky-50 p-3 text-sm text-sky-900">
              <span className="font-medium">Observações da IA:</span> {search.progress}
            </div>
          )}
          {search.results.length === 0 ? (
            <div className="card">
              <Empty icon={<SearchX className="size-10" />} title="Nenhuma empresa com contato encontrada">
                Tente uma região maior, um nicho mais amplo ou menos restrições nas observações.
              </Empty>
            </div>
          ) : (
            <Results search={search} />
          )}
        </>
      )}
    </div>
  );
}

const importable = (r: ProspectResult) => !r.leadId && !r.duplicateLeadId && Boolean(r.phone || r.email);

function Results({ search }: { search: ProspectSearch }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const stages = useStages();
  const playbooks = usePlaybooks();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [stageId, setStageId] = useState("");
  const [playbookId, setPlaybookId] = useState("");
  const [chatMode, setChatMode] = useState<"human" | "bot">("human");
  // Disparo da 1ª mensagem junto com a importação (confirma num modal antes)
  const [sendFirst, setSendFirst] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [firstMsg, setFirstMsg] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const playbook = playbooks.data?.find((p) => String(p.id) === playbookId);

  const candidates = search.results.flatMap((r, i) => (importable(r) ? [i] : []));
  // "Selecionar todas" deixa de fora quem não tem WhatsApp (ainda dá para marcar um por um)
  const bulk = candidates.filter((i) => whatsappOf(search.results[i]!) !== "no");
  const chosen = candidates.filter((i) => selected.has(i));
  const allChosen = bulk.length > 0 && bulk.every((i) => selected.has(i));
  const imported = search.results.filter((r) => r.leadId).length;
  const noWhatsApp = search.results.filter((r) => whatsappOf(r) === "no").length;

  const toggle = (i: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const importMut = useMutation({
    mutationFn: (firstMessage?: { send: true; text: string; intervalMinutes: number }) =>
      api<{
        created: number;
        ids: number[];
        skipped: number;
        errors: Array<{ index: number; error: string }>;
        queued?: number;
        sendSkipped?: Array<{ leadId: number; reason: string }>;
        lastSendAt?: string | null;
      }>(`/prospecting/searches/${search.id}/import`, {
        body: {
          indexes: chosen,
          ...(stageId ? { stageId: Number(stageId) } : {}),
          ...(playbookId ? { playbookId: Number(playbookId) } : {}),
          chatMode,
          ...(firstMessage ? { firstMessage } : {}),
        },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["prospect-search", search.id] });
      qc.invalidateQueries({ queryKey: ["prospect-searches"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["playbooks"] });
      setSelected(new Set());
      const parts = [`${r.created} lead(s) criado(s).`];
      if (r.skipped) parts.push(`${r.skipped} já tinha(m) sido importado(s).`);
      if (r.errors.length) parts.push(`${r.errors.length} não importado(s): ${r.errors[0]!.error}`);
      if (r.queued) {
        parts.push(
          `${r.queued} primeira(s) mensagem(ns) na fila${r.queued > 1 && r.lastSendAt ? `, a última por volta de ${formatTime(r.lastSendAt)}` : ""}.`,
        );
      }
      if (r.sendSkipped?.length) parts.push(`${r.sendSkipped.length} sem envio: ${r.sendSkipped[0]!.reason}.`);
      setConfirmOpen(false);
      toast({ kind: r.errors.length ? "info" : "success", text: parts.join(" ") });
    },
    onError,
  });

  return (
    <div className="space-y-3">
      <div className="card sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
        <label className="flex items-center gap-2 text-sm select-none">
          <input
            type="checkbox"
            className="size-4 accent-brand-600"
            checked={allChosen}
            disabled={bulk.length === 0}
            // Soma às já marcadas: não desmarca quem foi marcado um por um (ex.: sem WhatsApp)
            onChange={() => setSelected(allChosen ? new Set() : new Set([...chosen, ...bulk]))}
          />
          {chosen.length ? `${chosen.length} selecionada(s)` : "Selecionar todas"}
        </label>
        <p className="text-xs text-slate-500">
          {search.results.length} empresa(s)
          {imported > 0 && ` · ${imported} importada(s)`}
          {noWhatsApp > 0 && ` · ${noWhatsApp} sem WhatsApp`}
        </p>
        <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
          <select
            className="input w-auto min-w-0 flex-1 py-1.5 text-xs sm:flex-none"
            value={stageId}
            onChange={(e) => setStageId(e.target.value)}
            aria-label="Etapa dos leads importados"
          >
            <option value="">Etapa inicial do funil</option>
            {stages.data
              ?.filter((s) => s.kind === "open")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
          <select
            className="input w-auto min-w-0 flex-1 py-1.5 text-xs sm:flex-none"
            value={playbookId}
            onChange={(e) => setPlaybookId(e.target.value)}
            aria-label="Roteiro dos leads importados"
          >
            <option value="">Sem roteiro</option>
            {playbooks.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            className="input w-auto min-w-0 flex-1 py-1.5 text-xs sm:flex-none"
            value={chatMode}
            onChange={(e) => setChatMode(e.target.value as "human" | "bot")}
            aria-label="Modo de atendimento"
          >
            <option value="human">Eu respondo (copiloto)</option>
            <option value="bot">IA responde sozinha (bot)</option>
          </select>
          <label className="flex items-center gap-1.5 rounded-lg px-1 text-xs font-medium text-slate-700 select-none">
            <input
              type="checkbox"
              className="size-4 accent-brand-600"
              checked={sendFirst}
              onChange={(e) => setSendFirst(e.target.checked)}
            />
            Disparar 1ª mensagem
          </label>
          <Button
            size="sm"
            icon={sendFirst ? <Send className="size-3.5" /> : <UserPlus className="size-3.5" />}
            disabled={!chosen.length}
            loading={importMut.isPending && !confirmOpen}
            onClick={() => {
              if (!sendFirst) return importMut.mutate(undefined);
              if (!firstMsg.trim() && playbook?.firstMessage) setFirstMsg(playbook.firstMessage);
              setConfirmOpen(true);
            }}
          >
            {sendFirst ? `Importar e disparar${chosen.length ? ` (${chosen.length})` : ""}` : `Importar ${chosen.length ? chosen.length : ""} como lead(s)`}
          </Button>
        </div>
      </div>
      <p className="px-1 text-xs text-slate-500">
        Confira os dados nas fontes antes de abordar. Os leads entram com a etapa, o roteiro e o modo escolhidos acima.{" "}
        {sendFirst
          ? "Com “Disparar 1ª mensagem”, você confere o texto e o intervalo antes; os envios vão para a fila e, quando o lead responder, o modo escolhido assume."
          : "Nenhuma mensagem é enviada ao importar: marque “Disparar 1ª mensagem” para já começar a abordagem."}
      </p>
      <Modal open={confirmOpen} onClose={() => !importMut.isPending && setConfirmOpen(false)} title="Importar e disparar a 1ª mensagem" wide>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            <b className="text-slate-900">{chosen.length} empresa(s)</b> viram leads
            {playbook ? (
              <>
                {" "}
                com o roteiro <b className="text-slate-900">{playbook.name}</b>
              </>
            ) : (
              " sem roteiro"
            )}{" "}
            e modo <b className="text-slate-900">{chatMode === "bot" ? "IA responde sozinha" : "eu respondo (copiloto)"}</b>. Quem não tem
            WhatsApp ou já é lead não recebe.
          </p>
          <Field label="Primeira mensagem" hint="Variáveis: {nome}, {primeiro_nome}, {empresa}">
            <textarea
              className="input"
              rows={4}
              value={firstMsg}
              onChange={(e) => setFirstMsg(e.target.value)}
              placeholder="Oi, tudo bem? Vi o trabalho da {empresa} aqui na internet…"
            />
          </Field>
          {chosen[0] !== undefined && firstMsg.trim() && (
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-500">Prévia com {search.results[chosen[0]]!.company}:</p>
              <p className="rounded-lg bg-[#d9fdd3] px-3 py-2 text-sm whitespace-pre-wrap text-slate-800">
                {previewFirstMessage(firstMsg, {
                  name: search.results[chosen[0]]!.contactName || search.results[chosen[0]]!.company,
                  company: search.results[chosen[0]]!.company,
                })}
              </p>
            </div>
          )}
          <IntervalPicker value={intervalMinutes} onChange={setIntervalMinutes} count={chosen.length} />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={importMut.isPending}>
              Cancelar
            </Button>
            <Button
              icon={<Send className="size-4" />}
              loading={importMut.isPending}
              disabled={!firstMsg.trim()}
              onClick={() => importMut.mutate({ send: true, text: firstMsg.trim(), intervalMinutes })}
            >
              Importar e disparar
            </Button>
          </div>
        </div>
      </Modal>
      <ul className="space-y-3">
        {search.results.map((r, i) => (
          <ResultCard key={i} r={r} checked={selected.has(i)} canSelect={importable(r)} onToggle={() => toggle(i)} />
        ))}
      </ul>
    </div>
  );
}

function ResultCard({ r, checked, canSelect, onToggle }: { r: ProspectResult; checked: boolean; canSelect: boolean; onToggle: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const website = safeHref(r.website);
  const instagram = safeHref(r.instagram);
  const sources = r.sources.map(safeHref).filter((u): u is string => Boolean(u));
  const name = r.company || "Empresa sem nome";
  const whatsapp = whatsappOf(r);
  const noWhatsApp = Boolean(r.phone) && whatsapp === "no";

  const copyApproach = async () => {
    try {
      await navigator.clipboard.writeText(r.approach);
      toast({ kind: "success", text: "Mensagem copiada." });
    } catch {
      toast({ kind: "error", text: "Não foi possível copiar. Selecione o texto e copie manualmente." });
    }
  };

  return (
    <li className={`card p-4 transition ${checked ? "ring-2 ring-brand-500/40" : ""}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-brand-600"
          checked={checked}
          disabled={!canSelect}
          onChange={onToggle}
          aria-label={`Selecionar ${name}`}
          title={canSelect ? undefined : r.leadId ? "Já importada" : r.duplicateLeadId ? "Já é lead" : "Sem telefone nem e-mail"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="font-semibold break-words">{name}</h3>
                <ScoreBadge score={r.score} />
                {r.leadId ? (
                  <Link to={`/leads/${r.leadId}`}>
                    <Badge className="bg-brand-50 text-brand-700 ring-1 ring-brand-100 hover:underline">Importada · lead #{r.leadId}</Badge>
                  </Link>
                ) : (
                  r.duplicateLeadId && (
                    <Link to={`/leads/${r.duplicateLeadId}`}>
                      <Badge className="bg-amber-50 text-amber-800 ring-1 ring-amber-200 hover:underline">Já é lead #{r.duplicateLeadId}</Badge>
                    </Link>
                  )
                )}
              </div>
              {(r.city || r.size) && <p className="text-xs text-slate-500">{[r.city, r.size].filter(Boolean).join(" · ")}</p>}
            </div>
            {r.leadId &&
              (noWhatsApp ? (
                <span title="Este número não tem WhatsApp (conferido com e sem o 9). Use o e-mail ou o site da empresa.">
                  <Button size="sm" variant="secondary" icon={<MessageCircleOff className="size-3.5" />} disabled>
                    Conversar
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  icon={<MessageCircle className="size-3.5" />}
                  onClick={() => navigate(`/conversas/${r.leadId}${r.approach ? `?mensagem=${encodeURIComponent(r.approach)}` : ""}`)}
                >
                  Conversar
                </Button>
              ))}
          </div>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-slate-700">
            {r.contactName && (
              <span className="inline-flex items-center gap-1.5">
                <UserRound className="size-3.5 text-slate-400" /> {r.contactName}
              </span>
            )}
            {r.phone ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Phone className="size-3.5 text-slate-400" />
                <span className="tabular-nums">{formatPhone(r.phone)}</span>
                {!r.isMobile && <Badge className="bg-slate-100 text-slate-500">fixo</Badge>}
                <WhatsAppBadge value={whatsapp} />
              </span>
            ) : (
              r.rawPhone && (
                <span className="inline-flex items-center gap-1.5 text-slate-500" title="Número que não parece válido para WhatsApp">
                  <Phone className="size-3.5 text-slate-400" /> {r.rawPhone} <span className="text-xs">(não validado)</span>
                </span>
              )
            )}
            {r.email && (
              <a href={`mailto:${r.email}`} className="inline-flex min-w-0 items-center gap-1.5 break-all hover:underline">
                <Mail className="size-3.5 shrink-0 text-slate-400" /> {r.email}
              </a>
            )}
            {r.address && (
              <span className="inline-flex min-w-0 items-start gap-1.5">
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-slate-400" /> {r.address}
              </span>
            )}
          </div>

          {noWhatsApp && canSelect && (
            <p className="mt-1.5 text-xs text-red-700">
              Sem WhatsApp — {r.email || r.website || r.instagram ? "dá para importar e abordar pelo e-mail/site." : "confira outro contato nas fontes."}
            </p>
          )}

          {r.fitReason && <p className="mt-2 text-sm text-slate-600">{r.fitReason}</p>}

          {(website || instagram || sources.length > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {website && (
                <a href={website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-700 hover:underline">
                  <Globe className="size-3.5" /> {hostOf(website)}
                </a>
              )}
              {instagram && (
                <a href={instagram} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-700 hover:underline">
                  <AtSign className="size-3.5" /> Instagram
                </a>
              )}
              {sources.length > 0 && (
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-500">
                  Fontes:
                  {sources.map((s, j) => (
                    <a key={j} href={s} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-slate-600 hover:underline" title={s}>
                      {hostOf(s)} <ExternalLink className="size-3" />
                    </a>
                  ))}
                </span>
              )}
            </div>
          )}

          {r.approach && (
            <details className="group mt-3 rounded-lg border border-slate-200">
              <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-violet-700 select-none hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="size-3.5" />
                  <span className="group-open:hidden">Ver sugestão de primeira mensagem</span>
                  <span className="hidden group-open:inline">Sugestão de primeira mensagem</span>
                </span>
              </summary>
              <div className="border-t border-slate-200 px-3 py-2">
                <p className="text-sm whitespace-pre-wrap text-slate-700">{r.approach}</p>
                <Button variant="ghost" size="sm" className="mt-1 -ml-2" icon={<Copy className="size-3.5" />} onClick={copyApproach}>
                  Copiar
                </Button>
              </div>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}
