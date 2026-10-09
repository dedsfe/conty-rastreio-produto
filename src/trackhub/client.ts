import { AggregatorError, TrackingNotFoundError } from "../aggregator.ts";
import type { NormalizedTracking, TrackingAggregator } from "../aggregator.ts";
import { normalizeTracking } from "./normalize.ts";

// O transporte HTTP também fica atrás de uma interface: em produção seria `fetch`, nos testes é um falso.
export interface HttpTransport {
  request(method: "GET" | "POST", url: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

export class TrackHubClient implements TrackingAggregator {
  constructor(
    private readonly http: HttpTransport,
    private readonly baseUrl = "https://api.trackhub.example/v1",
  ) {}

  async register(input: { tracking_code: string; carrier: string | null }): Promise<void> {
    const res = await this.http.request("POST", `${this.baseUrl}/trackings`, {
      tracking_number: input.tracking_code,
      courier: input.carrier,
    });
    // 409 = já cadastrado lá: para nós é o mesmo que ter dado certo.
    if (res.status >= 400 && res.status !== 409) throw new AggregatorError(`agregador recusou o cadastro (${res.status})`);
  }

  async fetch(trackingCode: string): Promise<NormalizedTracking> {
    const res = await this.http.request("GET", `${this.baseUrl}/trackings/${encodeURIComponent(trackingCode)}`);
    if (res.status === 404) throw new TrackingNotFoundError(trackingCode);
    if (res.status >= 400) throw new AggregatorError(`agregador respondeu ${res.status}`);
    const tracking = normalizeTracking(res.json);
    if (!tracking) throw new AggregatorError("resposta do agregador em formato desconhecido");
    return tracking;
  }

  parseWebhook(payload: unknown): NormalizedTracking | null {
    return normalizeTracking(payload);
  }
}
