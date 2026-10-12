import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, Plus, QrCode, RefreshCw, Save, Sparkles, Trash2, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { PageHeader } from "../components/Layout";
import { Badge, Button, Empty, Field, Modal, Spinner, Toggle } from "../components/ui";
import { api, setToken } from "../lib/api";
import { useErrorToast, useMe, useRealtime, useSettings, useStages, useToast } from "../lib/app-state";
import type { Playbook, Settings, SettingsResponse, Stage, User } from "../lib/types";

const TABS = [
  { id: "empresa", label: "Empresa (base da IA)" },
  { id: "bot", label: "Bot e Copiloto" },
  { id: "roteiros", label: "Roteiros" },
  { id: "automacao", label: "Automação" },
  { id: "amostras", label: "Amostras (Claude)" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "n8n", label: "n8n e API" },
  { id: "funil", label: "Funil" },
  { id: "equipe", label: "Equipe" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const AI_PROVIDER_LABEL: Record<SettingsResponse["system"]["aiProvider"], string> = {
  "claude-code": "Claude Code (sua assinatura)",
  anthropic: "Claude (API da Anthropic)",
  openrouter: "OpenRouter",
  none: "IA desativada",
};

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
    if (q.data && !s) {
      setS({
        ...q.data.settings,
        notify: q.data.settings.notify ?? { handoffEnabled: false, handoffPhone: "" },
      });
    }
  }, [q.data, s]);

  const save = useMutation({
    mutationFn: () => api<{ settings: Settings }>("/settings", { method: "PUT", body: s }),
    onSuccess: (r) => {
      setS({
        ...r.settings,
        notify: r.settings.notify ?? { handoffEnabled: false, handoffPhone: "" },
      });
      setKwText(null);
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast({ kind: "success", text: "Configurações salvas." });
    },
    onError,
  });

  const testNotify = useMutation({
    mutationFn: async () => {
      if (dirty) {
        await api<{ settings: Settings }>("/settings", { method: "PUT", body: s });
        qc.invalidateQueries({ queryKey: ["settings"] });
      }
      return api<{ ok: boolean }>("/settings/notify/test", { method: "POST" });
    },
    onSuccess: () => {
      toast({ kind: "success", text: "Mensagem de teste de aviso enviada!" });
    },
    onError,
  });

  if (!q.data || !s) return <div className="grid h-full place-items-center"><Spinner /></div>;
  const sys = q.data.system;
  const dirty = JSON.stringify(s) !== JSON.stringify(q.data.settings);
  const up = <K extends keyof Settings>(k: K, patch: Partial<Settings[K]>) =>
    setS({ ...s, [k]: { ...((s[k] ?? {}) as any), ...patch } });
  const showSave = ["empresa", "bot", "automacao", "amostras", "n8n"].includes(tab);

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
                  IA do dia a dia (bot, qualificação, copiloto e follow-ups):{" "}
                  <strong className="font-medium text-slate-700">{AI_PROVIDER_LABEL[sys.aiProvider] ?? AI_PROVIDER_LABEL.none}</strong>
                  {sys.aiModel && (
                    <>
                      {" "}— modelo <code>{sys.aiModel}</code>
                    </>
                  )}
                  . Mude no .env: AI_PROVIDER e OPENROUTER_MODEL (recomendado: OpenRouter) ou AI_MODEL para o Claude (API).
                </p>
                <p className="text-xs text-slate-500">
                  Claude Code (sua assinatura), só para prospecção e amostras:{" "}
                  {sys.claudeCode?.enabled ? (
                    <>
                      ligado{sys.claudeCode.model && <> — <code>{sys.claudeCode.model}</code></>}.
                    </>
                  ) : (
                    <>
                      desligado — defina <code>CLAUDE_CODE_ENABLED=true</code> no .env.
                    </>
                  )}{" "}
                  Pesquisa na web (prospecção): {sys.aiResearch ? "disponível." : "indisponível."}
                </p>
              </Card>
              <Card
                title="Aviso quando a IA passar para você"
                desc="Notificação enviada direto no seu WhatsApp quando a IA transferir um atendimento para um humano."
              >
                <Toggle
                  checked={s.notify.handoffEnabled}
                  onChange={(v) => up("notify", { handoffEnabled: v })}
                  label="Avisar no meu WhatsApp quando a IA passar um lead"
                />
                <Field
                  label="Telefone para receber o aviso"
                  hint="Apenas dígitos com DDD e DDI (ex.: 5511999998888). Este número nunca virará lead no CRM."
                >
                  <div className="flex gap-2">
                    <input
                      className="input flex-1"
                      placeholder="5511999998888"
                      value={s.notify.handoffPhone}
                      onChange={(e) => up("notify", { handoffPhone: e.target.value })}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      loading={testNotify.isPending}
                      disabled={!s.notify.handoffPhone.trim()}
                      onClick={() => testNotify.mutate()}
                    >
                      Enviar teste
                    </Button>
                  </div>
                </Field>
              </Card>
            </>
          )}

          {tab === "roteiros" && <PlaybooksTab />}

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

          {tab === "amostras" && <SamplesTab s={s.samples} sys={sys} onChange={(patch) => up("samples", patch)} />}

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

function StatusLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-brand-600" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-slate-400" />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function SamplesTab({
  s,
  sys,
  onChange,
}: {
  s: Settings["samples"];
  sys: SettingsResponse["system"];
  onChange: (patch: Partial<Settings["samples"]>) => void;
}) {
  const claude = sys.claudeCode?.enabled ?? false;
  return (
    <>
      <Card
        title="Amostras com Claude"
        desc="Quando um lead esquenta, o Claude cria uma amostra do que você entregaria para ele — um site demo (com link) ou uma arte (imagem). Ela aparece na conversa para você revisar e enviar com 1 clique: nada sai sem você."
      >
        <StatusLine ok={claude}>
          {claude ? (
            <>
              Claude Code ligado{sys.claudeCode.model && <> — modelo <code>{sys.claudeCode.model}</code></>}. Cada amostra leva alguns minutos e
              usa o limite da sua assinatura.
            </>
          ) : (
            <>
              <span className="font-medium">Claude Code desligado.</span>{" "}
              <span className="text-slate-500">
                Defina <code>CLAUDE_CODE_ENABLED=true</code> no .env e reinicie o CRM (no computador, faça login com <code>claude</code> e /login; no
                Docker, gere um token com <code>claude setup-token</code> e coloque em <code>CLAUDE_CODE_OAUTH_TOKEN</code>).
              </span>
            </>
          )}
        </StatusLine>
        <StatusLine ok={sys.publisher === "netlify"}>
          {sys.publisher === "netlify" ? (
            "Netlify conectado: os sites demo são publicados num link próprio (fora do Google)."
          ) : (
            <>
              <span className="font-medium">Netlify não configurado.</span>{" "}
              <span className="text-slate-500">
                Crie um token em app.netlify.com/user/applications (Personal access tokens) e coloque em <code>NETLIFY_AUTH_TOKEN</code> no .env.
                Sem ele, as artes funcionam, mas o link do site demo não pode ser enviado.
              </span>
            </>
          )}
        </StatusLine>
      </Card>
      <Card title="Quando criar">
        <Toggle checked={s.autoGenerate} onChange={(v) => onChange({ autoGenerate: v })} label="Criar a amostra sozinho (você só revisa e envia)" />
        <div className={`space-y-2 border-l-2 border-slate-100 pl-4 ${s.autoGenerate ? "" : "pointer-events-none opacity-50"}`}>
          <Toggle checked={s.onHot} onChange={(v) => onChange({ onHot: v })} label="Quando a IA marcar o lead como quente" />
          <Toggle checked={s.onHandoff} onChange={(v) => onChange({ onHandoff: v })} label="Quando a IA passar a conversa para você" />
        </div>
        <p className="text-xs text-slate-500">
          Só uma amostra automática por lead, e nunca para quem pediu para sair. Na conversa, o botão <Sparkles className="inline size-3.5 text-violet-600" /> ao lado da caixa de mensagem cria uma quando você quiser.
        </p>
      </Card>
      <Card title="Como criar">
        <Field label="Tipo padrão">
          <select className="input" value={s.defaultKind} onChange={(e) => onChange({ defaultKind: e.target.value as Settings["samples"]["defaultKind"] })}>
            <option value="site">Site demo (link publicado no Netlify)</option>
            <option value="image">Arte (imagem enviada pelo WhatsApp)</option>
          </select>
        </Field>
        <Field
          label="Orientações para o Claude"
          hint="Valem para todas as amostras, junto com os dados da aba Empresa e a conversa com o lead."
        >
          <textarea
            className="input"
            rows={4}
            value={s.instructions}
            onChange={(e) => onChange({ instructions: e.target.value })}
            placeholder={"Ex.: visual moderno e minimalista; sempre um botão de WhatsApp em destaque;\nartes no formato de post do Instagram, com pouco texto."}
          />
        </Field>
      </Card>
    </>
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

function PlaybooksTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const playbooks = useQuery({
    queryKey: ["playbooks"],
    queryFn: () => api<Playbook[]>("/playbooks"),
  });
  const [editing, setEditing] = useState<Playbook | "new" | null>(null);
  const [deleting, setDeleting] = useState<Playbook | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["playbooks"] });
    qc.invalidateQueries({ queryKey: ["leads"] });
  };

  const deleteMut = useMutation({
    mutationFn: (id: number) => api<{ ok: boolean }>(`/playbooks/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      refresh();
      setDeleting(null);
      toast({ kind: "success", text: "Roteiro excluído." });
    },
    onError,
  });

  return (
    <>
      <Card
        title="Roteiros de atendimento (Playbooks)"
        desc="Presets com objetivo, oferta e instruções específicas para grupos de leads (ex.: eletricistas, advogados, dentistas)."
      >
        <div className="flex items-center justify-between pb-1">
          <p className="text-xs text-slate-500">
            {playbooks.data ? `${playbooks.data.length} roteiro(s) cadastrado(s)` : "Carregando..."}
          </p>
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
            Novo roteiro
          </Button>
        </div>

        {playbooks.isLoading && <Spinner className="m-4" />}
        {playbooks.data?.length === 0 && (
          <Empty title="Nenhum roteiro cadastrado">
            Crie roteiros para conduzir as conversas da IA com abordagens específicas (ex.: nichos, produtos ou campanhas).
          </Empty>
        )}

        <div className="space-y-3">
          {playbooks.data?.map((p) => (
            <div
              key={p.id}
              className="rounded-lg border border-slate-200 bg-white p-4 transition hover:border-slate-300"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-slate-900">{p.name}</h3>
                    <Badge className="bg-violet-50 text-violet-700 ring-1 ring-violet-200">
                      {p.leadCount} lead(s)
                    </Badge>
                  </div>
                  {p.goal && (
                    <p className="mt-1 text-sm text-slate-600">
                      <span className="font-medium text-slate-700">Objetivo:</span> {p.goal}
                    </p>
                  )}
                  {p.offer && (
                    <p className="mt-0.5 text-xs text-slate-500 line-clamp-2">
                      <span className="font-medium text-slate-600">Oferta:</span> {p.offer}
                    </p>
                  )}
                  {p.firstMessage && (
                    <p className="mt-1 text-xs text-slate-400 italic line-clamp-1">
                      1ª mensagem: “{p.firstMessage}”
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="secondary" size="sm" onClick={() => setEditing(p)}>
                    Editar
                  </Button>
                  <button
                    className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 transition"
                    onClick={() => setDeleting(p)}
                    aria-label={`Excluir roteiro ${p.name}`}
                    title="Excluir roteiro"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {editing && (
        <PlaybookModal
          open={Boolean(editing)}
          playbook={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            refresh();
            setEditing(null);
          }}
        />
      )}

      {deleting && (
        <Modal open={Boolean(deleting)} onClose={() => setDeleting(null)} title="Excluir roteiro">
          <p className="text-sm text-slate-600">
            Tem certeza que deseja excluir o roteiro <strong className="font-semibold text-slate-900">{deleting.name}</strong>?
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Os {deleting.leadCount} lead(s) associados a este roteiro continuarão existindo no CRM, mas ficarão sem roteiro.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              loading={deleteMut.isPending}
              onClick={() => deleteMut.mutate(deleting.id)}
            >
              Excluir roteiro
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function PlaybookModal({
  open,
  playbook,
  onClose,
  onSaved,
}: {
  open: boolean;
  playbook: Playbook | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const onError = useErrorToast();
  const [f, setF] = useState({
    name: playbook?.name ?? "",
    goal: playbook?.goal ?? "",
    offer: playbook?.offer ?? "",
    instructions: playbook?.instructions ?? "",
    handoffRules: playbook?.handoffRules ?? "",
    firstMessage: playbook?.firstMessage ?? "",
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(),
        goal: f.goal.trim(),
        offer: f.offer.trim(),
        instructions: f.instructions.trim(),
        handoffRules: f.handoffRules.trim(),
        firstMessage: f.firstMessage.trim(),
      };
      if (playbook) {
        return api<Playbook>(`/playbooks/${playbook.id}`, { method: "PATCH", body });
      }
      return api<Playbook>("/playbooks", { body });
    },
    onSuccess: () => {
      toast({ kind: "success", text: playbook ? "Roteiro atualizado." : "Roteiro criado com sucesso." });
      onSaved();
    },
    onError,
  });

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  return (
    <Modal open={open} onClose={onClose} title={playbook ? "Editar roteiro" : "Novo roteiro"} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (f.name.trim()) save.mutate();
        }}
      >
        <Field label="Nome do roteiro *" hint="Identificação rápida (máx. 80 caracteres)">
          <input
            className="input"
            maxLength={80}
            placeholder="Ex.: Eletricistas — OrcaEasy"
            value={f.name}
            onChange={set("name")}
            required
            autoFocus
          />
        </Field>

        <Field label="Objetivo da conversa" hint="O que a IA deve conseguir nesta conversa">
          <textarea
            className="input"
            rows={2}
            placeholder="Ex.: Fazer o eletricista criar conta grátis no OrcaEasy (orcaeasy.com) e testar o envio de orçamento pelo WhatsApp."
            value={f.goal}
            onChange={set("goal")}
          />
        </Field>

        <Field label="O que você oferece" hint="Benefícios do produto/serviço, preços, diferenciais e links">
          <textarea
            className="input"
            rows={3}
            placeholder="Ex.: Aplicativo OrcaEasy (orcaeasy.com) para eletricistas montarem e enviarem orçamentos em PDF no WhatsApp em 2 minutos. Plano grátis para começar."
            value={f.offer}
            onChange={set("offer")}
          />
        </Field>

        <Field
          label="Como a IA deve conduzir (instruções)"
          hint="Tom de voz, perguntas de abertura, objeções comuns e respostas, argumentos"
        >
          <textarea
            className="input"
            rows={7}
            placeholder={`Ex.: Conduza a conversa de forma direta, simples e profissional.
Pergunte como ele costuma passar orçamento hoje para os clientes.
Destaque que com o OrcaEasy ele não perde tempo calculando na mão e passa muito mais confiança com um PDF profissional.
Se o lead disser que não tem tempo ou é complicado, reforce que leva menos de 2 minutos pelo celular.
Se perguntar de preço, informe que o cadastro e o teste são 100% gratuitos.`}
            value={f.instructions}
            onChange={set("instructions")}
          />
        </Field>

        <Field
          label="Quando passar para você (opcional)"
          hint="Regras específicas de handoff para este roteiro. Se vazio, usa a regra geral do Bot."
        >
          <textarea
            className="input"
            rows={2}
            placeholder="Ex.: Se o eletricista pedir demonstração ao vivo, falar sobre parcerias ou relatar erro no cadastro."
            value={f.handoffRules}
            onChange={set("handoffRules")}
          />
        </Field>

        <Field
          label="Primeira mensagem (modelo de abordagem)"
          hint="Modelo padrão para disparos em massa. Variáveis disponíveis: {nome}, {primeiro_nome}, {empresa}"
        >
          <textarea
            className="input"
            rows={3}
            placeholder="Ex.: Olá, {primeiro_nome}! Vi seu trabalho como eletricista e queria te apresentar o OrcaEasy (orcaeasy.com), um app rápido para montar e enviar orçamentos pelo WhatsApp. Quer dar uma olhada?"
            value={f.firstMessage}
            onChange={set("firstMessage")}
          />
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!f.name.trim()}>
            {playbook ? "Salvar alterações" : "Criar roteiro"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

