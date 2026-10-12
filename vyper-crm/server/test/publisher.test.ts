import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../src/db/schema.js";
import { createPublisher, NETLIFY_SETTINGS_KEY, type PublisherOptions } from "../src/lib/publisher.js";
import { HttpError } from "../src/services/leads.js";
import { setup, type TestEnv } from "./helpers.js";

const TOKEN = "nfp_token_secreto";
const sha1 = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");

interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (req: Req) => { status?: number; json?: unknown; text?: string } | undefined;

/** API do Netlify falsa: guarda os pedidos e responde pelas rotas (a primeira que devolver algo vence). */
function fakeNetlify(...routes: Route[]) {
  const requests: Req[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const raw = init.body;
    const body =
      raw instanceof Uint8Array ? Buffer.from(raw) : typeof raw === "string" && headers["Content-Type"] === "application/json" ? JSON.parse(raw) : raw;
    const req = { method: init.method ?? "GET", url, headers, body };
    requests.push(req);
    for (const route of routes) {
      const res = route(req);
      if (res) {
        const text = res.text ?? (res.json === undefined ? "" : JSON.stringify(res.json));
        return new Response(text, { status: res.status ?? 200 });
      }
    }
    return new Response(JSON.stringify({ message: "rota não simulada" }), { status: 500 });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

const API = "https://api.netlify.com/api/v1";

/** Fluxo feliz: cria site, deploy pede os arquivos de `required`, fica pronto depois de `pollsUntilReady` consultas. */
function happyRoutes(opts: { required?: (files: Record<string, string>) => string[]; pollsUntilReady?: number } = {}) {
  let polls = 0;
  let digests: Record<string, string> = {};
  const routes: Route[] = [
    (r) =>
      r.method === "POST" && r.url === `${API}/sites`
        ? { json: { id: "site-1", url: "http://vyper-demos-x.netlify.app", ssl_url: "https://vyper-demos-x.netlify.app" } }
        : undefined,
    (r) =>
      r.method === "GET" && r.url === `${API}/sites/site-1`
        ? { json: { id: "site-1", url: "http://vyper-demos-x.netlify.app", ssl_url: "https://vyper-demos-x.netlify.app/" } }
        : undefined,
    (r) => {
      if (r.method !== "POST" || r.url !== `${API}/sites/site-1/deploys`) return undefined;
      digests = (r.body as { files: Record<string, string> }).files;
      return { json: { id: "dep-1", state: "uploading", required: opts.required ? opts.required(digests) : Object.values(digests) } };
    },
    (r) => (r.method === "PUT" && r.url.startsWith(`${API}/deploys/dep-1/files/`) ? { json: {} } : undefined),
    (r) => {
      if (r.method !== "GET" || r.url !== `${API}/deploys/dep-1`) return undefined;
      polls++;
      return { json: { id: "dep-1", state: polls >= (opts.pollsUntilReady ?? 1) ? "ready" : "processing" } };
    },
  ];
  return { routes, polls: () => polls };
}

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env.close();
});

function publisher(fetchImpl: typeof fetch, siteId = "", extra: PublisherOptions = {}) {
  const p = createPublisher({ NETLIFY_AUTH_TOKEN: TOKEN, NETLIFY_SITE_ID: siteId }, env.ctx.db, {
    fetchImpl,
    sleep: async () => {},
    ...extra,
  });
  if (!p) throw new Error("publisher deveria existir");
  return p;
}

