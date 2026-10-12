import { z } from "zod";

// Atenção: estes schemas viram JSON Schema para a saída estruturada do Claude.
// Evite min/max — valores fora do intervalo são corrigidos no código (clamp).

export const replySchema = z.object({
  reply: z.string().describe("Mensagem de WhatsApp a enviar ao lead (curta, natural, sem markdown)."),
  handoff: z.boolean().describe("true se a conversa deve passar para um atendente humano agora."),
  handoffReason: z.string().describe("Motivo curto da transferência; vazio se handoff for false."),
});
export type ReplyOutput = z.infer<typeof replySchema>;

export const qualifySchema = z.object({
  name: z.string().describe("Nome da pessoa, se ela disse. Vazio se não souber."),
  email: z.string().describe("E-mail, se informado. Vazio se não souber."),
  company: z.string().describe("Empresa, se informada. Vazio se não souber."),
  interest: z.string().describe("O que a pessoa procura, em poucas palavras. Vazio se não souber."),
  budget: z.string().describe("Orçamento mencionado. Vazio se não souber."),
  timeline: z.string().describe("Prazo/urgência mencionados. Vazio se não souber."),
  score: z.number().int().describe("Nota de 0 a 100 da chance de compra."),
  temperature: z.enum(["frio", "morno", "quente"]),
  summary: z.string().describe("Resumo de 1 a 3 frases sobre o lead e o momento da conversa."),
  suggestedStage: z.string().describe("Nome EXATO de uma das etapas do funil, ou vazio se não houver certeza."),
  tags: z.array(z.string()).describe("Até 5 etiquetas curtas em minúsculas (ex.: 'orçamento-alto')."),
});
export type QualifyOutput = z.infer<typeof qualifySchema>;

export const copilotSchema = z.object({
  summary: z.string().describe("Leitura rápida do momento da conversa (1-2 frases)."),
  intent: z.string().describe("O que o lead quer de verdade agora."),
  sentiment: z.enum(["positivo", "neutro", "negativo"]),
  buyingStage: z.string().describe("Momento de compra: curiosidade, pesquisa, comparação, decisão, pós-venda..."),
  objections: z.array(z.string()).describe("Objeções explícitas ou implícitas."),
  buyingSignals: z.array(z.string()).describe("Sinais de compra percebidos."),
  nextBestAction: z.string().describe("A melhor próxima ação para o vendedor, em uma frase."),
  paths: z
    .array(
      z.object({
        title: z.string().describe("Nome curto do caminho (ex.: 'Aprofundar a dor')."),
        strategy: z.string().describe("Por que seguir este caminho e o que se espera dele."),
        message: z.string().describe("Sugestão de mensagem pronta para o vendedor adaptar."),
      }),
    )
    .describe("De 2 a 3 caminhos diferentes para conduzir a conversa."),
  avoid: z.array(z.string()).describe("O que evitar agora."),
  missingInfo: z.array(z.string()).describe("Informações importantes que ainda faltam descobrir."),
});
export type CopilotOutput = z.infer<typeof copilotSchema>;

export const copilotAskSchema = z.object({
  answer: z.string().describe("Resposta/orientação direta para o vendedor."),
  suggestedMessage: z.string().describe("Mensagem pronta para o vendedor enviar, se fizer sentido. Vazio se não."),
});
export type CopilotAskOutput = z.infer<typeof copilotAskSchema>;

export const extractSchema = z.object({
  leads: z.array(
    z.object({
      name: z.string(),
      phone: z.string().describe("Telefone como aparece no texto. Vazio se não houver."),
      email: z.string(),
      company: z.string(),
      interest: z.string(),
      notes: z.string().describe("Outras informações úteis sobre o contato."),
    }),
  ),
});
export type ExtractOutput = z.infer<typeof extractSchema>;

export const followupSchema = z.object({
  send: z.boolean().describe("false se NÃO for apropriado mandar follow-up agora (ex.: lead disse que não tem interesse)."),
  message: z.string().describe("A mensagem de follow-up. Vazio se send for false."),
  reason: z.string().describe("Motivo curto da decisão."),
});
export type FollowupOutput = z.infer<typeof followupSchema>;

export const prospectSchema = z.object({
  prospects: z
    .array(
      z.object({
        company: z.string().describe("Nome da empresa/negócio como aparece na fonte."),
        contactName: z.string().describe("Nome do responsável/dono, se aparecer publicamente. Vazio se não souber."),
        phone: z
          .string()
          .describe("Telefone exatamente como aparece na fonte. Se a empresa divulga um WhatsApp (wa.me, botão/ícone de WhatsApp, \"WhatsApp:\" na bio ou na ficha), use esse número. Vazio se não achar."),
        email: z.string().describe("E-mail comercial encontrado na fonte. Vazio se não achar."),
        website: z.string().describe("Site oficial (URL completa). Vazio se não houver."),
        instagram: z.string().describe("Perfil do Instagram (URL ou @usuario). Vazio se não houver."),
        address: z.string().describe("Endereço como aparece na fonte. Vazio se não souber."),
        city: z.string().describe("Cidade (e UF, se souber)."),
        size: z.string().describe("Porte estimado (ex.: MEI, pequena, média, grande) e por quê, em poucas palavras."),
        fitReason: z.string().describe("Por que esta empresa combina com a oferta, em 1 ou 2 frases."),
        approach: z.string().describe("Primeira mensagem de WhatsApp sugerida: curta, pessoal, sem cara de spam."),
        score: z.number().int().describe("Nota de 0 a 100 do encaixe com a oferta."),
        sources: z.array(z.string()).describe("URLs das páginas onde os dados foram encontrados (pelo menos uma)."),
      }),
    )
    .describe("Empresas reais encontradas na pesquisa."),
  notes: z.string().describe("Observações curtas sobre a pesquisa (ex.: dificuldades, região com poucos resultados)."),
});
export type ProspectOutput = z.infer<typeof prospectSchema>;

export const sampleSiteSchema = z.object({
  title: z.string().describe("Título curto da amostra (ex.: 'Site demo — Padaria Bom Pão')."),
  html: z
    .string()
    .describe("Página HTML completa e autossuficiente (<!doctype html> ... </html>), com CSS embutido."),
  caption: z
    .string()
    .describe("Mensagem curta e simpática de WhatsApp para enviar junto com o link (o sistema acrescenta o link)."),
  notes: z.string().describe("Observações curtas para o vendedor (até 3 frases): o que ficou genérico e o que conferir antes de enviar."),
});
export type SampleSiteOutput = z.infer<typeof sampleSiteSchema>;

export const sampleImageSchema = z.object({
  title: z.string().describe("Título curto da amostra (ex.: 'Post de lançamento — Studio Ana')."),
  svg: z.string().describe('Arte em SVG completa (<svg ... viewBox="0 0 1080 1350"> ... </svg>), só com formas e textos.'),
  caption: z.string().describe("Mensagem curta e simpática de WhatsApp para enviar junto com a imagem."),
  notes: z.string().describe("Observações curtas para o vendedor (até 3 frases): o que ficou genérico e o que conferir antes de enviar."),
});
export type SampleImageOutput = z.infer<typeof sampleImageSchema>;
