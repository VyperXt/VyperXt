import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Compass,
  HelpCircle,
  Lightbulb,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  ThumbsUp,
  Trash2,
  Wand2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useErrorToast } from "../lib/app-state";
import { formatDateTime } from "../lib/format";
import type { CopilotResponse, Lead } from "../lib/types";
import { AutoTextarea } from "./AutoTextarea";
import { Button, Spinner } from "./ui";

const SENTIMENT = {
  positivo: "bg-emerald-50 text-emerald-700",
  neutro: "bg-slate-100 text-slate-700",
  negativo: "bg-red-50 text-red-700",
};

const IMPROVE_DRAFT = "Melhore meu rascunho para conduzir melhor a conversa, mantendo minha intenção e o tom da empresa.";
const STARTERS = ["Qual o próximo passo com esse lead?", "Como respondo se ele achar caro?", "Escreva uma abordagem curta para ele"];
// Quanto da conversa com o copiloto vai junto em cada pergunta (o servidor aceita até 8000 caracteres)
const MAX_QUESTION_CHARS = 7500;

type Turn =
  | { id: number; role: "user"; text: string; label?: string }
  | { id: number; role: "copilot"; answer: string; suggestedMessage: string }
  | { id: number; role: "error"; text: string; retry: { question: string; draft?: string; label?: string } };

// Conversa com o copiloto por lead: sobrevive à troca de lead enquanto a página estiver aberta
const threads = new Map<number, Turn[]>();
let nextId = 1;

/** Junta o histórico do chat à pergunta nova, para o copiloto lembrar do que já foi dito. */
function withHistory(turns: Turn[], question: string): string {
  const lines: string[] = [];
  for (const t of turns) {
    if (t.role === "user") lines.push(`Vendedor: ${t.text}`);
    else if (t.role === "copilot")
      lines.push(`Copiloto: ${t.answer}${t.suggestedMessage ? `\n(mensagem sugerida: ${t.suggestedMessage})` : ""}`);
  }
  if (!lines.length) return question;
  const tail = `\n\nNova pergunta do vendedor: ${question}`;
  let history = lines.join("\n");
  const room = MAX_QUESTION_CHARS - tail.length - 80;
  if (history.length > room) history = "…" + history.slice(history.length - room);
  return `Nossa conversa até aqui (você é o "Copiloto"):\n${history}${tail}`;
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        {icon}
        {title}
      </h4>
      {children}
    </div>
  );
}

function Chips({ items, cls }: { items: string[]; cls: string }) {
  if (!items.length) return <p className="text-xs text-slate-400">Nada identificado.</p>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((t, i) => (
        <span key={i} className={`rounded-md px-2 py-0.5 text-xs ${cls}`}>
          {t}
        </span>
      ))}
    </div>
  );
}

function UseDraftButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="mt-1.5 text-xs font-medium text-brand-700 hover:underline">
      Usar no rascunho →
    </button>
  );
}

/**
 * Copiloto / direcionador de conversa.
 * Só sugere: "Usar no rascunho" coloca o texto na sua caixa de mensagem para você editar e enviar.
 */
