import { describe, expect, it } from "vitest";
import { normalizePhone } from "../src/lib/phone.js";
import { isOptOut } from "../src/services/messaging.js";
import { parseEvolutionWebhook } from "../src/whatsapp/evolution.js";
import { parseMetaWebhook } from "../src/whatsapp/meta.js";

describe("normalizePhone", () => {
  it.each([
    ["(11) 99999-8888", "5511999998888"],
    ["11 3333-4444", "551133334444"],
    ["+55 21 98888-7777", "5521988887777"],
    ["5511999998888@s.whatsapp.net", "5511999998888"],
    ["5511999998888:12@s.whatsapp.net", "5511999998888"],
    ["+1 415 555 2671", "14155552671"],
    ["14155552671@s.whatsapp.net", "14155552671"],
    ["0055 11 99999-8888", "5511999998888"],
    ["abc", null],
    ["123", null],
  ])("%s → %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it("números vindos de webhook já têm DDI", () => {
    expect(normalizePhone("14155552671", { international: true })).toBe("14155552671");
  });
});

describe("isOptOut", () => {
  const kw = ["sair", "parar", "cancelar mensagens"];
  it("reconhece só a palavra exata (ignorando acentos e pontuação)", () => {
    expect(isOptOut("SAIR", kw)).toBe(true);
    expect(isOptOut(" Parar! ", kw)).toBe(true);
    expect(isOptOut("cancelar mensagens", kw)).toBe(true);
    expect(isOptOut("não quero sair do plano", kw)).toBe(false);
  });
});

describe("parseEvolutionWebhook", () => {
  const base = (data: object, event = "messages.upsert") => ({ event, instance: "crm", data });

  it("texto simples, texto estendido e mídia com legenda", () => {
    const a = parseEvolutionWebhook(
      base({ key: { remoteJid: "5511911112222@s.whatsapp.net", fromMe: false, id: "1" }, pushName: "Ana", message: { conversation: "oi" } }),
    );
    expect(a.messages[0]).toMatchObject({ phone: "5511911112222", name: "Ana", body: "oi", fromMe: false, externalId: "1" });
    const b = parseEvolutionWebhook(
      base({ key: { remoteJid: "5511911112222@s.whatsapp.net", fromMe: true, id: "2" }, message: { extendedTextMessage: { text: "link" } } }),
    );
    expect(b.messages[0]).toMatchObject({ body: "link", fromMe: true });
    const c = parseEvolutionWebhook(
      base({ key: { remoteJid: "5511911112222@s.whatsapp.net", id: "3" }, message: { imageMessage: { caption: "meu logo" } } }),
    );
    expect(c.messages[0]).toMatchObject({ body: "[imagem] meu logo", mediaType: "image" });
    const d = parseEvolutionWebhook(base({ key: { remoteJid: "5511911112222@s.whatsapp.net", id: "4" }, message: { audioMessage: {} } }));
    expect(d.messages[0]).toMatchObject({ body: "[áudio]", mediaType: "audio" });
  });

  it("ignora grupos e status; resolve @lid pelo remoteJidAlt", () => {
    expect(parseEvolutionWebhook(base({ key: { remoteJid: "123@g.us", id: "1" }, message: { conversation: "x" } })).messages).toHaveLength(0);
    expect(parseEvolutionWebhook(base({ key: { remoteJid: "status@broadcast", id: "1" }, message: { conversation: "x" } })).messages).toHaveLength(0);
    const lid = parseEvolutionWebhook(
      base({ key: { remoteJid: "998877@lid", remoteJidAlt: "5511933334444@s.whatsapp.net", id: "9" }, message: { conversation: "oi" } }),
    );
    expect(lid.messages[0]!.phone).toBe("5511933334444");
  });

  it("status de entrega e formato com eventos em maiúsculas", () => {
    const res = parseEvolutionWebhook(base({ keyId: "ABC", remoteJid: "x", fromMe: true, status: "READ" }, "MESSAGES_UPDATE"));
    expect(res.statuses).toEqual([{ externalId: "ABC", status: "read" }]);
    const conn = parseEvolutionWebhook(base({ state: "open" }, "connection.update"));
    expect(conn.connection).toEqual({ state: "open" });
    const qr = parseEvolutionWebhook(
      base({ qrcode: { instance: "crm", pairingCode: null, code: "2@abc", base64: "data:image/png;base64,AAA" } }, "QRCODE_UPDATED"),
    );
    expect(qr.qrCode).toEqual({ base64: "data:image/png;base64,AAA", pairingCode: undefined, message: undefined });
  });
});

describe("parseMetaWebhook", () => {
  it("mensagens e status", () => {
    const res = parseMetaWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                contacts: [{ wa_id: "5511999990000", profile: { name: "Leo" } }],
                messages: [
                  { from: "5511999990000", id: "w1", timestamp: "1700000000", type: "text", text: { body: "Olá" } },
                  { from: "5511999990000", id: "w2", type: "image", image: { caption: "foto" } },
                  { from: "5511999990000", id: "w3", type: "interactive", interactive: { button_reply: { title: "Sim" } } },
                ],
                statuses: [{ id: "w0", status: "delivered" }],
              },
            },
          ],
        },
      ],
    });
    expect(res.messages.map((m) => m.body)).toEqual(["Olá", "[imagem] foto", "Sim"]);
    expect(res.messages[0]!.name).toBe("Leo");
    expect(res.statuses).toEqual([{ externalId: "w0", status: "delivered", error: undefined }]);
  });
});
