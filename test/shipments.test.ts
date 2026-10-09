import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { MemoryNotifier } from "../src/notifier.ts";
import { TrackHubClient } from "../src/trackhub/client.ts";
import { FakeTrackHub, rawTracking } from "../src/trackhub/fake-transport.ts";

const CODE = "BR123456789BR";
let now: Date;
const at = (iso: string) => {
  now = new Date(iso);
};

function setup() {
  const hub = new FakeTrackHub();
  const notifier = new MemoryNotifier();
  const app = createApp({
    db: openDatabase(":memory:"),
    aggregator: new TrackHubClient(hub),
    notifier,
    clock: () => now,
    config: { defaultMaxTransitHours: 72 },
  });
  return { hub, notifier, app };
}
type Ctx = ReturnType<typeof setup>;

async function call(app: Ctx["app"], path: string, body?: unknown, method = "POST") {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const cp = (id: string, time: string, status: string) => ({ id, time, status });
const POSTED = cp("cp_1", "2026-05-01T09:00:00-03:00", "Objeto postado"); // 12:00Z
const TRANSIT = cp("cp_2", "2026-05-02T09:00:00-03:00", "Objeto em trânsito - por favor aguarde");
const OUT = cp("cp_3", "2026-05-03T09:00:00-03:00", "Objeto saiu para entrega ao destinatário");
const DELIVERED = cp("cp_4", "2026-05-03T15:00:00-03:00", "Objeto entregue ao destinatário"); // 18:00Z

async function register(ctx: Ctx, checkpoints: ReturnType<typeof cp>[], extra: Record<string, unknown> = {}) {
  ctx.hub.setTracking(CODE, rawTracking(CODE, "correios", checkpoints));
  const created = await call(ctx.app, "/shipments", { tracking_code: CODE, carrier: "correios", ...extra });
  return created.body.id as string;
}

beforeEach(() => at("2026-05-03T12:00:00.000Z"));

describe("cadastro e consulta", () => {
  it("cadastra o código no agregador e devolve o pacote sem status ainda", async () => {
    const ctx = setup();
    ctx.hub.setTracking(CODE, rawTracking(CODE, "correios", [POSTED]));
    const res = await call(ctx.app, "/shipments", { tracking_code: CODE, carrier: "Correios" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ tracking_code: CODE, carrier: "correios", status: null, events: [] });
    expect(ctx.hub.requests[0]).toMatchObject({ method: "POST" });
    expect((await call(ctx.app, "/shipments", { tracking_code: CODE })).status).toBe(200); // mesmo código, mesmo pacote
  });

  it("sincroniza e traduz o payload bruto para o status normalizado", async () => {
    const ctx = setup();
    const id = await register(ctx, [POSTED, TRANSIT]);
    const res = await call(ctx.app, `/shipments/${id}/sync`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ received: 2, inserted: 2, duplicates: 0, unmapped: 0 });
    expect(res.body.shipment).toMatchObject({ status: "in_transit", posted_at: "2026-05-01T12:00:00.000Z", needs_review: false });
    expect(res.body.shipment.events.map((e: any) => e.status)).toEqual(["posted", "in_transit"]);
  });

  it("consultar de novo o mesmo código não duplica o histórico", async () => {
    const ctx = setup();
    const id = await register(ctx, [POSTED, TRANSIT]);
    await call(ctx.app, `/shipments/${id}/sync`);
    const again = await call(ctx.app, `/shipments/${id}/sync`);
    expect(again.body.summary).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(again.body.shipment.events).toHaveLength(2);
  });

  it("evento novo no agregador entra e os antigos continuam uma vez só", async () => {
    const ctx = setup();
    const id = await register(ctx, [POSTED]);
    await call(ctx.app, `/shipments/${id}/sync`);
    ctx.hub.setTracking(CODE, rawTracking(CODE, "correios", [POSTED, TRANSIT, OUT]));
    const res = await call(ctx.app, `/shipments/${id}/sync`);
    expect(res.body.summary).toMatchObject({ inserted: 2, duplicates: 1 });
    expect(res.body.shipment).toMatchObject({ status: "out_for_delivery" });
  });

  it("código que o agregador não conhece vira 404, e falha do agregador vira 502 sem alterar nada", async () => {
    const ctx = setup();
    const id = await register(ctx, [POSTED]);
    await call(ctx.app, `/shipments/${id}/sync`);
    ctx.hub.failNext(503);
    const down = await call(ctx.app, `/shipments/${id}/sync`);
    expect(down.status).toBe(502);
    expect((await call(ctx.app, `/shipments/${id}`, undefined, "GET")).body.events).toHaveLength(1);

    const hub2 = setup();
    const created = await call(hub2.app, "/shipments", { tracking_code: "XX0000000000" });
    const missing = await call(hub2.app, `/shipments/${created.body.id}/sync`);
    expect(missing.status).toBe(404);
  });

  it("recusa código malformado e limite inválido", async () => {
    const ctx = setup();
    expect((await call(ctx.app, "/shipments", { tracking_code: "a b" })).status).toBe(400);
    expect((await call(ctx.app, "/shipments", { tracking_code: CODE, max_transit_hours: 0 })).status).toBe(400);
    expect((await call(ctx.app, "/shipments", { tracking_code: CODE, max_transit_hours: "48" })).status).toBe(400);
    expect((await call(ctx.app, "/shipments/nao_existe", undefined, "GET")).status).toBe(404);
  });
});

