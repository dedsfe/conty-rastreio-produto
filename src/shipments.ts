import type { DatabaseSync } from "node:sqlite";
import type { NormalizedTracking, TrackingAggregator } from "./aggregator.ts";
import { evaluateDelay } from "./delay.ts";
import type { Notifier } from "./notifier.ts";
import { deriveStatus } from "./status.ts";
import type { Status } from "./status.ts";

type Row = Record<string, unknown>;

export type Config = { defaultMaxTransitHours: number };
export const DEFAULT_CONFIG: Config = { defaultMaxTransitHours: 168 }; // 7 dias

export type IngestSummary = {
  received: number;
  inserted: number;
  duplicates: number;
  unmapped: number; // eventos novos cujo status a transportadora inventou
  rejected: number; // ilegíveis (sem horário)
};

export class ShipmentService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly aggregator: TrackingAggregator,
    private readonly notifier: Notifier,
    private readonly clock: () => Date = () => new Date(),
    private readonly config: Config = DEFAULT_CONFIG,
  ) {}

  async register(input: { tracking_code: string; carrier: string | null; max_transit_hours: number | null }) {
    const existing = this.byCode(input.tracking_code);
    if (existing) return { created: false, id: String(existing.id) };
    await this.aggregator.register({ tracking_code: input.tracking_code, carrier: input.carrier });
    const id = `shp_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    this.db
      .prepare(
        "INSERT INTO shipments (id, tracking_code, carrier, max_transit_hours, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, input.tracking_code, input.carrier, input.max_transit_hours ?? this.config.defaultMaxTransitHours, this.clock().toISOString());
    return { created: true, id };
  }

  // Consulta o agregador e incorpora o que veio. Consultar de novo não duplica nada.
  async sync(shipmentId: string): Promise<IngestSummary | null> {
    const shipment = this.row(shipmentId);
    if (!shipment) return null;
    const tracking = await this.aggregator.fetch(String(shipment.tracking_code));
    return this.ingest(shipmentId, tracking);
  }

  // Webhook do agregador: mesmo caminho do sync depois de traduzido.
  async receiveWebhook(payload: unknown): Promise<{ shipment_id: string; summary: IngestSummary } | "unrecognized" | "unknown_shipment"> {
    const tracking = this.aggregator.parseWebhook(payload);
    if (!tracking) return "unrecognized";
    const shipment = this.byCode(tracking.tracking_code);
    if (!shipment) return "unknown_shipment";
    return { shipment_id: String(shipment.id), summary: await this.ingest(String(shipment.id), tracking) };
  }

  private async ingest(shipmentId: string, tracking: NormalizedTracking): Promise<IngestSummary> {
    const now = this.clock().toISOString();
    const summary: IngestSummary = {
      received: tracking.events.length + tracking.rejected,
      inserted: 0,
      duplicates: 0,
      unmapped: 0,
      rejected: tracking.rejected,
    };
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO shipment_events
         (shipment_id, event_key, occurred_at, status, raw_status, location, description, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec("BEGIN");
    try {
      for (const event of tracking.events) {
        const changes = insert.run(shipmentId, event.event_key, event.occurred_at, event.status, event.raw_status, event.location, event.description, now);
        if (Number(changes.changes) === 0) {
          summary.duplicates += 1;
          continue;
        }
        summary.inserted += 1;
        if (event.status === null) summary.unmapped += 1;
      }
      this.recompute(shipmentId, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    await this.alertIfLate(shipmentId);
    return summary;
  }

  // O estado do pacote é sempre recalculado do histórico inteiro, nunca "empilhado" na ordem de chegada.
  private recompute(shipmentId: string, now: string): void {
    const events = this.db
      .prepare("SELECT occurred_at, status FROM shipment_events WHERE shipment_id = ?")
      .all(shipmentId) as Array<{ occurred_at: string; status: Status | null }>;
    const derived = deriveStatus(events);
    const sorted = [...events].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
    const posted = sorted.find((event) => event.status === "posted");
    // Sem evento "postado", o início é o evento mais antigo que existir.
    const startedAt = posted?.occurred_at ?? sorted[0]?.occurred_at ?? null;
    const delivered = derived.status === "delivered" ? derived.at : null;
    this.db
      .prepare(
        `UPDATE shipments SET status = ?, status_at = ?, posted_at = ?, delivered_at = ?,
           unmapped_events = (SELECT COUNT(*) FROM shipment_events WHERE shipment_id = ? AND status IS NULL),
           last_synced_at = ? WHERE id = ?`,
      )
      .run(derived.status, derived.at, startedAt, delivered, shipmentId, now, shipmentId);
  }

  // ---------- atraso ----------

  private evaluate(row: Row) {
    return evaluateDelay({
      started_at: (row.posted_at as string | null) ?? null,
      delivered_at: (row.delivered_at as string | null) ?? null,
      now: this.clock(),
      limit_hours: Number(row.max_transit_hours),
    });
  }

  // Avisa uma única vez por pacote, e só enquanto ele não foi entregue.
  private async alertIfLate(shipmentId: string): Promise<boolean> {
    const row = this.row(shipmentId)!;
    const delay = this.evaluate(row);
    if (delay.state !== "late") return false;

    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO delay_alerts (shipment_id, alerted_at, elapsed_hours, limit_hours) VALUES (?, ?, ?, ?)")
      .run(shipmentId, this.clock().toISOString(), delay.elapsed_hours!, delay.limit_hours);
    if (Number(inserted.changes) === 0) return false;
    try {
      await this.notifier.notify({
        type: "shipment_delayed",
        shipment_id: shipmentId,
        tracking_code: String(row.tracking_code),
        status: (row.status as string | null) ?? null,
        elapsed_hours: delay.elapsed_hours!,
        limit_hours: delay.limit_hours,
      });
      return true;
    } catch {
      // Se o aviso falhou, libera para a próxima checagem tentar de novo, em vez de perder o alerta.
      this.db.prepare("DELETE FROM delay_alerts WHERE shipment_id = ?").run(shipmentId);
      return false;
    }
  }

  // Para rodar em agendamento: olha todo pacote ainda não entregue contra o relógio de agora.
  async checkDelays(): Promise<{ checked: number; alerted: string[] }> {
    const open = this.db.prepare("SELECT id FROM shipments WHERE delivered_at IS NULL").all() as Array<{ id: string }>;
    const alerted: string[] = [];
    for (const { id } of open) {
      if (await this.alertIfLate(id)) alerted.push(id);
    }
    return { checked: open.length, alerted };
  }

  // ---------- leitura ----------

  private row(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM shipments WHERE id = ?").get(id) as Row | undefined;
  }

  private byCode(code: string): Row | undefined {
    return this.db.prepare("SELECT * FROM shipments WHERE tracking_code = ?").get(code) as Row | undefined;
  }

  get(id: string) {
    const row = this.row(id);
    if (!row) return null;
    const events = this.db
      .prepare(
        "SELECT event_key, occurred_at, status, raw_status, location, description, received_at FROM shipment_events WHERE shipment_id = ? ORDER BY occurred_at, event_key",
      )
      .all(id) as Row[];
    const alert = this.db.prepare("SELECT alerted_at FROM delay_alerts WHERE shipment_id = ?").get(id) as { alerted_at: string } | undefined;
    return {
      id: String(row.id),
      tracking_code: String(row.tracking_code),
      carrier: (row.carrier as string | null) ?? null,
      status: (row.status as Status | null) ?? null,
      status_at: (row.status_at as string | null) ?? null,
      posted_at: (row.posted_at as string | null) ?? null,
      delivered_at: (row.delivered_at as string | null) ?? null,
      needs_review: Number(row.unmapped_events) > 0,
      last_synced_at: (row.last_synced_at as string | null) ?? null,
      delay: { ...this.evaluate(row), alerted_at: alert?.alerted_at ?? null },
      events: events.map((event) => ({ ...event, unmapped: event.status === null })),
    };
  }

  idByCode(code: string): string | null {
    const row = this.byCode(code);
    return row ? String(row.id) : null;
  }
}