export function CopilotPanel({ lead, onUseDraft, draft }: { lead: Lead; onUseDraft: (text: string) => void; draft: string }) {
  const qc = useQueryClient();
  const onError = useErrorToast();
  const [tab, setTab] = useState<"insights" | "chat">("insights");
  const [question, setQuestion] = useState("");
  const [turns, setTurnsState] = useState<Turn[]>(() => threads.get(lead.id) ?? []);
  const chatEnd = useRef<HTMLDivElement>(null);

  // Trocou de lead: mostra a conversa daquele lead
  useEffect(() => {
    setTurnsState(threads.get(lead.id) ?? []);
    setQuestion("");
  }, [lead.id]);

  const setTurns = (leadId: number, update: (prev: Turn[]) => Turn[]) => {
    const next = update(threads.get(leadId) ?? []);
    threads.set(leadId, next);
    if (leadId === lead.id) setTurnsState(next);
  };

  const q = useQuery({
    queryKey: ["copilot", lead.id],
    queryFn: () => api<CopilotResponse>(`/leads/${lead.id}/copilot`),
  });
  const refresh = useMutation({
    mutationFn: () => api<CopilotResponse>(`/leads/${lead.id}/copilot`, { method: "POST" }),
    onSuccess: (data) => qc.setQueryData(["copilot", lead.id], data),
    onError,
  });
  const ask = useMutation({
    mutationFn: (v: { leadId: number; question: string; draft?: string; label?: string; history: Turn[] }) =>
      api<{ answer: string; suggestedMessage: string }>(`/leads/${v.leadId}/copilot/ask`, {
        body: { question: withHistory(v.history, v.question), draft: v.draft },
      }),
    onSuccess: (res, v) =>
      setTurns(v.leadId, (prev) => [...prev, { id: nextId++, role: "copilot", answer: res.answer, suggestedMessage: res.suggestedMessage }]),
    onError: (err, v) =>
      setTurns(v.leadId, (prev) => [
        ...prev,
        {
          id: nextId++,
          role: "error",
          text: err instanceof Error ? err.message : "Não consegui responder agora.",
          retry: { question: v.question, draft: v.draft, label: v.label },
        },
      ]),
  });

  const send = (text: string, opts: { draft?: string; label?: string } = {}) => {
    const value = text.trim();
    if (!value || ask.isPending) return;
    const history = (threads.get(lead.id) ?? []).filter((t) => t.role !== "error");
    setTurns(lead.id, (prev) => [...prev, { id: nextId++, role: "user", text: value, label: opts.label }]);
    setTab("chat");
    setQuestion("");
    ask.mutate({ leadId: lead.id, question: value, draft: opts.draft ?? (draft.trim() || undefined), label: opts.label, history });
  };

  // Mensagem nova no chat: rola até o fim
  useEffect(() => {
    if (tab === "chat") chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, ask.isPending, tab]);

  const data = q.data?.insight?.data;
  const aiEnabled = q.data?.aiEnabled ?? true;
  const pending = ask.isPending && ask.variables?.leadId === lead.id;

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-slate-200 px-4 pt-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="flex items-center gap-1.5 font-semibold">
              <Compass className="size-4 text-violet-600" /> Copiloto
            </h3>
            <p className="text-xs text-slate-500">Sugere caminhos — quem envia é você</p>
          </div>
          {tab === "insights" ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="size-3.5" />}
              loading={refresh.isPending}
              disabled={!aiEnabled}
              onClick={() => refresh.mutate()}
            >
              Atualizar
            </Button>
          ) : (
            turns.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 className="size-3.5" />}
                disabled={pending}
                onClick={() => setTurns(lead.id, () => [])}
                title="Apagar a conversa com o copiloto"
              >
                Limpar
              </Button>
            )
          )}
        </div>
        <div className="mt-2 flex gap-4 text-sm" role="tablist">
          {(
            [
              ["insights", "Sugestões", <Lightbulb key="i" className="size-3.5" />],
              ["chat", "Chat", <MessageCircle key="c" className="size-3.5" />],
            ] as const
          ).map(([key, label, icon]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 pb-2 font-medium transition-colors ${
                tab === key ? "border-violet-600 text-violet-700" : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {icon}
              {label}
              {key === "chat" && turns.length > 0 && (
                <span className="rounded-full bg-violet-100 px-1.5 text-[11px] text-violet-700">
                  {turns.filter((t) => t.role === "user").length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === "insights" ? (
        <div className="scroll-thin flex-1 space-y-5 overflow-y-auto p-4">
          {!aiEnabled && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              IA desativada. Configure <code>ANTHROPIC_API_KEY</code> ou <code>OPENROUTER_API_KEY</code> no <code>.env</code> para ativar o copiloto.
            </p>
          )}
          {lead.chatMode === "bot" && aiEnabled && (
            <p className="rounded-lg bg-sky-50 p-3 text-xs text-sky-800">
              A IA está respondendo este lead sozinha. Mude para <b>Eu respondo</b> para o copiloto acompanhar cada mensagem.
            </p>
          )}
          {q.isLoading && <Spinner />}
          {!q.isLoading && !data && aiEnabled && (
            <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
              Nenhuma sugestão ainda. Elas aparecem sozinhas quando o lead manda mensagem — ou clique em <b>Atualizar</b>.
            </div>
          )}

          {data && (
            <>
              {q.data?.stale && (
                <p className="flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
                  <AlertTriangle className="size-3.5" /> Teve mensagem nova depois desta análise.
                </p>
              )}
              <div className="rounded-xl bg-violet-50 p-3 ring-1 ring-violet-200">
                <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-violet-700 uppercase">
                  <Lightbulb className="size-3.5" /> Próximo passo
                </p>
                <p className="text-sm text-violet-950">{data.nextBestAction}</p>
              </div>

              <Section icon={<Sparkles className="size-3.5" />} title="Leitura da conversa">
                <p className="text-sm text-slate-700">{data.summary}</p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-slate-50 p-2">
                    <p className="text-slate-500">Intenção</p>
                    <p className="font-medium">{data.intent}</p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-2">
                    <p className="text-slate-500">Momento</p>
                    <p className="font-medium">{data.buyingStage}</p>
                  </div>
                </div>
                <span className={`mt-2 inline-block rounded-md px-2 py-0.5 text-xs font-medium ${SENTIMENT[data.sentiment]}`}>
                  Sentimento: {data.sentiment}
                </span>
              </Section>

              <Section icon={<ArrowRight className="size-3.5" />} title="Caminhos possíveis">
                <div className="space-y-2">
                  {data.paths.map((p, i) => (
                    <div key={i} className="rounded-lg border border-slate-200 p-3">
                      <p className="text-sm font-semibold">
                        {i + 1}. {p.title}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">{p.strategy}</p>
                      <p className="mt-2 rounded-lg bg-[#d9fdd3] px-3 py-2 text-sm whitespace-pre-wrap text-slate-800">{p.message}</p>
                      <UseDraftButton onClick={() => onUseDraft(p.message)} />
                    </div>
                  ))}
                </div>
              </Section>

              <Section icon={<AlertTriangle className="size-3.5" />} title="Objeções">
                <Chips items={data.objections} cls="bg-amber-50 text-amber-800" />
              </Section>
              <Section icon={<ThumbsUp className="size-3.5" />} title="Sinais de compra">
                <Chips items={data.buyingSignals} cls="bg-emerald-50 text-emerald-800" />
              </Section>
              <Section icon={<HelpCircle className="size-3.5" />} title="Falta descobrir">
                <Chips items={data.missingInfo} cls="bg-sky-50 text-sky-800" />
              </Section>
              <Section icon={<Ban className="size-3.5" />} title="Evite">
                <Chips items={data.avoid} cls="bg-red-50 text-red-700" />
              </Section>
              <p className="text-[11px] text-slate-400">Análise de {formatDateTime(q.data?.insight?.createdAt)}</p>
            </>
          )}
        </div>
      ) : (
        <div className="scroll-thin flex-1 overflow-y-auto bg-slate-50/60 p-3">
          {turns.length === 0 && !pending ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-violet-100">
                <MessageCircle className="size-5 text-violet-600" />
              </div>
              <p className="text-sm text-slate-600">
                Pergunte qualquer coisa sobre esta conversa. O copiloto lê o histórico com o lead e lembra do que vocês já falaram aqui.
              </p>
              <div className="flex flex-col gap-1.5">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    disabled={!aiEnabled}
                    onClick={() => send(s)}
                    className="rounded-full border border-violet-200 bg-white px-3 py-1.5 text-xs text-violet-700 hover:bg-violet-50 disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {turns.map((t) =>
                t.role === "user" ? (
                  <div key={t.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-violet-600 px-3 py-2 text-sm whitespace-pre-wrap text-white shadow-sm">
                      {t.label ? (
                        <span className="flex items-center gap-1.5">
                          <Wand2 className="size-3.5" /> {t.label}
                        </span>
                      ) : (
                        t.text
                      )}
                    </div>
                  </div>
                ) : t.role === "copilot" ? (
                  <div key={t.id} className="flex">
                    <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-white px-3 py-2 text-sm shadow-sm ring-1 ring-slate-200">
                      <p className="whitespace-pre-wrap text-slate-700">{t.answer}</p>
                      {t.suggestedMessage && (
                        <>
                          <p className="mt-2 rounded-lg bg-[#d9fdd3] px-3 py-2 whitespace-pre-wrap text-slate-800">{t.suggestedMessage}</p>
                          <UseDraftButton onClick={() => onUseDraft(t.suggestedMessage)} />
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div key={t.id} className="flex">
                    <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
                      <p>{t.text}</p>
                      <button
                        disabled={pending}
                        onClick={() => {
                          setTurns(lead.id, (prev) => {
                            // Tira a pergunta que falhou e o erro; o envio abaixo coloca a pergunta de novo
                            const i = prev.findIndex((x) => x.id === t.id);
                            return [...prev.slice(0, Math.max(0, i - 1)), ...prev.slice(i + 1)];
                          });
                          send(t.retry.question, { draft: t.retry.draft, label: t.retry.label });
                        }}
                        className="mt-1 flex items-center gap-1 text-xs font-medium hover:underline disabled:opacity-50"
                      >
                        <RotateCcw className="size-3" /> Tentar de novo
                      </button>
                    </div>
                  </div>
                ),
              )}
              {pending && (
                <div className="flex">
                  <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-white px-3 py-3 shadow-sm ring-1 ring-slate-200" aria-label="Copiloto pensando">
                    {[0, 150, 300].map((d) => (
                      <span key={d} className="size-1.5 animate-bounce rounded-full bg-violet-400" style={{ animationDelay: `${d}ms` }} />
                    ))}
                  </div>
                </div>
              )}
              <div ref={chatEnd} />
            </div>
          )}
        </div>
      )}

      {/* Chat com o copiloto */}
      <div className="border-t border-slate-200 p-3">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(question);
          }}
        >
          <AutoTextarea
            className="input scroll-thin leading-snug"
            maxHeight={160}
            placeholder="Pergunte ao copiloto…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onFocus={() => setTab("chat")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(question);
              }
            }}
            disabled={!aiEnabled}
          />
          <Button type="submit" loading={pending} disabled={!aiEnabled || !question.trim() || ask.isPending} aria-label="Perguntar">
            <Send className="size-4" />
          </Button>
        </form>
        <button
          onClick={() => send(IMPROVE_DRAFT, { draft, label: "Melhorar meu rascunho" })}
          disabled={!aiEnabled || !draft.trim() || ask.isPending}
          className="mt-2 flex items-center gap-1 text-xs font-medium text-violet-700 hover:underline disabled:text-slate-400 disabled:no-underline"
        >
          <Wand2 className="size-3.5" /> Melhorar meu rascunho
        </button>
      </div>
    </div>
  );
}