describe("eventos fora de ordem", () => {
  it("entregue chega primeiro e os antigos depois: o status continua entregue", async () => {
    const ctx = setup();
    const id = await register(ctx, [DELIVERED]);
    await call(ctx.app, `/shipments/${id}/sync`);
    ctx.hub.setTracking(CODE, rawTracking(CODE, "correios", [DELIVERED, POSTED, TRANSIT, OUT]));
    const res = await call(ctx.app, `/shipments/${id}/sync`);
    expect(res.body.shipment).toMatchObject({ status: "delivered", delivered_at: "2026-05-03T18:00:00.000Z" });
    expect(res.body.shipment.events.map((e: any) => e.status)).toEqual(["posted", "in_transit", "out_for_delivery", "delivered"]);
  });

  it("evento antigo entregue por webhook depois de um mais novo não faz o status voltar", async () => {
    const ctx = setup();
    const id = await register(ctx, [OUT]);
    await call(ctx.app, `/shipments/${id}/sync`);
    const late = await call(ctx.app, "/webhooks/tracking", rawTracking(CODE, "correios", [TRANSIT, POSTED]));
    expect(late.status).toBe(200);
    expect(late.body.summary).toMatchObject({ inserted: 2 });
    expect(late.body.shipment.status).toBe("out_for_delivery");
    expect(late.body.shipment.posted_at).toBe("2026-05-01T12:00:00.000Z"); // o início passa a ser o postado que chegou tarde
  });

  it("o mesmo webhook repetido não duplica", async () => {
    const ctx = setup();
    const id = await register(ctx, [POSTED]);
    const payload = rawTracking(CODE, "correios", [POSTED, TRANSIT]);
    await call(ctx.app, "/webhooks/tracking", payload);
    const again = await call(ctx.app, "/webhooks/tracking", payload);
    expect(again.body.summary).toMatchObject({ inserted: 0, duplicates: 2 });
    expect((await call(ctx.app, `/shipments/${id}`, undefined, "GET")).body.events).toHaveLength(2);
  });

  it("webhook de código não cadastrado e payload irreconhecível", async () => {
    const ctx = setup();
    expect((await call(ctx.app, "/webhooks/tracking", rawTracking("ZZ0000000000", "correios", []))).status).toBe(404);
    expect((await call(ctx.app, "/webhooks/tracking", { qualquer: "coisa" })).status).toBe(400);
  });
});

describe("status que a transportadora inventou", () => {
  it("fica no histórico, marca o pacote para revisão e não vira entregue", async () => {
    const ctx = setup();
    const id = await register(ctx, [POSTED, cp("cp_x", "2026-05-02T10:00:00-03:00", "Objeto entregue (provavelmente)")]);
    const res = await call(ctx.app, `/shipments/${id}/sync`);

    expect(res.body.summary).toMatchObject({ inserted: 2, unmapped: 1 });
    expect(res.body.shipment).toMatchObject({ status: "posted", delivered_at: null, needs_review: true });
    expect(res.body.shipment.events.find((e: any) => e.unmapped)).toMatchObject({
      status: null,
      raw_status: "Objeto entregue (provavelmente)",
    });
  });

  it("transportadora desconhecida: nenhum evento é traduzido, nem um que diz 'delivered'", async () => {
    const ctx = setup();
    ctx.hub.setTracking("QQ1234567890", rawTracking("QQ1234567890", "transportadora_nova", [cp("a", "2026-05-02T10:00:00Z", "delivered")]));
    const created = await call(ctx.app, "/shipments", { tracking_code: "QQ1234567890" });
    const res = await call(ctx.app, `/shipments/${created.body.id}/sync`);
    expect(res.body.shipment).toMatchObject({ status: null, delivered_at: null, needs_review: true });
  });
});

