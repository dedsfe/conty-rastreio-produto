export type DelayNotice = {
  type: "shipment_delayed";
  shipment_id: string;
  tracking_code: string;
  status: string | null;
  elapsed_hours: number;
  limit_hours: number;
};

export interface Notifier {
  notify(notice: DelayNotice): Promise<void>;
}

export class ConsoleNotifier implements Notifier {
  async notify(notice: DelayNotice): Promise<void> {
    console.log(JSON.stringify(notice));
  }
}

export class MemoryNotifier implements Notifier {
  readonly notices: DelayNotice[] = [];
  failNext = false;
  async notify(notice: DelayNotice): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("falha ao avisar");
    }
    this.notices.push(notice);
  }
}
