// O vocabulário pequeno e estável do resto do sistema. Nenhum formato de transportadora ou
// de agregador aparece além da fronteira em src/trackhub/.
export const STATUSES = ["posted", "in_transit", "out_for_delivery", "delivered", "exception"] as const;
export type Status = (typeof STATUSES)[number];

export type StatusEvent = {
  occurred_at: string; // ISO UTC, horário do evento na transportadora
  status: Status | null; // null = a transportadora mandou algo que não sabemos traduzir
};

// Empate de horário: o que pesa mais. Exceção ganha de andamento normal porque precisa de atenção.
const TIE_PRIORITY: Record<Status, number> = { posted: 1, in_transit: 2, out_for_delivery: 3, exception: 4, delivered: 5 };

// Deriva o status do pacote a partir de TODOS os eventos, não da ordem em que chegaram.
//  - evento sem tradução (status null) não conta: nunca vira "entregue" por palpite;
//  - "entregue" é final: depois dele nenhum evento muda o status;
//  - fora isso vale o evento de horário mais recente. Um evento antigo que chega tarde tem horário
//    antigo, então não faz o status voltar;
//  - empate de horário: delivered > exception > out_for_delivery > in_transit > posted.
export function deriveStatus(events: StatusEvent[]): { status: Status | null; at: string | null } {
  const mapped = events.filter((event): event is { occurred_at: string; status: Status } => event.status !== null);
  if (mapped.length === 0) return { status: null, at: null };

  const delivered = mapped.filter((event) => event.status === "delivered").sort(byTime)[0];
  if (delivered) return { status: "delivered", at: delivered.occurred_at };

  const latest = [...mapped].sort((a, b) => byTime(b, a) || TIE_PRIORITY[b.status] - TIE_PRIORITY[a.status])[0]!;
  return { status: latest.status, at: latest.occurred_at };
}

function byTime(a: { occurred_at: string }, b: { occurred_at: string }): number {
  return Date.parse(a.occurred_at) - Date.parse(b.occurred_at);
}
