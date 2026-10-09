import { describe, expect, it } from "vitest";
import { deriveStatus } from "../src/status.ts";
import type { Status, StatusEvent } from "../src/status.ts";

const ev = (occurred_at: string, status: Status | null): StatusEvent => ({ occurred_at, status });

describe("status derivado do histórico", () => {
  it("sem eventos, ou só com eventos sem tradução, não há status", () => {
    expect(deriveStatus([])).toEqual({ status: null, at: null });
    expect(deriveStatus([ev("2026-05-01T10:00:00Z", null)])).toEqual({ status: null, at: null });
  });

  it("vale o evento de horário mais recente, não o último a chegar", () => {
    const arrivedInOrder = [ev("2026-05-01T10:00:00Z", "posted"), ev("2026-05-02T10:00:00Z", "in_transit"), ev("2026-05-03T10:00:00Z", "out_for_delivery")];
    const arrivedShuffled = [arrivedInOrder[2]!, arrivedInOrder[0]!, arrivedInOrder[1]!];
    expect(deriveStatus(arrivedInOrder).status).toBe("out_for_delivery");
    expect(deriveStatus(arrivedShuffled).status).toBe("out_for_delivery");
  });

  it("evento antigo que chega depois não faz o status voltar", () => {
    const afterOutForDelivery = [ev("2026-05-03T10:00:00Z", "out_for_delivery"), ev("2026-05-01T10:00:00Z", "posted")];
    expect(deriveStatus(afterOutForDelivery).status).toBe("out_for_delivery");
  });

  it("entregue é final: nenhum evento depois dele muda o status, nem um com horário mais novo", () => {
    const events = [ev("2026-05-03T10:00:00Z", "delivered"), ev("2026-05-04T10:00:00Z", "in_transit"), ev("2026-05-05T10:00:00Z", "exception")];
    expect(deriveStatus(events)).toEqual({ status: "delivered", at: "2026-05-03T10:00:00Z" });
  });

  it("entregue que chega por último, mas aconteceu antes de eventos mais antigos chegarem, continua entregue", () => {
    expect(deriveStatus([ev("2026-05-02T10:00:00Z", "in_transit"), ev("2026-05-03T10:00:00Z", "delivered")]).status).toBe("delivered");
  });

  it("exceção seguida de andamento mais novo se recupera; andamento mais antigo não derruba a exceção", () => {
    expect(deriveStatus([ev("2026-05-02T10:00:00Z", "exception"), ev("2026-05-03T10:00:00Z", "in_transit")]).status).toBe("in_transit");
    expect(deriveStatus([ev("2026-05-03T10:00:00Z", "exception"), ev("2026-05-02T10:00:00Z", "in_transit")]).status).toBe("exception");
  });

  it("evento sem tradução no meio não muda o status nem vira entregue", () => {
    const events = [ev("2026-05-01T10:00:00Z", "posted"), ev("2026-05-02T10:00:00Z", null)];
    expect(deriveStatus(events)).toEqual({ status: "posted", at: "2026-05-01T10:00:00Z" });
  });

  it("empate de horário: entregue > exceção > saiu para entrega > em trânsito > postado", () => {
    const t = "2026-05-02T10:00:00Z";
    expect(deriveStatus([ev(t, "in_transit"), ev(t, "exception")]).status).toBe("exception");
    expect(deriveStatus([ev(t, "exception"), ev(t, "out_for_delivery")]).status).toBe("exception");
    expect(deriveStatus([ev(t, "posted"), ev(t, "in_transit")]).status).toBe("in_transit");
    expect(deriveStatus([ev(t, "exception"), ev(t, "delivered")]).status).toBe("delivered");
  });
});
