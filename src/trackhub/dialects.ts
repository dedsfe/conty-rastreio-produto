import type { Status } from "../status.ts";

// Cada transportadora fala um dialeto. Estas tabelas são a única tradução para o vocabulário
// interno. A busca é por texto EXATO (depois de normalizar), nunca por trecho: "Objeto não entregue"
// contém "entregue" e não pode virar entregue.
export function clean(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const CORREIOS: Record<string, Status> = {
  "objeto postado": "posted",
  "objeto em transito - por favor aguarde": "in_transit",
  "objeto encaminhado": "in_transit",
  "objeto saiu para entrega ao destinatario": "out_for_delivery",
  "objeto entregue ao destinatario": "delivered",
  "objeto nao entregue - carteiro nao atendido": "exception",
  "objeto devolvido ao remetente": "exception",
};

const JADLOG: Record<string, Status> = {
  coletado: "posted",
  em_transito: "in_transit",
  saiu_entrega: "out_for_delivery",
  entregue: "delivered",
  ocorrencia: "exception",
};

const DHL: Record<string, Status> = {
  "pre-transit": "posted",
  transit: "in_transit",
  "out-for-delivery": "out_for_delivery",
  delivered: "delivered",
  failure: "exception",
  exception: "exception",
};

const DIALECTS: Record<string, Record<string, Status>> = { correios: CORREIOS, jadlog: JADLOG, dhl: DHL };

// Transportadora desconhecida ou texto desconhecido devolve null: sem tradução, nunca palpite.
export function translate(courier: string | null, rawStatus: string): Status | null {
  if (!courier) return null;
  const table = DIALECTS[clean(courier)];
  return table?.[clean(rawStatus)] ?? null;
}
