import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useErrorToast, useToast } from "../lib/app-state";
import type { Playbook } from "../lib/types";
import { AutoTextarea } from "./AutoTextarea";
import { Button } from "./ui";

export interface PlaybookDraft {
  name: string;
  goal: string;
  offer: string;
  instructions: string;
  handoffRules: string;
  firstMessage: string;
}

interface AssistantResponse {
  reply: string;
  draft: PlaybookDraft;
  done: boolean;
  provider: "claude-code" | "ai";
}

type Turn =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; text: string }
  | { id: number; role: "error"; text: string; retry: string };

const EMPTY: PlaybookDraft = { name: "", goal: "", offer: "", instructions: "", handoffRules: "", firstMessage: "" };

const FIELDS: Array<{ key: keyof PlaybookDraft; label: string; hint?: string }> = [
  { key: "name", label: "Nome" },
  { key: "goal", label: "Objetivo da conversa" },
  { key: "offer", label: "O que você oferece" },
  { key: "instructions", label: "Como a IA deve conduzir" },
  { key: "handoffRules", label: "Quando passar para você" },
  { key: "firstMessage", label: "Primeira mensagem", hint: "{nome}, {primeiro_nome}, {empresa}" },
];

const STARTERS = [
  "Quero oferecer meu app para eletricistas",
  "Quero vender meu serviço para dentistas da minha cidade",
  "Quero reativar clientes que sumiram",
];

const fromPlaybook = (p: Playbook | null): PlaybookDraft =>
  p
    ? { name: p.name, goal: p.goal, offer: p.offer, instructions: p.instructions, handoffRules: p.handoffRules, firstMessage: p.firstMessage }
    : EMPTY;

let nextId = 1;

/**
 * Chat com o Claude (assinatura, como a prospecção) que monta ou ajusta um roteiro.
 * A conversa vai inteira a cada pergunta; o rascunho ao lado é editável e também vai junto.
 */
