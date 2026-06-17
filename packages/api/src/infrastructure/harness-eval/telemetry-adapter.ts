export interface EvalTraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
  events: ReadonlyArray<{
    name: string;
    timeMs: number;
    attributes?: Record<string, unknown>;
  }>;
}

export interface EvalTracesResponse {
  spans: EvalTraceSpan[];
  count: number;
}

export interface EvalMetricsSnapshot {
  timestamp: number;
  metrics: Record<string, number>;
}

export interface EvalMetricsHistoryResponse {
  snapshots: EvalMetricsSnapshot[];
  count: number;
}

export interface EvalTraceStoreStats {
  spanCount: number;
  maxSpans: number;
  maxAgeMs: number;
  oldestStoredAt: number | null;
  newestStoredAt: number | null;
}

export interface TelemetryAdapterConfig {
  baseUrl: string;
  cookie: string;
}

export function parseTracesResponse(json: unknown): EvalTracesResponse {
  const obj = json as Record<string, unknown>;
  if (!obj || typeof obj !== 'object') {
    throw new Error('Expected object for traces response');
  }
  if (!('spans' in obj)) {
    throw new Error('Expected spans field in traces response');
  }
  if (!Array.isArray(obj.spans)) {
    throw new Error('Expected spans to be an array in traces response');
  }
  const spans: EvalTraceSpan[] = (obj.spans as Record<string, unknown>[]).map((raw) => ({
    traceId: String(raw.traceId),
    spanId: String(raw.spanId),
    ...(raw.parentSpanId != null ? { parentSpanId: String(raw.parentSpanId) } : {}),
    name: String(raw.name),
    startTimeMs: Number(raw.startTimeMs),
    endTimeMs: Number(raw.endTimeMs),
    durationMs: Number(raw.durationMs),
    status: raw.status as { code: number; message?: string },
    attributes: (raw.attributes ?? {}) as Record<string, unknown>,
    events: Array.isArray(raw.events)
      ? (raw.events as Record<string, unknown>[]).map((e) => ({
          name: String(e.name),
          timeMs: Number(e.timeMs),
          ...(e.attributes != null ? { attributes: e.attributes as Record<string, unknown> } : {}),
        }))
      : [],
  }));
  return { spans, count: Number(obj.count ?? spans.length) };
}

export function parseMetricsHistoryResponse(json: unknown): EvalMetricsHistoryResponse {
  const obj = json as Record<string, unknown>;
  if (!obj || typeof obj !== 'object') {
    throw new Error('Expected object for metrics history response');
  }
  if (!('snapshots' in obj)) {
    throw new Error('Expected snapshots field in metrics history response');
  }
  if (!Array.isArray(obj.snapshots)) {
    throw new Error('Expected snapshots to be an array in metrics history response');
  }
  const snapshots: EvalMetricsSnapshot[] = (obj.snapshots as Record<string, unknown>[]).map((raw) => ({
    timestamp: Number(raw.timestamp),
    metrics: (raw.metrics ?? {}) as Record<string, number>,
  }));
  return { snapshots, count: Number(obj.count ?? snapshots.length) };
}

export function parseTraceStoreStats(json: unknown): EvalTraceStoreStats {
  const obj = json as Record<string, unknown>;
  if (!obj || typeof obj !== 'object') {
    throw new Error('Expected object for trace store stats');
  }
  if (!('spanCount' in obj)) {
    throw new Error('Expected spanCount field in trace store stats');
  }
  return {
    spanCount: Number(obj.spanCount),
    maxSpans: Number(obj.maxSpans),
    maxAgeMs: Number(obj.maxAgeMs),
    oldestStoredAt: obj.oldestStoredAt == null ? null : Number(obj.oldestStoredAt),
    newestStoredAt: obj.newestStoredAt == null ? null : Number(obj.newestStoredAt),
  };
}

export async function fetchTraces(
  config: TelemetryAdapterConfig,
  filter?: { catId?: string; limit?: number; expandLimit?: boolean },
): Promise<EvalTracesResponse> {
  const params = new URLSearchParams();
  if (filter?.catId) params.set('catId', filter.catId);
  if (filter?.limit) params.set('limit', String(filter.limit));
  // F192 verdict 2026-06-17-eval-a2a-c1-sample-window-build: opt-in cap raise
  // for scheduled eval. Only emit when explicitly true — `false`/undefined
  // omit the param so the server keeps its 500 default cap.
  if (filter?.expandLimit === true) params.set('expandLimit', 'true');
  const qs = params.toString();
  const url = `${config.baseUrl}/api/telemetry/traces${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: { cookie: config.cookie },
  });
  if (!res.ok) throw new Error(`fetchTraces failed: ${res.status}`);
  return parseTracesResponse(await res.json());
}

export async function fetchTracesStats(config: TelemetryAdapterConfig): Promise<EvalTraceStoreStats> {
  const res = await fetch(`${config.baseUrl}/api/telemetry/traces/stats`, { headers: { cookie: config.cookie } });
  if (!res.ok) throw new Error(`fetchTracesStats failed: ${res.status}`);
  return parseTraceStoreStats(await res.json());
}

export async function fetchMetrics(config: TelemetryAdapterConfig): Promise<string> {
  const res = await fetch(`${config.baseUrl}/api/telemetry/metrics`, {
    headers: { cookie: config.cookie },
  });
  if (!res.ok) throw new Error(`fetchMetrics failed: ${res.status}`);
  return res.text();
}

export async function fetchMetricsHistory(
  config: TelemetryAdapterConfig,
  since?: number,
): Promise<EvalMetricsHistoryResponse> {
  const params = new URLSearchParams();
  if (since != null) params.set('since', String(since));
  const qs = params.toString();
  const url = `${config.baseUrl}/api/telemetry/metrics/history${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: { cookie: config.cookie },
  });
  if (!res.ok) throw new Error(`fetchMetricsHistory failed: ${res.status}`);
  return parseMetricsHistoryResponse(await res.json());
}
