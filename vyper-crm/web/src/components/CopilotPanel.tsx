import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Compass,
  HelpCircle,
  Lightbulb,
  RefreshCw,
  Send,
  Sparkles,
  ThumbsUp,
  Wand2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useErrorToast } from "../lib/app-state";
import { formatDateTime } from "../lib/format";
import type { CopilotResponse, Lead } from "../lib/types";
import { Button, Spinner } from "./ui";

const SENTIMENT = {
  positivo: "bg-emerald-50 text-emerald-700",
  neutro: "bg-slate-100 text-slate-700",
  negativo: "bg-red-50 text-red-700",
};

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

/**
 * Copiloto / direcionador de conversa.
 * Só sugere: "Usar no rascunho" coloca o texto na sua caixa de mensagem para você editar e enviar.
 */
export function CopilotPanel({ lead, onUseDraft, draft }: { lead: Lead; onUseDraft: (text: string) => void; draft: string }) {
  const qc = useQueryClient();
  const onError = useErrorToast();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ answer: string; suggestedMessage: string } | null>(null);

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
    mutationFn: (body: { question: string; draft?: string }) =>
      api<{ answer: string; suggestedMessage: string }>(`/leads/${lead.id}/copilot/ask`, { body }),
    onSuccess: setAnswer,
    onError,
  });

  const data = q.data?.insight?.data;
  const aiEnabled = q.data?.aiEnabled ?? true;

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <h3 className="flex items-center gap-1.5 font-semibold">
            <Compass className="size-4 text-violet-600" /> Copiloto
          </h3>
          <p className="text-xs text-slate-500">Sugere caminhos — quem envia é você</p>
        </div>
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
      </div>

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
                    <button
                      onClick={() => onUseDraft(p.message)}
                      className="mt-2 text-xs font-medium text-brand-700 hover:underline"
                    >
                      Usar no rascunho →
                    </button>
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

      {/* Pergunta livre ao copiloto */}
      <div className="border-t border-slate-200 p-3">
        {answer && (
          <div className="scroll-thin mb-2 max-h-56 overflow-y-auto rounded-lg bg-slate-50 p-3 text-sm">
            <p className="whitespace-pre-wrap text-slate-700">{answer.answer}</p>
            {answer.suggestedMessage && (
              <>
                <p className="mt-2 rounded-lg bg-[#d9fdd3] px-3 py-2 whitespace-pre-wrap">{answer.suggestedMessage}</p>
                <button onClick={() => onUseDraft(answer.suggestedMessage)} className="mt-1 text-xs font-medium text-brand-700 hover:underline">
                  Usar no rascunho →
                </button>
              </>
            )}
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim()) ask.mutate({ question, draft: draft || undefined });
          }}
        >
          <input
            className="input"
            placeholder="Pergunte: como respondo se ele achar caro?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={!aiEnabled}
          />
          <Button type="submit" size="sm" loading={ask.isPending} disabled={!aiEnabled || !question.trim()} aria-label="Perguntar">
            <Send className="size-4" />
          </Button>
        </form>
        <button
          onClick={() =>
            ask.mutate({
              question: "Melhore meu rascunho para conduzir melhor a conversa, mantendo minha intenção e o tom da empresa.",
              draft,
            })
          }
          disabled={!aiEnabled || !draft.trim() || ask.isPending}
          className="mt-2 flex items-center gap-1 text-xs font-medium text-violet-700 hover:underline disabled:text-slate-400 disabled:no-underline"
        >
          <Wand2 className="size-3.5" /> Melhorar meu rascunho
        </button>
      </div>
    </div>
  );
}
