# Workflows do n8n

Quatro workflows prontos para importar. Todos foram testados no n8n 2.41 (o mesmo do `docker-compose`).

| Arquivo | O que faz |
|---|---|
| `01-captacao-formulario-e-site.json` | **Captação de leads.** O n8n hospeda um formulário (`/form/contato`) e também recebe `POST` do seu site (`/webhook/lead-site`). O lead vai para o CRM, a IA qualifica e ele recebe uma boas-vindas no WhatsApp. |
| `02-alertas-de-eventos.json` | **Alertas.** Recebe os eventos do CRM (`/webhook/crm-eventos`) e avisa no Telegram quando um lead fica quente, quando a IA passa a conversa para você e quando chega lead novo. |
| `03-follow-up-diario-com-ia.json` | **Follow-up diário.** Todo dia às 10h busca leads sem conversa há 48h e manda uma mensagem escrita pela IA com base no histórico. Marca quem recebeu (`follow-up-n8n`) para não repetir; quem foi pulado ou deu erro no envio ganha `follow-up-n8n-pulado` e sai da fila (tire a etiqueta para tentar de novo). Erro de limite da IA (429) não marca: o lead entra na próxima rodada. Envia um a cada 4 s; no plano gratuito do OpenRouter, diminua o `limit=50`. |
| `04-captador-ia-texto.json` | **Captador com IA.** Recebe qualquer texto (`/webhook/captar-texto` com `{ "texto": "..." }`), a IA extrai os dados e cria o lead. Troque o gatilho por Gmail/IMAP para captar de e-mails. |

## Como importar

1. Abra o n8n (http://localhost:5678) e crie sua conta de dono.
2. **Workflows → ⋯ → Import from file** e escolha o arquivo `.json`.
3. Abra o nó **Configuração** e troque `crmApiKey` pela `CRM_API_KEY` do seu `.env`.
   - `crmUrl` já está como `http://crm:3000` (endereço do CRM dentro do Docker). Se o n8n estiver fora do mesmo `docker-compose`, use o endereço público do CRM.
4. No workflow de alertas, configure sua credencial do **Telegram** e o **Chat ID** (ou troque o último nó por e-mail, Slack, Discord...).
5. Clique em **Publish** (publicar) para ativar.

> Pela linha de comando: `docker compose cp n8n/workflows n8n:/tmp/wf` e depois `docker compose exec n8n n8n import:workflow --separate --input=/tmp/wf`.

## Eventos que o CRM envia

O CRM faz `POST` em `N8N_WEBHOOK_URL` (padrão no Docker: `http://n8n:5678/webhook/crm-eventos`). No nó Webhook o conteúdo fica em `$json.body`:

```json
{
  "event": "lead.handoff",
  "timestamp": "2026-10-09T12:00:00.000Z",
  "data": {
    "lead": { "id": 7, "name": "Maria", "waName": "Maria 🌸", "phone": "5511999998888", "score": 72, "temperature": "quente", "chatMode": "human" },
    "reason": "Lead quer negociar desconto"
  }
}
```

| Evento | `data` |
|---|---|
| `lead.created` | `lead` |
| `lead.stage_changed` | `lead`, `from`, `to` (`{ id, name, kind }`) |
| `lead.hot` | `lead`, `summary`, `score` |
| `lead.handoff` | `lead`, `reason` |
| `lead.opted_out` | `lead` |
| `message.received` | `lead`, `message` |
| `message.sent` | `lead`, `message` (`author`: `agent`, `bot`, `automation` ou `phone`) |

Ideias de automação: criar card no Trello/Notion quando o lead vai para *Proposta*, salvar leads ganhos numa planilha, mandar e-mail de proposta, avisar o vendedor responsável, alimentar o CRM com leads do Facebook Lead Ads (troque o gatilho do workflow 01).
