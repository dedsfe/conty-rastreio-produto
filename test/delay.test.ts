import { describe, expect, it } from "vitest";
import { evaluateDelay } from "../src/delay.ts";

const POSTED = "2026-05-01T12:00:00.000Z";
const LIMIT = 48; // horas
const after = (hours: number, extraMs = 0) => new Date(Date.parse(POSTED) + hours * 3_600_000 + extraMs);

const inFlight = (now: Date) => evaluateDelay({ started_at: POSTED, delivered_at: null, now, limit_hours: LIMIT });
const delivered = (deliveredAt: Date, now: Date) =>
  evaluateDelay({ started_at: POSTED, delivered_at: deliveredAt.toISOString(), now, limit_hours: LIMIT });

describe("regra de atraso, com data controlada", () => {
  it("em trânsito dentro do limite não é atraso", () => {
    expect(inFlight(after(10)).state).toBe("in_time");
  });

  it("exatamente no limite ainda não é atraso; 1 ms depois é", () => {
    expect(inFlight(after(LIMIT)).state).toBe("in_time");
    expect(inFlight(after(LIMIT, 1)).state).toBe("late");
  });

  it("entrega normal NÃO vira atraso, por mais tempo que passe depois", () => {
    const result = delivered(after(30), after(24 * 90)); // entregue em 30 h; olhando 90 dias depois
    expect(result).toMatchObject({ state: "delivered_on_time", elapsed_hours: 30 });
  });

  it("entregue exatamente no limite é dentro do prazo", () => {
    expect(delivered(after(LIMIT), after(LIMIT + 500)).state).toBe("delivered_on_time");
  });

  it("entregue depois do limite fica registrado como entregue com atraso (sem aviso)", () => {
    expect(delivered(after(LIMIT + 5), after(LIMIT + 6)).state).toBe("delivered_late");
  });

  it("sem nenhum evento não há de onde contar", () => {
    expect(evaluateDelay({ started_at: null, delivered_at: null, now: after(1000), limit_hours: LIMIT })).toEqual({
      state: "not_started",
      elapsed_hours: null,
      limit_hours: LIMIT,
    });
  });

  it("horário de entrega anterior ao início (dado ruim) não gera tempo negativo nem atraso", () => {
    const result = evaluateDelay({ started_at: POSTED, delivered_at: "2026-04-30T00:00:00.000Z", now: after(5), limit_hours: LIMIT });
    expect(result).toMatchObject({ state: "delivered_on_time", elapsed_hours: 0 });
  });
});