export function PlaybookAssistant({
  playbook,
  onClose,
  onSaved,
}: {
  playbook: Playbook | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const onError = useErrorToast();
  const greeting = playbook
    ? `O que você quer mudar no roteiro “${playbook.name}”? Pode ser o tom, a primeira mensagem, como responder uma objeção…`
    : "Oi! Me conta o que você quer vender e para quem (ex.: “meu app de orçamentos para eletricistas”). Eu monto o roteiro e vou ajustando com você.";
  const [turns, setTurns] = useState<Turn[]>([{ id: nextId++, role: "assistant", text: greeting }]);
  const [draft, setDraft] = useState<PlaybookDraft>(() => fromPlaybook(playbook));
  const [changed, setChanged] = useState<Set<keyof PlaybookDraft>>(new Set());
  const [done, setDone] = useState(false);
  const [input, setInput] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const chatEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initial = useRef(fromPlaybook(playbook));

  const ask = useMutation({
    mutationFn: ({ history, draft }: { history: Turn[]; draft: PlaybookDraft }) =>
      api<AssistantResponse>("/playbooks/assistant", {
        body: {
          messages: history
            .filter((t) => t.role !== "error")
            .map((t) => ({ role: t.role, content: t.text })),
          draft,
          ...(playbook ? { playbookId: playbook.id } : {}),
        },
      }),
    onSuccess: (res, { draft: sent }) => {
      const diff = new Set<keyof PlaybookDraft>();
      for (const f of FIELDS) if ((res.draft[f.key] ?? "") !== sent[f.key]) diff.add(f.key);
      setDraft({ ...EMPTY, ...res.draft });
      setChanged(diff);
      setDone(res.done);
      setTurns((prev) => [...prev, { id: nextId++, role: "assistant", text: res.reply }]);
    },
    onError: (err, { history }) => {
      const last = history[history.length - 1];
      setTurns((prev) => [
        ...prev,
        { id: nextId++, role: "error", text: err instanceof Error ? err.message : String(err), retry: last?.text ?? "" },
      ]);
    },
  });

  const save = useMutation({
    mutationFn: () => {
      const body = Object.fromEntries(FIELDS.map((f) => [f.key, draft[f.key].trim()]));
      return playbook
        ? api<Playbook>(`/playbooks/${playbook.id}`, { method: "PATCH", body })
        : api<Playbook>("/playbooks", { body });
    },
    onSuccess: () => {
      toast({ kind: "success", text: playbook ? "Roteiro atualizado." : "Roteiro criado." });
      onSaved();
    },
    onError,
  });

  const send = (text: string, base = turns) => {
    const t = text.trim();
    if (!t || ask.isPending) return;
    const history: Turn[] = [...base, { id: nextId++, role: "user", text: t }];
    setTurns(history);
    setInput("");
    ask.mutate({ history, draft });
  };

  // Rola o chat para o fim e conta o tempo da resposta (o Claude pode levar quase 1 min)
  useEffect(() => chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [turns, ask.isPending]);
  useEffect(() => {
    if (!ask.isPending) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [ask.isPending]);
  useEffect(() => inputRef.current?.focus(), []);

  const dirty = FIELDS.some((f) => draft[f.key] !== initial.current[f.key]);
  const requestClose = () => (dirty && !save.isSuccess ? setConfirmClose(true) : onClose());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && requestClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const userTurns = turns.filter((t) => t.role === "user").length;
  const filled = FIELDS.filter((f) => draft[f.key].trim()).length;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-slate-900/40 p-0 sm:p-4" onMouseDown={requestClose}>
      <div
        className="card flex h-full w-full max-w-6xl flex-col overflow-hidden p-0 sm:h-[90vh]"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Assistente de roteiros"
      >
        {/* Cabeçalho */}
        <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-3">
          <span className="grid size-8 place-items-center rounded-lg bg-violet-100 text-violet-600">
            <Sparkles className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold">{playbook ? `Ajustar “${playbook.name}” com IA` : "Criar roteiro com IA"}</h2>
            <p className="text-xs text-slate-500">Converse com o Claude: ele monta o roteiro ao lado e você revisa antes de salvar.</p>
          </div>
          <button onClick={requestClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Fechar">
            <X className="size-5" />
          </button>
        </div>

        {confirmClose && (
          <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-sm text-amber-800">
            <span className="flex-1">O rascunho ainda não foi salvo. Fechar e perder as mudanças?</span>
            <Button size="sm" variant="secondary" onClick={() => setConfirmClose(false)}>
              Continuar editando
            </Button>
            <Button size="sm" variant="danger" onClick={onClose}>
              Descartar
            </Button>
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:grid-rows-1">
          {/* Chat */}
          <section className="flex min-h-0 flex-col border-b border-slate-200 bg-slate-50 md:border-r md:border-b-0">
            <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {turns.map((t) =>
                t.role === "user" ? (
                  <div key={t.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-violet-600 px-3 py-2 text-sm whitespace-pre-wrap text-white shadow-sm">
                      {t.text}
                    </div>
                  </div>
                ) : t.role === "assistant" ? (
                  <div key={t.id} className="flex">
                    <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-white px-3 py-2 text-sm whitespace-pre-wrap text-slate-700 shadow-sm ring-1 ring-slate-200">
                      {t.text}
                    </div>
                  </div>
                ) : (
                  <div key={t.id} className="flex">
                    <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
                      <p>{t.text}</p>
                      <button
                        disabled={ask.isPending}
                        onClick={() => {
                          // Tira a pergunta que falhou e o erro; o envio coloca a pergunta de novo
                          const i = turns.findIndex((x) => x.id === t.id);
                          send(t.retry, turns.slice(0, Math.max(0, i - 1)));
                        }}
                        className="mt-1 flex items-center gap-1 text-xs font-medium hover:underline disabled:opacity-50"
                      >
                        <RotateCcw className="size-3" /> Tentar de novo
                      </button>
                    </div>
                  </div>
                ),
              )}
              {ask.isPending && (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-white px-3 py-3 shadow-sm ring-1 ring-slate-200" aria-label="Claude pensando">
                    {[0, 150, 300].map((d) => (
                      <span key={d} className="size-1.5 animate-bounce rounded-full bg-violet-400" style={{ animationDelay: `${d}ms` }} />
                    ))}
                  </div>
                  <span className="text-xs text-slate-400">
                    {elapsed < 8 ? "Pensando…" : `Montando o roteiro… ${elapsed}s (pode levar até 1 min)`}
                  </span>
                </div>
              )}
              {userTurns === 0 && !playbook && !ask.isPending && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="rounded-full bg-white px-3 py-1.5 text-xs text-violet-700 ring-1 ring-violet-200 transition hover:bg-violet-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            <form
              className="flex items-end gap-2 border-t border-slate-200 bg-white p-3"
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
            >
              <AutoTextarea
                ref={inputRef}
                className="input scroll-thin min-h-[42px] leading-snug"
                maxHeight={180}
                placeholder={userTurns === 0 ? "Descreva o produto, o público e o objetivo…" : "Responda ou peça uma mudança…"}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
              />
              <Button type="submit" disabled={!input.trim()} loading={ask.isPending} icon={<Send className="size-4" />} aria-label="Enviar" />
            </form>
          </section>

          {/* Rascunho */}
          <section className="flex min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-2.5">
              <h3 className="text-sm font-semibold text-slate-800">Rascunho do roteiro</h3>
              <span className="text-xs text-slate-400">{filled}/6 campos</span>
              {done && (
                <span className="ml-auto flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
                  <CheckCircle2 className="size-3.5" /> Pronto para salvar
                </span>
              )}
            </div>
            <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-600">
                    {f.label}
                    {f.hint && <span className="font-normal text-slate-400">{f.hint}</span>}
                    {changed.has(f.key) && (
                      <span className="rounded bg-violet-100 px-1.5 py-px text-[10px] font-semibold tracking-wide text-violet-700 uppercase">
                        atualizado
                      </span>
                    )}
                  </span>
                  {f.key === "name" ? (
                    <input
                      className={`input ${changed.has(f.key) ? "ring-2 ring-violet-200" : ""}`}
                      maxLength={80}
                      placeholder="Ex.: OrcaEasy – eletricistas"
                      value={draft.name}
                      readOnly={ask.isPending}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  ) : (
                    <AutoTextarea
                      className={`input scroll-thin leading-snug ${changed.has(f.key) ? "ring-2 ring-violet-200" : ""} ${
                        f.key === "firstMessage" ? "bg-[#f3fdf1]" : ""
                      }`}
                      maxHeight={f.key === "instructions" ? 360 : 220}
                      placeholder="O assistente preenche isto conforme vocês conversam."
                      value={draft[f.key]}
                      readOnly={ask.isPending}
                      onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    />
                  )}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
              {!draft.name.trim() && <span className="mr-auto text-xs text-slate-400">Dê um nome ao roteiro para salvar.</span>}
              <Button variant="secondary" onClick={requestClose}>
                Cancelar
              </Button>
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!draft.name.trim() || ask.isPending}>
                {playbook ? "Salvar alterações" : "Criar roteiro"}
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
