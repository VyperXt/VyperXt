import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { HttpError } from "../services/leads.js";

/** Um arquivo do site de demos. `path` começa com "/" (ex.: "/<slug>/index.html"). */
export interface PublishedFile {
  path: string;
  content: string | Buffer;
}

export interface SitePublisher {
  readonly name: "netlify";
  /** Publica o conjunto COMPLETO de arquivos do site de demos (deploy por digest: só envia o que mudou). */
  publish(files: PublishedFile[]): Promise<{ siteUrl: string }>;
}

export interface PublisherConfig {
  NETLIFY_AUTH_TOKEN: string;
  NETLIFY_SITE_ID: string;
}

export interface PublisherOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Tempo máximo esperando o deploy ficar pronto (padrão 90 s) */
  deployTimeoutMs?: number;
  /** Intervalo entre as consultas do deploy (padrão 1,5 s) */
  pollIntervalMs?: number;
  /** Para testes (relógio do timeout) */
  now?: () => number;
}

const API = "https://api.netlify.com/api/v1";
/** Linha da tabela settings onde guardamos o site criado pelo CRM */
export const NETLIFY_SETTINGS_KEY = "netlify";

const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
const INDEX_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Demonstrações</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f5f5f7;color:#333}p{font-size:1.1rem}</style>
</head>
<body><p>Demonstrações</p></body>
</html>
`;

/** Netlify sem chave → null (o CRM não publica sites). */
export function createPublisher(config: PublisherConfig, db: Db, opts: PublisherOptions = {}): SitePublisher | null {
  if (!config.NETLIFY_AUTH_TOKEN) return null;
  return new NetlifyPublisher(config.NETLIFY_AUTH_TOKEN, config.NETLIFY_SITE_ID, db, opts);
}

interface NetlifySite {
  id: string;
  url?: string;
  ssl_url?: string;
}

interface NetlifyDeploy {
  id: string;
  state?: string;
  required?: string[];
  error_message?: string | null;
}

export class NetlifyPublisher implements SitePublisher {
  readonly name = "netlify" as const;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private deployTimeoutMs: number;
  private pollIntervalMs: number;
  private now: () => number;
  /** Um deploy por vez: dois publish() simultâneos poderiam derrubar os arquivos um do outro */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private token: string,
    private configuredSiteId: string,
    private db: Db,
    opts: PublisherOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.deployTimeoutMs = opts.deployTimeoutMs ?? 90_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1500;
    this.now = opts.now ?? Date.now;
  }

  publish(files: PublishedFile[]): Promise<{ siteUrl: string }> {
    const run = this.queue.then(() => this.doPublish(files));
    this.queue = run.catch(() => {});
    return run;
  }

  private async doPublish(files: PublishedFile[]): Promise<{ siteUrl: string }> {
    const site = await this.site();

    // Conteúdo por caminho (o último vence) + robots.txt e a página neutra, sempre
    const byPath = new Map<string, Buffer>();
    for (const f of files) {
      const path = normalizePath(f.path);
      if (path === "/robots.txt" || path === "/index.html") continue;
      byPath.set(path, typeof f.content === "string" ? Buffer.from(f.content, "utf8") : f.content);
    }
    byPath.set("/robots.txt", Buffer.from(ROBOTS_TXT, "utf8"));
    byPath.set("/index.html", Buffer.from(INDEX_HTML, "utf8"));

    const digests: Record<string, string> = {};
    const bySha = new Map<string, string[]>();
    for (const [path, data] of byPath) {
      const sha = createHash("sha1").update(data).digest("hex");
      digests[path] = sha;
      bySha.set(sha, [...(bySha.get(sha) ?? []), path]);
    }

    const deploy = await this.api<NetlifyDeploy>("POST", `/sites/${encodeURIComponent(site.id)}/deploys`, { files: digests });
    // Só os arquivos que o Netlify ainda não tem (arquivos iguais → basta enviar um deles)
    for (const sha of new Set(deploy.required ?? [])) {
      const path = bySha.get(sha)?.[0];
      if (!path) continue;
      await this.api("PUT", `/deploys/${encodeURIComponent(deploy.id)}/files/${encodeFilePath(path)}`, byPath.get(path)!);
    }

    await this.waitReady(deploy);
    return { siteUrl: (site.ssl_url || site.url || "").replace(/\/+$/, "") };
  }

  private async waitReady(deploy: NetlifyDeploy): Promise<void> {
    const deadline = this.now() + this.deployTimeoutMs;
    let current = deploy;
    for (;;) {
      if (current.state === "ready") return;
      if (current.state === "error") {
        throw new HttpError(502, `Falha ao publicar no Netlify: o deploy falhou${current.error_message ? ` (${current.error_message})` : ""}.`);
      }
      if (this.now() >= deadline) {
        throw new HttpError(502, `Falha ao publicar no Netlify: o deploy não ficou pronto em ${Math.round(this.deployTimeoutMs / 1000)} s.`);
      }
      await this.sleep(this.pollIntervalMs);
      current = await this.api<NetlifyDeploy>("GET", `/deploys/${encodeURIComponent(deploy.id)}`);
    }
  }

  /** Site dos demos: NETLIFY_SITE_ID, senão o guardado no banco, senão cria um (e guarda). */
  private async site(): Promise<NetlifySite> {
    if (this.configuredSiteId) {
      return this.api<NetlifySite>("GET", `/sites/${encodeURIComponent(this.configuredSiteId)}`);
    }
    const [row] = await this.db.select().from(settings).where(eq(settings.key, NETLIFY_SETTINGS_KEY));
    const stored = row?.value as { siteId?: unknown; url?: unknown } | undefined;
    if (stored && typeof stored.siteId === "string" && stored.siteId) {
      try {
        return await this.api<NetlifySite>("GET", `/sites/${encodeURIComponent(stored.siteId)}`);
      } catch (err) {
        // Site apagado no painel do Netlify → cria outro; qualquer outro erro sobe
        if (!(err instanceof NetlifyNotFound)) throw err;
      }
    }
    const created = await this.api<NetlifySite>("POST", "/sites", { name: `vyper-demos-${randomBytes(4).toString("hex")}` });
    const value = { siteId: created.id, url: created.ssl_url || created.url || "" };
    await this.db
      .insert(settings)
      .values({ key: NETLIFY_SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    return created;
  }

  private async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let payload: string | Uint8Array | undefined;
    if (Buffer.isBuffer(body)) {
      headers["Content-Type"] = "application/octet-stream";
      payload = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new HttpError(502, `Falha ao publicar no Netlify: sem conexão com a API (${err instanceof Error ? err.message : String(err)}).`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      if (res.status === 404 && method === "GET" && path.startsWith("/sites/")) throw new NetlifyNotFound();
      throw new HttpError(502, `Falha ao publicar no Netlify: ${describeStatus(res.status, text)}`);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(502, "Falha ao publicar no Netlify: resposta inesperada da API.");
    }
  }
}

class NetlifyNotFound extends HttpError {
  constructor() {
    super(502, "Falha ao publicar no Netlify: site não encontrado (confira NETLIFY_SITE_ID).");
  }
}

function describeStatus(status: number, body: string): string {
  if (status === 401) return "token inválido — gere em app.netlify.com/user/applications e coloque em NETLIFY_AUTH_TOKEN.";
  if (status === 403) return "o token não tem acesso a este site (403).";
  if (status === 404) return "não encontrado (404) — confira NETLIFY_SITE_ID.";
  if (status === 422) return `pedido recusado (422)${apiMessage(body)}.`;
  if (status === 429) return "limite de uso da API do Netlify atingido (429) — tente de novo em alguns minutos.";
  return `erro ${status}${apiMessage(body)}.`;
}

function apiMessage(body: string): string {
  try {
    const msg = (JSON.parse(body) as { message?: unknown; errors?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return `: ${msg.trim().slice(0, 200)}`;
  } catch {
    /* corpo não é JSON */
  }
  return "";
}

function normalizePath(path: string): string {
  const p = `/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  if (p.split("/").some((seg) => seg === ".." || seg === ".")) throw new Error(`Caminho inválido para publicar: ${path}`);
  return p;
}

/** "/meu demo/index.html" → "meu%20demo/index.html" */
function encodeFilePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}
