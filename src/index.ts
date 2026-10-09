import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { TrackHubClient } from "./trackhub/client.ts";
import { FakeTrackHub, rawTracking } from "./trackhub/fake-transport.ts";

// Demonstração: um agregador fictício com dois pacotes (um entregue, um com status inventado).
const hub = new FakeTrackHub();
hub.setTracking(
  "BR123456789BR",
  rawTracking("BR123456789BR", "correios", [
    { id: "cp_1", time: "2026-05-03T09:12:00-03:00", status: "Objeto postado", city: "Sao Paulo", state: "SP" },
    { id: "cp_2", time: "2026-05-04T08:00:00-03:00", status: "Objeto em trânsito - por favor aguarde", city: "Curitiba", state: "PR" },
    { id: "cp_3", time: "2026-05-05T10:30:00-03:00", status: "Objeto entregue ao destinatário", city: "Curitiba", state: "PR" },
  ]),
);
hub.setTracking(
  "JD998877665544",
  rawTracking("JD998877665544", "jadlog", [
    { id: "cp_1", time: "2026-05-03T09:00:00-03:00", status: "COLETADO" },
    { id: "cp_2", time: "2026-05-04T09:00:00-03:00", status: "STATUS_NOVO_DA_JADLOG" },
  ]),
);

const port = Number(process.env.PORT ?? 3007);
const app = createApp({ db: openDatabase(process.env.DB_PATH ?? ":memory:"), aggregator: new TrackHubClient(hub) });
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(`API de rastreio em http://127.0.0.1:${port} (agregador simulado: BR123456789BR, JD998877665544)`);
