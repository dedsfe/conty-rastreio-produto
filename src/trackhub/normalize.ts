import { createHash } from "node:crypto";
import type { NormalizedEvent, NormalizedTracking } from "../aggregator.ts";
import { translate } from "./dialects.ts";

// Formato BRUTO do agregador fictício "TrackHub". Só este diretório conhece esta forma.
//
//   {
//     "data": {
//       "tracking_number": "BR123456789BR",
//       "courier": "correios",
//       "checkpoints": [
//         { "id": "cp_1", "checkpoint_time": "2026-05-03T09:12:00-03:00",
//           "courier_status": "Objeto postado", "city": "Sao Paulo", "state": "SP", "detail": "..." }
//       ]
//     }
//   }
type RawCheckpoint = {
  id?: unknown;
  checkpoint_time?: unknown;
  courier_status?: unknown;
  city?: unknown;
  state?: unknown;
  detail?: unknown;
};

export function normalizeTracking(raw: unknown): NormalizedTracking | null {
  const data = (raw as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data.tracking_number !== "string") return null;
  const courier = typeof data.courier === "string" ? data.courier : null;
  const checkpoints = Array.isArray(data.checkpoints) ? (data.checkpoints as RawCheckpoint[]) : [];

  const events: NormalizedEvent[] = [];
  let rejected = 0;
  for (const checkpoint of checkpoints) {
    const event = normalizeCheckpoint(courier, checkpoint);
    if (event) events.push(event);
    else rejected += 1;
  }
  return { tracking_code: data.tracking_number, carrier: courier, events, rejected };
}

function normalizeCheckpoint(courier: string | null, cp: RawCheckpoint): NormalizedEvent | null {
  // Sem horário legível não dá para ordenar: descarta em vez de inventar um horário.
  if (typeof cp.checkpoint_time !== "string" || typeof cp.courier_status !== "string") return null;
  const time = new Date(cp.checkpoint_time);
  if (Number.isNaN(time.getTime())) return null;

  const location = [cp.city, cp.state].filter((part): part is string => typeof part === "string" && part !== "").join(", ");
  const occurredAt = time.toISOString();
  // Identidade do evento: o id do agregador, ou, se faltar, um resumo do conteúdo.
  const eventKey =
    typeof cp.id === "string" && cp.id !== ""
      ? `id:${cp.id}`
      : `h:${createHash("sha1").update(`${occurredAt}|${cp.courier_status}|${location}`).digest("hex").slice(0, 16)}`;

  return {
    event_key: eventKey,
    occurred_at: occurredAt,
    status: translate(courier, cp.courier_status),
    raw_status: cp.courier_status,
    location: location || null,
    description: typeof cp.detail === "string" ? cp.detail : null,
  };
}
