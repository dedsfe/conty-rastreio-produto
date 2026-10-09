import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  tracking_code TEXT NOT NULL UNIQUE,
  carrier TEXT,
  max_transit_hours INTEGER NOT NULL,
  registered_at TEXT NOT NULL,
  status TEXT,
  status_at TEXT,
  posted_at TEXT,
  delivered_at TEXT,
  unmapped_events INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT
);

-- O histórico guarda todo evento recebido. A chave (pacote, event_key) impede duplicar ao consultar de novo.
CREATE TABLE IF NOT EXISTS shipment_events (
  shipment_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  status TEXT,
  raw_status TEXT NOT NULL,
  location TEXT,
  description TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (shipment_id, event_key)
);

-- Um aviso de atraso por pacote, no máximo.
CREATE TABLE IF NOT EXISTS delay_alerts (
  shipment_id TEXT PRIMARY KEY,
  alerted_at TEXT NOT NULL,
  elapsed_hours REAL NOT NULL,
  limit_hours INTEGER NOT NULL
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