describe("Netlify — publicação dos sites demo", () => {
  it("sem NETLIFY_AUTH_TOKEN não há publisher", () => {
    expect(createPublisher({ NETLIFY_AUTH_TOKEN: "", NETLIFY_SITE_ID: "" }, env.ctx.db)).toBeNull();
  });

  it("cria o site uma vez, guarda no banco e reaproveita no próximo deploy", async () => {
    const { routes } = happyRoutes();
    const fake = fakeNetlify(...routes);
    const pub = publisher(fake.fetchImpl);

    const out = await pub.publish([{ path: "/padaria-abc/index.html", content: "<html>oi</html>" }]);
    expect(out).toEqual({ siteUrl: "https://vyper-demos-x.netlify.app" });
    const create = fake.requests.filter((r) => r.method === "POST" && r.url === `${API}/sites`);
    expect(create).toHaveLength(1);
    expect((create[0]!.body as { name: string }).name).toMatch(/^vyper-demos-[0-9a-f]{8}$/);
    expect(fake.requests.every((r) => r.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);

    const [row] = await env.ctx.db.select().from(settings).where(eq(settings.key, NETLIFY_SETTINGS_KEY));
    expect(row?.value).toEqual({ siteId: "site-1", url: "https://vyper-demos-x.netlify.app" });

    // Outra instância (reinício do CRM): lê o site do banco, não cria outro
    const fake2 = fakeNetlify(...happyRoutes().routes);
    await publisher(fake2.fetchImpl).publish([{ path: "/padaria-abc/index.html", content: "<html>oi</html>" }]);
    expect(fake2.requests.some((r) => r.method === "POST" && r.url === `${API}/sites`)).toBe(false);
    expect(fake2.requests[0]).toMatchObject({ method: "GET", url: `${API}/sites/site-1` });
  });

  it("deploy por digest: manda o SHA1 de todos (com robots.txt e a página neutra) e só envia os pedidos", async () => {
    const html = "<html>demo</html>";
    const { routes } = happyRoutes({ required: (files) => [files["/demo-1/index.html"]!] });
    const fake = fakeNetlify(...routes);
    await publisher(fake.fetchImpl, "site-1").publish([
      { path: "/demo-1/index.html", content: html },
      { path: "demo-2/index.html", content: Buffer.from("<html>outro</html>") },
    ]);

    const deploy = fake.requests.find((r) => r.method === "POST" && r.url.endsWith("/deploys"))!;
    const files = (deploy.body as { files: Record<string, string> }).files;
    expect(Object.keys(files).sort()).toEqual(["/demo-1/index.html", "/demo-2/index.html", "/index.html", "/robots.txt"]);
    expect(files["/demo-1/index.html"]).toBe(sha1(html));
    expect(fake.requests.some((r) => r.method === "POST" && r.url === `${API}/sites`)).toBe(false);

    const puts = fake.requests.filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe(`${API}/deploys/dep-1/files/demo-1/index.html`);
    expect(puts[0]!.headers["Content-Type"]).toBe("application/octet-stream");
    expect((puts[0]!.body as Buffer).toString("utf8")).toBe(html);
  });

  it("robots.txt bloqueia indexação e a página da raiz é neutra; o chamador não sobrescreve as duas", async () => {
    const { routes } = happyRoutes();
    const fake = fakeNetlify(...routes);
    await publisher(fake.fetchImpl, "site-1").publish([
      { path: "/robots.txt", content: "User-agent: *\nAllow: /" },
      { path: "/index.html", content: "<html>lista de clientes</html>" },
      { path: "/meu demo/índice.html", content: "x" },
    ]);
    const body = (suffix: string) => (fake.requests.find((r) => r.method === "PUT" && r.url.endsWith(suffix))!.body as Buffer).toString("utf8");
    expect(body("/files/robots.txt")).toBe("User-agent: *\nDisallow: /\n");
    expect(body("/files/index.html")).toMatch(/noindex/);
    expect(body("/files/index.html")).toMatch(/Demonstrações/);
    expect(body("/files/index.html")).not.toMatch(/clientes/);
    // Cada parte do caminho vai codificada
    expect(fake.requests.some((r) => r.url === `${API}/deploys/dep-1/files/meu%20demo/%C3%ADndice.html`)).toBe(true);
  });

  it("espera o deploy ficar pronto consultando o estado", async () => {
    const happy = happyRoutes({ pollsUntilReady: 3 });
    const fake = fakeNetlify(...happy.routes);
    await publisher(fake.fetchImpl, "site-1").publish([]);
    expect(happy.polls()).toBe(3);
  });

  it("deploy com erro ou que não fica pronto a tempo → 502", async () => {
    const failing = fakeNetlify(
      (r) => (r.method === "GET" && r.url === `${API}/sites/site-1` ? { json: { id: "site-1", ssl_url: "https://x.netlify.app" } } : undefined),
      (r) => (r.method === "POST" ? { json: { id: "dep-1", state: "uploading", required: [] } } : undefined),
      (r) => (r.method === "GET" ? { json: { id: "dep-1", state: "error", error_message: "build quebrou" } } : undefined),
    );
    const err = await publisher(failing.fetchImpl, "site-1").publish([]).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(502);
    expect(err.message).toMatch(/Falha ao publicar no Netlify: o deploy falhou \(build quebrou\)/);

    let clock = 0;
    const stuck = fakeNetlify(
      (r) => (r.method === "GET" && r.url === `${API}/sites/site-1` ? { json: { id: "site-1", ssl_url: "https://x.netlify.app" } } : undefined),
      (r) => (r.method === "POST" ? { json: { id: "dep-1", state: "uploading", required: [] } } : undefined),
      (r) => (r.method === "GET" ? { json: { id: "dep-1", state: "processing" } } : undefined),
    );
    const err2 = await publisher(stuck.fetchImpl, "site-1", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    })
      .publish([])
      .catch((e) => e);
    expect(err2.statusCode).toBe(502);
    expect(err2.message).toMatch(/não ficou pronto em 90 s/);
  });

  it("token inválido (401) → 502 com a dica, sem vazar o token", async () => {
    const fake = fakeNetlify(() => ({ status: 401, json: { code: 401, message: "Access Denied" } }));
    const err = await publisher(fake.fetchImpl).publish([]).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(502);
    expect(err.message).toMatch(/token inválido — gere em app\.netlify\.com\/user\/applications/);
    expect(err.message).not.toContain(TOKEN);
  });

  it("outros erros da API e falta de conexão → 502 com o motivo", async () => {
    const fake = fakeNetlify(
      (r) => (r.method === "GET" ? { json: { id: "site-1", ssl_url: "https://x.netlify.app" } } : undefined),
      () => ({ status: 422, json: { message: "files inválidos" } }),
    );
    const err = await publisher(fake.fetchImpl, "site-1").publish([]).catch((e) => e);
    expect(err.message).toBe("Falha ao publicar no Netlify: pedido recusado (422): files inválidos.");

    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err2 = await publisher(offline, "site-1").publish([]).catch((e) => e);
    expect(err2.statusCode).toBe(502);
    expect(err2.message).toMatch(/sem conexão com a API \(fetch failed\)/);
  });

  it("site guardado foi apagado no Netlify → cria outro e atualiza o banco", async () => {
    await env.ctx.db.insert(settings).values({ key: NETLIFY_SETTINGS_KEY, value: { siteId: "apagado", url: "https://old.netlify.app" } });
    const { routes } = happyRoutes();
    const fake = fakeNetlify((r) => (r.method === "GET" && r.url === `${API}/sites/apagado` ? { status: 404, json: {} } : undefined), ...routes);
    const out = await publisher(fake.fetchImpl).publish([]);
    expect(out.siteUrl).toBe("https://vyper-demos-x.netlify.app");
    const [row] = await env.ctx.db.select().from(settings).where(eq(settings.key, NETLIFY_SETTINGS_KEY));
    expect((row?.value as { siteId: string }).siteId).toBe("site-1");
  });

  it("caminho com .. é recusado", async () => {
    const fake = fakeNetlify(...happyRoutes().routes);
    await expect(publisher(fake.fetchImpl, "site-1").publish([{ path: "/../x.html", content: "x" }])).rejects.toThrow(/Caminho inválido/);
  });
});
