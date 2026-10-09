import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, Plus, QrCode, RefreshCw, Save, Trash2, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { PageHeader } from "../components/Layout";
import { Button, Field, Spinner, Toggle } from "../components/ui";
import { api, setToken } from "../lib/api";
import { useErrorToast, useMe, useRealtime, useSettings, useStages, useToast } from "../lib/app-state";
import type { Settings, Stage, User } from "../lib/types";

const TABS = [
  { id: "empresa", label: "Empresa (base da IA)" },
  { id: "bot", label: "Bot e Copiloto" },
  { id: "automacao", label: "Automação" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "n8n", label: "n8n e API" },
  { id: "funil", label: "Funil" },
  { id: "equipe", label: "Equipe" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function SettingsPage() {
  const [tab, setTab] = useState<TabId>("empresa");
  const q = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const [s, setS] = useState<Settings | null>(null);
  // Texto do campo de palavras de descadastro como a pessoa digita (vírgulas e espaços incluídos)
  const [kwText, setKwText] = useState<string | null>(null);

  useEffect(() => {
    if (q.data && !s) setS(q.data.settings);
  }, [q.data, s]);

  const save = useMutation({
    mutationFn: () => api<{ settings: Settings }>("/settings", { method: "PUT", body: s }),
    onSuccess: (r) => {
      setS(r.settings);
      setKwText(null);
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast({ kind: "success", text: "Configurações salvas." });
    },
    onError,
  });

  if (!q.data || !s) return <div className="grid h-full place-items-center"><Spinner /></div>;
  const sys = q.data.system;
  const dirty = JSON.stringify(s) !== JSON.stringify(q.data.settings);
  const up = <K extends keyof Settings>(k: K, patch: Partial<Settings[K]>) => setS({ ...s, [k]: { ...s[k], ...patch } });
  const showSave = ["empresa", "bot", "automacao", "n8n"].includes(tab);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Configurações"
        actions={
          showSave && (
            <Button icon={<Save className="size-4" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Salvar
            </Button>
          )
        }
      />
      <div className="scroll-thin flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-4 md:px-6">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`shrink-0 border-b-2 px-3 py-2.5 text-sm ${tab === t.id ? "border-brand-600 font-medium text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {tab === "empresa" && (
            <Card title="O que a IA sabe sobre sua empresa" desc="Tudo aqui é usado pelo bot, pelo copiloto e pelos follow-ups. Quanto mais completo, melhores as respostas.">
              <Field label="Nome da empresa">
                <input className="input" value={s.business.name} onChange={(e) => up("business", { name: e.target.value })} />
              </Field>
              <Field label="Sobre a empresa">
                <textarea className="input" rows={3} value={s.business.description} onChange={(e) => up("business", { description: e.target.value })} placeholder="O que vocês fazem, para quem, diferenciais, cidade/atendimento..." />
              </Field>
              <Field label="Produtos, serviços e preços">
                <textarea className="input" rows={5} value={s.business.products} onChange={(e) => up("business", { products: e.target.value })} placeholder={"Plano Básico — R$ 99/mês — ...\nPlano Pro — R$ 199/mês — ..."} />
              </Field>
              <Field label="Perguntas frequentes">
                <textarea className="input" rows={5} value={s.business.faq} onChange={(e) => up("business", { faq: e.target.value })} placeholder={"Vocês atendem aos sábados? Sim, das 9h às 13h.\nTem fidelidade? Não."} />
              </Field>
              <Field label="Tom de voz">
                <input className="input" value={s.business.tone} onChange={(e) => up("business", { tone: e.target.value })} />
              </Field>
              <Field label="Regras (o que a IA nunca deve fazer/prometer)">
                <textarea className="input" rows={3} value={s.business.rules} onChange={(e) => up("business", { rules: e.target.value })} placeholder="Não dar desconto acima de 10%. Não prometer prazo de entrega sem consultar." />
              </Field>
            </Card>
          )}

          {tab === "bot" && (
            <>
              <Card title="Bot de atendimento (IA responde sozinha)">
                <Toggle checked={s.bot.enabled} onChange={(v) => up("bot", { enabled: v })} label="Bot ligado" />
                <Field label="Conversas novas começam com">
                  <select className="input" value={s.bot.defaultMode} onChange={(e) => up("bot", { defaultMode: e.target.value as "bot" | "human" })}>
                    <option value="bot">IA respondendo (bot)</option>
                    <option value="human">Eu respondendo (IA só como copiloto)</option>
                  </select>
                </Field>
                <Field label="Esperar o lead terminar de digitar (segundos)" hint="Junta mensagens seguidas numa resposta só e deixa a conversa mais natural.">
                  <input type="number" min={0} max={120} className="input w-32" value={s.bot.replyDelaySeconds} onChange={(e) => up("bot", { replyDelaySeconds: Number(e.target.value) })} />
                </Field>
                <Field label="O que o bot deve descobrir (qualificação)">
                  <textarea className="input" rows={2} value={s.bot.qualificationGoals} onChange={(e) => up("bot", { qualificationGoals: e.target.value })} />
                </Field>
                <Field label="Quando passar para um humano">
                  <textarea className="input" rows={3} value={s.bot.handoffRules} onChange={(e) => up("bot", { handoffRules: e.target.value })} />
                </Field>
                <Toggle checked={s.bot.pauseOnPhoneReply} onChange={(v) => up("bot", { pauseOnPhoneReply: v })} label="Pausar a IA quando eu responder (pelo painel ou pelo celular)" />
              </Card>
              <Card title="Copiloto (direcionador de conversa)" desc="Quando você está conversando, a IA lê cada mensagem do lead e sugere caminhos. Ela nunca envia nada sozinha.">
                <Toggle checked={s.copilot.enabled} onChange={(v) => up("copilot", { enabled: v })} label="Copiloto ligado" />
                <Field label="Seu objetivo nas conversas">
                  <input className="input" value={s.copilot.goal} onChange={(e) => up("copilot", { goal: e.target.value })} />
                </Field>
              </Card>
              <Card title="Qualificação automática">
                <Toggle checked={s.ai.autoQualify} onChange={(v) => up("ai", { autoQualify: v })} label="A IA atualiza nota, temperatura, interesse e resumo a cada mensagem" />
                <Toggle checked={s.ai.autoMoveStage} onChange={(v) => up("ai", { autoMoveStage: v })} label="A IA pode avançar o lead no funil (nunca para Ganho/Perdido)" />
                <p className="text-xs text-slate-500">
                  Modelo: <code>{sys.aiModel || "IA desativada"}</code> (mude com a variável AI_MODEL)
                </p>
              </Card>
            </>
          )}

          {tab === "automacao" && (
            <>
              <Card title="Janela de envio" desc="Follow-ups e mensagens agendadas só saem neste horário. Respostas do bot a quem mandou mensagem saem a qualquer hora.">
                <Toggle checked={s.automation.sendWindowEnabled} onChange={(v) => up("automation", { sendWindowEnabled: v })} label="Respeitar janela de horário" />
                <div className="flex items-center gap-2 text-sm">
                  das
                  <input type="time" className="input w-auto" value={s.automation.sendWindowStart} onChange={(e) => up("automation", { sendWindowStart: e.target.value })} />
                  às
                  <input type="time" className="input w-auto" value={s.automation.sendWindowEnd} onChange={(e) => up("automation", { sendWindowEnd: e.target.value })} />
                  <span className="text-xs text-slate-500">({sys.timezone})</span>
                </div>
              </Card>
              <Card title="Descadastro (opt-out)" desc="Se o lead mandar exatamente uma destas palavras, ele para de receber mensagens automáticas. Isso protege seu número de bloqueios.">
                <Field label="Palavras (separadas por vírgula)">
                  <input
                    className="input"
                    value={kwText ?? s.automation.optOutKeywords.join(", ")}
                    onChange={(e) => {
                      setKwText(e.target.value);
                      up("automation", { optOutKeywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean) });
                    }}
                  />
                </Field>
                <Field label="Resposta de confirmação">
                  <input className="input" value={s.automation.optOutReply} onChange={(e) => up("automation", { optOutReply: e.target.value })} />
                </Field>
              </Card>
            </>
          )}

          {tab === "whatsapp" && <WhatsAppTab provider={sys.whatsappProvider} webhooks={sys.webhooks} />}

          {tab === "n8n" && (
            <>
              <Card title="Eventos do CRM → n8n" desc="O CRM avisa o n8n sobre lead novo, lead quente, transferência para humano, mensagens etc. Crie um nó Webhook no n8n e cole a URL aqui.">
                <Field label="URL do webhook do n8n" hint={sys.n8nWebhookFromEnv ? "Vazio = usa N8N_WEBHOOK_URL do .env" : undefined}>
                  <input className="input font-mono text-xs" placeholder="http://n8n:5678/webhook/crm-eventos" value={s.n8n.webhookUrl} onChange={(e) => up("n8n", { webhookUrl: e.target.value })} />
                </Field>
                <p className="text-xs text-slate-500">
                  Eventos: <code>lead.created</code>, <code>lead.stage_changed</code>, <code>lead.hot</code>, <code>lead.handoff</code>, <code>lead.opted_out</code>,{" "}
                  <code>message.received</code>, <code>message.sent</code>
                </p>
              </Card>
              <Card title="n8n → CRM (API)" desc="O n8n (ou seu site, Zapier, Make...) cria leads e envia mensagens pela API, usando o header x-api-key.">
                <p className="flex items-center gap-2 text-sm">
                  {sys.integrationApiEnabled ? <CheckCircle2 className="size-4 text-brand-600" /> : <XCircle className="size-4 text-red-600" />}
                  {sys.integrationApiEnabled ? "API ativa (chave definida em CRM_API_KEY)" : "Defina CRM_API_KEY no .env para ativar"}
                </p>
                <pre className="scroll-thin overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{`POST /api/integrations/leads          cria/atualiza lead (+ IA, boas-vindas, automação)
GET  /api/integrations/leads          filtros: stage, temperature, inactiveHours, unansweredHours
PATCH /api/integrations/leads/:id     muda etapa, etiquetas, campos
POST /api/integrations/leads/:id/messages   { "text": "..." } ou { "ai": true, "instruction": "..." }
POST /api/integrations/leads/:id/enroll     { "sequenceId": 1 }
POST /api/integrations/leads/:id/qualify    roda a qualificação com IA`}</pre>
                <p className="text-xs text-slate-500">Workflows prontos para importar estão na pasta <code>n8n/workflows</code> do projeto.</p>
              </Card>
            </>
          )}

          {tab === "funil" && <StagesTab />}
          {tab === "equipe" && <TeamTab />}
        </div>
      </div>
    </div>
  );
}

function Card({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="card space-y-3 p-5">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {desc && <p className="text-sm text-slate-500">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function CopyLine({ value }: { value: string }) {
  const toast = useToast();
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 truncate rounded-lg bg-slate-100 px-2 py-1.5 text-xs">{value}</code>
      <button
        className="rounded p-1.5 text-slate-500 hover:bg-slate-100"
        onClick={() => navigator.clipboard?.writeText(value).then(() => toast({ kind: "success", text: "Copiado!" }))}
        aria-label="Copiar"
      >
        <Copy className="size-4" />
      </button>
    </div>
  );
}

function WhatsAppTab({ provider, webhooks }: { provider: string; webhooks: { evolution: string; meta: string } }) {
  const onError = useErrorToast();
  const status = useQuery({
    queryKey: ["whatsapp-status"],
    queryFn: () => api<{ provider: string; connected: boolean; state: string; detail?: string }>("/whatsapp/status"),
    refetchInterval: (q) => (q.state.data?.connected ? 30_000 : 5_000),
  });
  const [qr, setQr] = useState<{ qrCode?: string; pairingCode?: string; message: string } | null>(null);
  const connect = useMutation({
    mutationFn: () => api<{ qrCode?: string; pairingCode?: string; message: string }>("/whatsapp/connect", { method: "POST" }),
    onSuccess: setQr,
    onError,
  });
  const disconnect = useMutation({
    mutationFn: () => api("/whatsapp/disconnect", { method: "POST" }),
    onSuccess: () => status.refetch(),
    onError,
  });
  useEffect(() => {
    if (status.data?.connected) setQr(null);
  }, [status.data?.connected]);

  // A Evolution manda o QR (e as renovações dele) por webhook → chega aqui em tempo real
  const { subscribe } = useRealtime();
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "whatsapp.qrcode" && e.data.base64) {
          setQr({ qrCode: e.data.base64, pairingCode: e.data.pairingCode, message: "Abra o WhatsApp no celular → Aparelhos conectados → Conectar aparelho, e escaneie o QR code." });
        }
        if (e.type === "whatsapp.connection") status.refetch();
      }),
    [subscribe, status],
  );

  const names: Record<string, string> = {
    simulator: "Simulador (teste)",
    evolution: "Evolution API (QR code)",
    meta: "API oficial da Meta (Cloud API)",
  };

  return (
    <>
      <Card title="Conexão">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm">
              Provedor: <b>{names[provider] ?? provider}</b>
            </p>
            <p className="flex items-center gap-1.5 text-sm">
              {status.isLoading ? (
                <Spinner className="size-4" />
              ) : status.data?.connected ? (
                <>
                  <CheckCircle2 className="size-4 text-brand-600" /> Conectado
                </>
              ) : (
                <>
                  <XCircle className="size-4 text-red-600" /> Desconectado ({status.data?.state})
                </>
              )}
            </p>
            {status.data?.detail && <p className="text-xs text-slate-500">{status.data.detail}</p>}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => status.refetch()}>
              Atualizar
            </Button>
            {provider === "evolution" && !status.data?.connected && (
              <Button size="sm" icon={<QrCode className="size-4" />} loading={connect.isPending} onClick={() => connect.mutate()}>
                Conectar (QR code)
              </Button>
            )}
            {provider === "evolution" && status.data?.connected && (
              <Button variant="secondary" size="sm" loading={disconnect.isPending} onClick={() => confirm("Desconectar o WhatsApp?") && disconnect.mutate()}>
                Desconectar
              </Button>
            )}
          </div>
        </div>
        {qr && (
          <div className="rounded-lg bg-slate-50 p-4 text-center">
            {qr.qrCode && <img src={qr.qrCode} alt="QR code do WhatsApp" className="mx-auto size-64 rounded bg-white p-2" />}
            {qr.pairingCode && (
              <p className="mt-2 text-sm">
                Ou use o código: <b className="font-mono">{qr.pairingCode}</b>
              </p>
            )}
            {!qr.qrCode && <Spinner className="mx-auto" />}
            <p className="mt-2 text-sm text-slate-600">{qr.message}</p>
            {qr.qrCode && (
              <Button variant="ghost" size="sm" className="mt-1" onClick={() => connect.mutate()}>
                Gerar novo QR
              </Button>
            )}
          </div>
        )}
      </Card>
      <Card title="Como trocar de provedor" desc="Escolha no arquivo .env com WHATSAPP_PROVIDER e reinicie o CRM.">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>
            <b>evolution</b> — conecta qualquer WhatsApp (inclusive Business do celular) lendo um QR code. Já vem no docker-compose.
          </li>
          <li>
            <b>meta</b> — API oficial (WhatsApp Business Platform). Mais estável, mas exige conta na Meta e templates para mensagens fora da
            janela de 24h.
          </li>
          <li>
            <b>simulator</b> — nada sai de verdade; use para testar.
          </li>
        </ul>
        <p className="label mt-2">Webhook da Evolution (configurado automaticamente ao conectar)</p>
        <CopyLine value={webhooks.evolution} />
        <p className="label">Webhook da Meta (cole no painel de desenvolvedores da Meta)</p>
        <CopyLine value={webhooks.meta} />
      </Card>
    </>
  );
}

function StagesTab() {
  const qc = useQueryClient();
  const onError = useErrorToast();
  const stages = useStages();
  const [name, setName] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["stages"] });
  const create = useMutation({ mutationFn: () => api("/stages", { body: { name } }), onSuccess: () => (setName(""), refresh()), onError });
  const update = useMutation({
    mutationFn: ({ id, ...body }: Partial<Stage> & { id: number }) => api(`/stages/${id}`, { method: "PATCH", body }),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({ mutationFn: (id: number) => api(`/stages/${id}`, { method: "DELETE" }), onSuccess: refresh, onError });

  return (
    <Card title="Etapas do funil" desc="Ganho e Perdido contam para a taxa de conversão.">
      <ul className="space-y-2">
        {stages.data?.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2">
            <input type="color" value={s.color} onChange={(e) => update.mutate({ id: s.id, color: e.target.value })} className="h-8 w-10 cursor-pointer rounded border border-slate-300" aria-label="Cor" />
            <input className="input w-48 flex-1" defaultValue={s.name} onBlur={(e) => e.target.value !== s.name && update.mutate({ id: s.id, name: e.target.value })} />
            <input
              type="number"
              className="input w-20"
              defaultValue={s.position}
              title="Ordem"
              onBlur={(e) => Number(e.target.value) !== s.position && update.mutate({ id: s.id, position: Number(e.target.value) })}
            />
            <select className="input w-auto" value={s.kind} onChange={(e) => update.mutate({ id: s.id, kind: e.target.value as Stage["kind"] })}>
              <option value="open">Aberta</option>
              <option value="won">Ganho</option>
              <option value="lost">Perdido</option>
            </select>
            <button className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => remove.mutate(s.id)} aria-label="Excluir etapa">
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <input className="input" placeholder="Nova etapa" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="secondary" icon={<Plus className="size-4" />}>
          Adicionar
        </Button>
      </form>
    </Card>
  );
}

function TeamTab() {
  const qc = useQueryClient();
  const onError = useErrorToast();
  const toast = useToast();
  const me = useMe();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/users") });
  const [f, setF] = useState({ name: "", email: "", password: "", role: "agent" });
  const [pwd, setPwd] = useState({ current: "", next: "" });
  const create = useMutation({
    mutationFn: () => api("/users", { body: f }),
    onSuccess: () => {
      setF({ name: "", email: "", password: "", role: "agent" });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/users/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
    onError,
  });
  const change = useMutation({
    mutationFn: () => api<{ ok: boolean; token: string }>("/auth/password", { body: pwd }),
    onSuccess: (res) => {
      // A troca de senha derruba os logins antigos; esta sessão continua com o token novo
      setToken(res.token);
      setPwd({ current: "", next: "" });
      toast({ kind: "success", text: "Senha alterada." });
    },
    onError,
  });

  return (
    <>
      <Card title="Usuários">
        <ul className="divide-y divide-slate-100">
          {users.data?.map((u) => (
            <li key={u.id} className="flex items-center justify-between py-2 text-sm">
              <div>
                <p className="font-medium">{u.name}</p>
                <p className="text-xs text-slate-500">
                  {u.email} · {u.role === "admin" ? "Administrador" : "Vendedor"}
                </p>
              </div>
              {me.data?.role === "admin" && me.data.id !== u.id && (
                <button className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => remove.mutate(u.id)} aria-label="Remover usuário">
                  <Trash2 className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
        {me.data?.role === "admin" && (
          <form
            className="grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <input className="input" placeholder="Nome" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
            <input className="input" type="email" placeholder="E-mail" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
            <input className="input" type="password" placeholder="Senha (mín. 6)" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
            <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="agent">Vendedor</option>
              <option value="admin">Administrador</option>
            </select>
            <Button type="submit" loading={create.isPending} className="sm:col-span-2" icon={<Plus className="size-4" />}>
              Adicionar usuário
            </Button>
          </form>
        )}
      </Card>
      <Card title="Trocar minha senha">
        <form
          className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate();
          }}
        >
          <input className="input" type="password" placeholder="Senha atual" value={pwd.current} onChange={(e) => setPwd({ ...pwd, current: e.target.value })} required />
          <input className="input" type="password" placeholder="Nova senha" value={pwd.next} onChange={(e) => setPwd({ ...pwd, next: e.target.value })} required minLength={6} />
          <Button type="submit" loading={change.isPending}>
            Trocar
          </Button>
        </form>
      </Card>
    </>
  );
}