describe("aviso de atraso, com data controlada (limite padrão 72 h)", () => {
  it("em trânsito dentro do limite não avisa", async () => {
    const ctx = setup();
    const id = await register(ctx, [POSTED, TRANSIT]); // postado 01/05 12:00Z; agora 03/05 12:00Z = 48 h
    await call(ctx.app, `/shipments/${id}/sync`);
    expect(ctx.notifier.notices).toHaveLength(0);
    expect((await call(ctx.app, "/delays/check")).body.alerted).toEqual([]);
  });

  it("passou do limite em trânsito: avisa, uma única vez, mesmo checando várias vezes", async () => {
    const ctx = setup();
    const id = await register(ctx, [POSTED, TRANSIT]);
    await call(ctx.app, `/shipments/${id}/sync`);

    at("2026-05-04T12:00:01.000Z"); // 72 h + 1 s depois do postado
    const first = await call(ctx.app, "/delays/check");
    const second = await call(ctx.app, "/delays/check");
    await call(ctx.app, `/shipments/${id}/sync`);

    expect(first.body.alerted).toEqual([id]);
    expect(second.body.alerted).toEqual([]);
    expect(ctx.notifier.notices).toHaveLength(1);
    expect(ctx.notifier.notices[0]).toMatchObject({ type: "shipment_delayed", tracking_code: CODE, status: "in_transit", limit_hours: 72 });
    expect((await call(ctx.app, `/shipments/${id}`, undefined, "GET")).body.delay).toMatchObject({ state: "late" });
  });

  it("exatamente no limite ainda não avisa", async () => {
    const ctx = setup();
    await register(ctx, [POSTED, TRANSIT]);
    at("2026-05-04T12:00:00.000Z"); // exatamente 72 h
    expect((await call(ctx.app, "/delays/check")).body.alerted).toEqual([]);
  });

  it("ENTREGA NORMAL NÃO É MARCADA COMO ATRASO, nem muito tempo depois", async () => {
    const ctx = setup();
    const id = await register(ctx, [POSTED, TRANSIT, OUT, DELIVERED]); // entregue em 54 h
    await call(ctx.app, `/shipments/${id}/sync`);

    at("2026-08-01T12:00:00.000Z"); // três meses depois
    const check = await call(ctx.app, "/delays/check");
    expect(check.body).toEqual({ checked: 0, alerted: [] }); // entregue não é nem checado
    expect(ctx.notifier.notices).toHaveLength(0);
    expect((await call(ctx.app, `/shipments/${id}`, undefined, "GET")).body.delay).toMatchObject({ state: "delivered_on_time", elapsed_hours: 54 });
  });

  it("entregue com atraso fica registrado, sem aviso (já chegou)", async () => {
    const ctx = setup();
    at("2026-05-10T12:00:00.000Z");
    const id = await register(ctx, [POSTED, cp("late", "2026-05-08T09:00:00-03:00", "Objeto entregue ao destinatário")]); // 168 h
    const res = await call(ctx.app, `/shipments/${id}/sync`);
    expect(res.body.shipment.delay.state).toBe("delivered_late");
    expect(ctx.notifier.notices).toHaveLength(0);
  });

  it("o limite pode ser definido por pacote", async () => {
    const ctx = setup();
    await register(ctx, [POSTED], { max_transit_hours: 24 });
    const id = (await call(ctx.app, "/shipments", { tracking_code: CODE })).body.id;
    await call(ctx.app, `/shipments/${id}/sync`); // 48 h em trânsito, limite do pacote 24 h
    expect(ctx.notifier.notices).toHaveLength(1);
    expect(ctx.notifier.notices[0]).toMatchObject({ limit_hours: 24, elapsed_hours: 48 });
  });

  it("se o aviso falhar, a próxima checagem tenta de novo em vez de perder o alerta", async () => {
    const ctx = setup();
    const id = await register(ctx, [POSTED]);
    await call(ctx.app, `/shipments/${id}/sync`);
    at("2026-05-10T12:00:00.000Z");
    ctx.notifier.failNext = true;
    const failed = await call(ctx.app, "/delays/check");
    expect(failed.body.alerted).toEqual([]);
    const retried = await call(ctx.app, "/delays/check");
    expect(retried.body.alerted).toHaveLength(1);
    expect(ctx.notifier.notices).toHaveLength(1);
  });
});
