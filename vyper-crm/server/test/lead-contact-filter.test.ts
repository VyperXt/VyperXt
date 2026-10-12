import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leads, messages, scheduledMessages } from "../src/db/schema.js";
import { setup, login, type TestEnv } from "./helpers.js";

let env: TestEnv;
let app: Awaited<ReturnType<TestEnv["app"]>>;
let token: string;

beforeEach(async () => {
  env = await setup();
  app = await env.app();
  token = await login(app);
});
afterEach(async () => {
  await app.close();
  await env.close();
});

async function names(contact: string): Promise<string[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/leads?contact=${contact}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return (res.json().items as Array<{ name: string }>).map((l) => l.name).sort();
}

describe("filtro de contato da lista de leads", () => {
  it("separa quem nunca recebeu, quem está na fila, quem não respondeu e quem respondeu", async () => {
    const db = env.ctx.db;
    const [nunca, falhou, fila, enviado, respondeu] = await db
      .insert(leads)
      .values([
        { name: "nunca", phone: "5511900000001" },
        { name: "falhou", phone: "5511900000002" },
        { name: "fila", phone: "5511900000003" },
        { name: "enviado", phone: "5511900000004" },
        { name: "respondeu", phone: "5511900000005" },
      ])
      .returning();
    await db.insert(messages).values([
      // Envio que falhou não conta como contato feito
      { leadId: falhou!.id, direction: "out", author: "automation", body: "oi", status: "failed" },
      { leadId: enviado!.id, direction: "out", author: "automation", body: "oi", status: "sent" },
      { leadId: respondeu!.id, direction: "out", author: "automation", body: "oi", status: "delivered" },
      { leadId: respondeu!.id, direction: "in", author: "lead", body: "opa", status: "received" },
    ]);
    await db.insert(scheduledMessages).values({ leadId: fila!.id, body: "oi", sendAt: new Date(Date.now() + 60_000) });

    expect(await names("never")).toEqual(["falhou", "nunca"]);
    expect(await names("queued")).toEqual(["fila"]);
    expect(await names("sent")).toEqual(["enviado"]);
    expect(await names("replied")).toEqual(["respondeu"]);
    expect(nunca).toBeDefined();
  });
});
