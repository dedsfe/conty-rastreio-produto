import type { Status } from "./status.ts";

// A fronteira com o agregador de rastreio. O resto do sistema só conhece estes tipos.
// Trocar de agregador é escrever outro adaptador que devolva isto; nada do formato dele vaza.

export type NormalizedEvent = {
  event_key: string; // identidade estável do evento: o mesmo evento repetido tem a mesma chave
  occurred_at: string; // ISO UTC
  status: Status | null; // null = status que não sabemos traduzir (não vira entregue)
  raw_status: string; // o que a transportadora escreveu, preservado
  location: string | null;
  description: string | null;
};

export type NormalizedTracking = {
  tracking_code: string;
  carrier: string | null;
  events: NormalizedEvent[];
  rejected: number; // eventos descartados por estarem ilegíveis (ex.: sem horário)
};

export interface TrackingAggregator {
  // Cadastra o código no agregador (assinatura de acompanhamento).
  register(input: { tracking_code: string; carrier: string | null }): Promise<void>;
  // Consulta o estado atual. Pode trazer eventos já vistos e fora de ordem.
  fetch(trackingCode: string): Promise<NormalizedTracking>;
  // Traduz o corpo bruto de um webhook do agregador. null se não for reconhecível.
  parseWebhook(payload: unknown): NormalizedTracking | null;
}

export class TrackingNotFoundError extends Error {
  constructor(code: string) {
    super(`código ${code} não encontrado no agregador`);
  }
}

export class AggregatorError extends Error {}
