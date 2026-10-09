// Atraso = o pacote passou do limite de tempo em trânsito. O relógio para quando ele é entregue:
// quem chegou dentro do limite NUNCA vira atraso, por mais tempo que passe depois.
//
//   início  = horário do evento "postado" (se não houver, o evento mais antigo)
//   fim     = horário da entrega, se entregue; senão, agora
//   atraso  = (fim - início) > limite   (exatamente no limite ainda não é atraso)
export type DelayState =
  | "not_started" // ainda sem nenhum evento: não há de onde contar
  | "in_time" // em trânsito e dentro do limite
  | "late" // em trânsito e já passou do limite: é este que gera aviso
  | "delivered_on_time"
  | "delivered_late"; // chegou, mas passou do limite (só histórico, sem aviso)

export type DelayEvaluation = { state: DelayState; elapsed_hours: number | null; limit_hours: number };

export function evaluateDelay(input: {
  started_at: string | null;
  delivered_at: string | null;
  now: Date;
  limit_hours: number;
}): DelayEvaluation {
  const limitMs = input.limit_hours * 3_600_000;
  if (input.started_at === null) return { state: "not_started", elapsed_hours: null, limit_hours: input.limit_hours };

  const start = Date.parse(input.started_at);
  const end = input.delivered_at !== null ? Date.parse(input.delivered_at) : input.now.getTime();
  const elapsed = Math.max(0, end - start);
  const late = elapsed > limitMs;
  const state: DelayState =
    input.delivered_at !== null ? (late ? "delivered_late" : "delivered_on_time") : late ? "late" : "in_time";
  return { state, elapsed_hours: Math.round((elapsed / 3_600_000) * 100) / 100, limit_hours: input.limit_hours };
}
