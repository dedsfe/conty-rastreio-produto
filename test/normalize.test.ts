import { describe, expect, it } from "vitest";
import { normalizeTracking } from "../src/trackhub/normalize.ts";
import { translate } from "../src/trackhub/dialects.ts";
import { rawTracking } from "../src/trackhub/fake-transport.ts";

const one = (courier: string, status: string, time = "2026-05-03T09:12:00-03:00") =>
  normalizeTracking(rawTracking("BR123456789BR", courier, [{ id: "cp_1", time, status }]))!.events[0]!;

describe("dialetos das transportadoras", () => {
  it.each([
    ["correios", "Objeto postado", "posted"],
    ["correios", "Objeto em trânsito - por favor aguarde", "in_transit"],
    ["correios", "Objeto saiu para entrega ao destinatário", "out_for_delivery"],
    ["correios", "Objeto entregue ao destinatário", "delivered"],
    ["correios", "  OBJETO   ENTREGUE ao destinatario ", "delivered"],
    ["correios", "Objeto não entregue - carteiro não atendido", "exception"],
    ["jadlog", "COLETADO", "posted"],
    ["jadlog", "SAIU_ENTREGA", "out_for_delivery"],
    ["jadlog", "ENTREGUE", "delivered"],
    ["jadlog", "OCORRENCIA", "exception"],
    ["dhl", "pre-transit", "posted"],
    ["dhl", "transit", "in_transit"],
    ["dhl", "delivered", "delivered"],
    ["dhl", "failure", "exception"],
  ])("%s: %s vira %s", (courier, raw, expected) => {
    expect(translate(courier, raw)).toBe(expected);
  });

  it('"Objeto não entregue" NÃO vira entregue (a busca é exata, não por trecho)', () => {
    expect(translate("correios", "Objeto não entregue - carteiro não atendido")).not.toBe("delivered");
    expect(translate("correios", "Objeto entregue ao destinatário mas com avaria")).toBeNull();
  });

  it("status que a transportadora inventou não vira nada, e muito menos entregue", () => {
    expect(translate("correios", "Objeto teletransportado")).toBeNull();
    expect(translate("jadlog", "ENTREGUE_TALVEZ")).toBeNull();
  });

  it("transportadora desconhecida: nenhum status é traduzido, nem um literalmente 'delivered'", () => {
    expect(translate("transportadora_nova", "delivered")).toBeNull();
    expect(translate(null, "ENTREGUE")).toBeNull();
  });
});

describe("normalização do payload bruto", () => {
  it("converte o horário com fuso para UTC e monta o evento normalizado", () => {
    const event = one("correios", "Objeto postado");
    expect(event).toMatchObject({
      event_key: "id:cp_1",
      occurred_at: "2026-05-03T12:12:00.000Z",
      status: "posted",
      raw_status: "Objeto postado",
    });
  });

  it("preserva o texto bruto mesmo quando não traduz", () => {
    expect(one("correios", "Objeto teletransportado")).toMatchObject({ status: null, raw_status: "Objeto teletransportado" });
  });

  it("sem id do agregador, a chave vem do conteúdo e é estável", () => {
    const a = normalizeTracking(rawTracking("BR123456789BR", "correios", [{ time: "2026-05-03T09:12:00-03:00", status: "Objeto postado", city: "SP" }]))!;
    const b = normalizeTracking(rawTracking("BR123456789BR", "correios", [{ time: "2026-05-03T12:12:00Z", status: "Objeto postado", city: "SP" }]))!;
    expect(a.events[0]!.event_key).toMatch(/^h:/);
    expect(a.events[0]!.event_key).toBe(b.events[0]!.event_key); // mesmo instante, fusos diferentes
  });

  it("descarta evento sem horário legível em vez de inventar um", () => {
    const tracking = normalizeTracking(
      rawTracking("BR123456789BR", "correios", [
        { id: "ok", time: "2026-05-03T09:12:00-03:00", status: "Objeto postado" },
        { id: "ruim", time: "ontem", status: "Objeto entregue ao destinatário" },
      ]),
    )!;
    expect(tracking.events).toHaveLength(1);
    expect(tracking.rejected).toBe(1);
  });

  it("formato desconhecido devolve null", () => {
    expect(normalizeTracking({ foo: 1 })).toBeNull();
    expect(normalizeTracking(null)).toBeNull();
  });
});
