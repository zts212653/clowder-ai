export interface HandoffSummary {
  invocationId: string;
  eventCount: number;
  toolCalls: string[];
  errors: number;
  durationMs: number;
  keyMessages: string[];
}

export interface RawEvent {
  eventNo: number;
  v: number;
  t: number;
  catId: string;
  event: Record<string, unknown>;
}
