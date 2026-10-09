import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { AggregatorError, TrackingNotFoundError } from "./aggregator.ts";
import type { TrackingAggregator } from "./aggregator.ts";
import { ConsoleNotifier } from "./notifier.ts";
import type { Notifier } from "./notifier.ts";
import { DEFAULT_CONFIG, ShipmentService } from "./shipments.ts";
import type { Config } from "./shipments.ts";

export type AppOptions = {
  db: DatabaseSync;
  aggregator: TrackingAggregator;
  notifier?: Notifier;
  clock?: () => Date;
  config?: Config;
};

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function createApp(options: AppOptions) {
  const service = new ShipmentService(
    options.db,
    options.aggregator,
    options.notifier ?? new ConsoleNotifier(),
    options.clock,
    options.config ?? DEFAULT_CONFIG,
  );
  const app = new Hono();

  const upstream = (c: Context, error: unknown) => {
    if (error instanceof TrackingNotFoundError) return c.json({ error: "código não encontrado no agregador" }, 404);
    if (error instanceof AggregatorError) return c.json({ error: error.message }, 502);
    throw error;
  };

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/shipments", async (c) => {
    const body = await readBody(c);
    const code = typeof body.tracking_code === "string" ? body.tracking_code.trim() : "";
    if (!/^[A-Za-z0-9-]{6,40}$/.test(code)) return c.json({ error: "tracking_code inválido (6 a 40 letras, números ou hífen)" }, 400);
    const limit = body.max_transit_hours;
    if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 24 * 90)) {
      return c.json({ error: "max_transit_hours deve ser um inteiro entre 1 e 2160" }, 400);
    }
    try {
      const result = await service.register({
        tracking_code: code,
        carrier: typeof body.carrier === "string" && body.carrier.trim() ? body.carrier.trim().toLowerCase() : null,
        max_transit_hours: typeof limit === "number" ? limit : null,
      });
      return c.json(service.get(result.id), result.created ? 201 : 200);
    } catch (error) {
      return upstream(c, error);
    }
  });

  app.post("/shipments/:id/sync", async (c) => {
    try {
      const summary = await service.sync(c.req.param("id"));
      if (!summary) return c.json({ error: "pacote não encontrado" }, 404);
      return c.json({ summary, shipment: service.get(c.req.param("id")) });
    } catch (error) {
      return upstream(c, error);
    }
  });

  app.get("/shipments/:id", (c) => {
    const shipment = service.get(c.req.param("id"));
    return shipment ? c.json(shipment) : c.json({ error: "pacote não encontrado" }, 404);
  });

  app.post("/webhooks/tracking", async (c) => {
    const result = await service.receiveWebhook(await c.req.json().catch(() => null));
    if (result === "unrecognized") return c.json({ error: "payload não reconhecido" }, 400);
    if (result === "unknown_shipment") return c.json({ error: "código não cadastrado" }, 404);
    return c.json({ summary: result.summary, shipment: service.get(result.shipment_id) });
  });

  app.post("/delays/check", async (c) => c.json(await service.checkDelays()));

  return app;
}
