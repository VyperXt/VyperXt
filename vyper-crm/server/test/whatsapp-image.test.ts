import { describe, expect, it } from "vitest";
import { EvolutionProvider } from "../src/whatsapp/evolution.js";
import { MetaCloudProvider } from "../src/whatsapp/meta.js";
import { SimulatorProvider } from "../src/whatsapp/simulator.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { json: {} };
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("envio de imagem pelo WhatsApp", () => {
  it("Evolution: sendMedia com a imagem em base64, legenda e nome do arquivo", async () => {
    const fake = fakeFetch([{ json: { key: { id: "EVO-IMG-1" } } }]);
    const wa = new EvolutionProvider({ baseUrl: "http://evo.test/", apiKey: "k", instance: "crm", webhookUrl: "", fetchImpl: fake.fetchImpl });
    const out = await wa.sendImage("5511977776666", { data: PNG, mimeType: "image/png", caption: "Olha a arte!", fileName: "arte.png" });
    expect(out).toEqual({ externalId: "EVO-IMG-1" });
    expect(fake.calls[0]!.url).toBe("http://evo.test/message/sendMedia/crm");
    expect(fake.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(fake.calls[0]!.init.body))).toEqual({
      number: "5511977776666",
      mediatype: "image",
      mimetype: "image/png",
      caption: "Olha a arte!",
      media: PNG.toString("base64"),
      fileName: "arte.png",
    });
  });

  it("Evolution: erro HTTP sobe como erro", async () => {
    const fake = fakeFetch([{ status: 400, json: { message: "número inválido" } }]);
    const wa = new EvolutionProvider({ baseUrl: "http://evo.test", apiKey: "k", instance: "crm", webhookUrl: "", fetchImpl: fake.fetchImpl });
    await expect(wa.sendImage("55", { data: PNG, mimeType: "image/png" })).rejects.toThrow(/sendMedia\/crm → 400/);
  });

  it("Meta: sobe a mídia (multipart) e envia a mensagem com o id dela", async () => {
    const fake = fakeFetch([{ json: { id: "MEDIA-1" } }, { json: { messages: [{ id: "wamid.IMG" }] } }]);
    const wa = new MetaCloudProvider({ accessToken: "tok", phoneNumberId: "123", graphVersion: "v23.0", fetchImpl: fake.fetchImpl });
    const out = await wa.sendImage("5511977776666", { data: PNG, mimeType: "image/png", caption: "Legenda" });
    expect(out).toEqual({ externalId: "wamid.IMG" });

    expect(fake.calls[0]!.url).toBe("https://graph.facebook.com/v23.0/123/media");
    const form = fake.calls[0]!.init.body as FormData;
    expect(form.get("messaging_product")).toBe("whatsapp");
    expect(form.get("type")).toBe("image/png");
    const file = form.get("file") as File;
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
    expect(file.name).toBe("imagem.png");

    expect(fake.calls[1]!.url).toBe("https://graph.facebook.com/v23.0/123/messages");
    expect(JSON.parse(String(fake.calls[1]!.init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "5511977776666",
      type: "image",
      image: { id: "MEDIA-1", caption: "Legenda" },
    });
  });

  it("Meta: falha no upload não envia a mensagem", async () => {
    const fake = fakeFetch([{ status: 400, json: { error: { message: "arquivo inválido" } } }]);
    const wa = new MetaCloudProvider({ accessToken: "tok", phoneNumberId: "123", graphVersion: "v23.0", fetchImpl: fake.fetchImpl });
    await expect(wa.sendImage("55", { data: PNG, mimeType: "image/png" })).rejects.toThrow(/envio da imagem\) → 400: arquivo inválido/);
    expect(fake.calls).toHaveLength(1);
  });

  it("Simulador: registra a imagem em sent (legenda como texto) e respeita failNext", async () => {
    const wa = new SimulatorProvider();
    const out = await wa.sendImage("5511977776666", { data: PNG, mimeType: "image/png", caption: "Oi", fileName: "a.png" });
    expect(wa.sent).toEqual([
      { phone: "5511977776666", text: "Oi", externalId: out.externalId, image: { mimeType: "image/png", bytes: PNG.length, fileName: "a.png" } },
    ]);
    await wa.sendImage("5511977776666", { data: PNG, mimeType: "image/jpeg" });
    expect(wa.sent[1]!.text).toBe("");
    wa.failNext = "caiu";
    await expect(wa.sendImage("5511977776666", { data: PNG, mimeType: "image/png" })).rejects.toThrow("caiu");
    expect(wa.sent).toHaveLength(2);
  });
});
