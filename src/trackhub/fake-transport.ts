import type { HttpTransport } from "./client.ts";

// Agregador de mentira: guarda a resposta bruta por código e a devolve como o de verdade faria.
export class FakeTrackHub implements HttpTransport {
  readonly requests: Array<{ method: string; url: string }> = [];
  private readonly trackings = new Map<string, unknown>();
  private failures: number[] = [];

  setTracking(code: string, payload: unknown): void {
    this.trackings.set(code, payload);
  }

  failNext(...statuses: number[]): void {
    this.failures.push(...statuses);
  }

  async request(method: "GET" | "POST", url: string): Promise<{ status: number; json: unknown }> {
    this.requests.push({ method, url });
    const failure = this.failures.shift();
    if (failure) return { status: failure, json: { error: "falha simulada" } };
    if (method === "POST") return { status: 201, json: { ok: true } };
    const code = decodeURIComponent(url.split("/").pop()!);
    return this.trackings.has(code)
      ? { status: 200, json: this.trackings.get(code) }
      : { status: 404, json: { error: "not found" } };
  }
}

// Monta o corpo bruto do TrackHub para testes e demonstração.
export function rawTracking(
  code: string,
  courier: string,
  checkpoints: Array<{ id?: string; time: string; status: string; city?: string; state?: string; detail?: string }>,
) {
  return {
    data: {
      tracking_number: code,
      courier,
      checkpoints: checkpoints.map((cp) => ({
        id: cp.id,
        checkpoint_time: cp.time,
        courier_status: cp.status,
        city: cp.city,
        state: cp.state,
        detail: cp.detail,
      })),
    },
  };
}
