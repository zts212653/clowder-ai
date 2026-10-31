/**
 * F319 Served Model Provenance.
 *
 * The ChatGPT backend does not send the `openai-model` header that Codex uses
 * to raise its reroute warning, so the only place the upstream declares which
 * model actually answered is the Responses API object (`response.created` /
 * `response.completed` / `response.failed` → `response.model`). Stock Codex
 * 0.155.1 exposes those objects on stderr in two ways:
 *
 * - HTTPS transport: `RUST_LOG=codex_api::sse::responses=trace` prints one
 *   `SSE event: {...}` line per event.
 * - builtin websocket transport (Phase B.2): `RUST_LOG=tungstenite::protocol=trace`
 *   prints one `Received message {...}` line per frame. Frames also include
 *   `codex.response.metadata` whose `headers` carry the per-turn sticky-routing
 *   token `x-codex-turn-state` and the safety-buffering headers.
 *
 * This module turns those lines into an honest three-state fact: observed-same
 * / observed-different / unobserved. The declared model is the upstream's own
 * statement, not a fingerprint of the weights.
 */

import type { ProviderWarningSemanticEvent } from '@cat-cafe/shared';

export const CODEX_SERVED_MODEL_RUST_LOG_DIRECTIVE = 'codex_api::sse::responses=trace';
/** Phase B.2: websocket frames are only visible through tungstenite's protocol trace. */
export const CODEX_SERVED_MODEL_WS_RUST_LOG_DIRECTIVE = 'tungstenite::protocol=trace';
export const CODEX_SERVED_MODEL_RUST_LOG_DIRECTIVES = [
  CODEX_SERVED_MODEL_RUST_LOG_DIRECTIVE,
  CODEX_SERVED_MODEL_WS_RUST_LOG_DIRECTIVE,
] as const;
/**
 * `codex exec` only falls back to its own default filter when RUST_LOG is
 * unset, so an observation-only directive would silence every other crate's
 * error logs. Mirror the CLI default (`EXEC_DEFAULT_LOG_FILTER`, 0.155.1) and
 * add the trace directives on top.
 */
export const CODEX_SERVED_MODEL_RUST_LOG_DEFAULT = `error,opentelemetry_sdk=off,opentelemetry_otlp=off,${CODEX_SERVED_MODEL_RUST_LOG_DIRECTIVES.join(',')}`;
export const CODEX_SERVED_MODEL_SOURCES = ['sse_response_object', 'ws_response_object'] as const;
export type CodexServedModelSource = (typeof CODEX_SERVED_MODEL_SOURCES)[number];
/** Phase A name for the HTTPS source; the source now follows the transport. */
export const CODEX_SERVED_MODEL_SOURCE = 'sse_response_object' as const;

const SSE_EVENT_MARKER = 'SSE event: ';
const WS_FRAME_MARKER = 'tungstenite::protocol: Received message ';
const OBSERVED_EVENT_TYPES = new Set(['response.created', 'response.completed', 'response.failed']);
const METADATA_FRAME_TYPES = new Set(['codex.response.metadata', 'response.metadata']);
/**
 * A metadata frame precedes its own `response.created` by ~150 ms on the same
 * stream. Older pending frames are never attributed to a later response.
 */
export const CODEX_UPSTREAM_METADATA_ATTACH_WINDOW_MS = 5_000;

export interface CodexUpstreamMetadataFrame {
  /** Length of the `x-codex-turn-state` sticky-routing token; the token itself is never kept. */
  turnStateLength?: number;
  safetyBufferingEnabled?: boolean;
  safetyBufferingFasterModel?: string;
}

export interface CodexServedModelObservation {
  eventType: 'response.created' | 'response.completed' | 'response.failed';
  responseId: string;
  servedModel: string;
  source: CodexServedModelSource;
  promptCacheKey?: string;
  /** `response.safety_buffering` when the upstream sets it (seen on `response.completed`). */
  safetyBuffering?: boolean;
  /** Metadata frame attributed to this response (see the attach rules on tracker / registry). */
  upstream?: CodexUpstreamMetadataFrame;
}

export interface CodexServedModelSnapshot {
  servedModel: string;
  servedResponseId: string;
  servedModelSource: CodexServedModelSource;
  upstreamTurnStateLength?: number;
  upstreamSafetyBufferingFasterModel?: string;
  upstreamSafetyBuffering?: boolean;
}

export type CodexUpstreamTraceLine =
  | { kind: 'observation'; observation: CodexServedModelObservation }
  | { kind: 'metadata'; frame: CodexUpstreamMetadataFrame };

/**
 * Phase B.4: `codex app-server` never turns its fmt layer's ANSI colours off
 * (`codex exec` does when stderr is not a tty), so on the production carrier the
 * target and the `:` arrive split by SGR escapes and the websocket marker never
 * matched — the "app-server surfaces no frames" conclusion of Phase B.3 was this.
 * Stripping every SGR sequence is safe: a well-formed JSON payload cannot carry a
 * raw ESC (JSON escapes it as `\u001b`).
 */
const ANSI_SGR_PATTERN = /\u001b\[[0-9;]*m/g;

function extractTracePayload(rawLine: string): { raw: string; source: CodexServedModelSource } | undefined {
  const line = rawLine.includes('\u001b') ? rawLine.replace(ANSI_SGR_PATTERN, '') : rawLine;
  const ws = line.indexOf(WS_FRAME_MARKER);
  if (ws >= 0) return { raw: line.slice(ws + WS_FRAME_MARKER.length).trim(), source: 'ws_response_object' };
  const sse = line.indexOf(SSE_EVENT_MARKER);
  if (sse >= 0) return { raw: line.slice(sse + SSE_EVENT_MARKER.length).trim(), source: 'sse_response_object' };
  return undefined;
}

/**
 * Parse one stderr line from either transport. Returns `undefined` for
 * anything that is not a complete, well-formed frame we understand: that is
 * the "unobserved" state, never a default value.
 */
export function parseCodexUpstreamTraceLine(line: string): CodexUpstreamTraceLine | undefined {
  const payload = extractTracePayload(line);
  if (!payload || !payload.raw.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return undefined;
  if (METADATA_FRAME_TYPES.has(parsed.type)) {
    return { kind: 'metadata', frame: metadataFrameFromHeaders(isRecord(parsed.headers) ? parsed.headers : {}) };
  }
  if (!OBSERVED_EVENT_TYPES.has(parsed.type)) return undefined;
  const response = parsed.response;
  if (!isRecord(response)) return undefined;
  const responseId = response.id;
  const servedModel = response.model;
  if (typeof responseId !== 'string' || responseId.length === 0) return undefined;
  if (typeof servedModel !== 'string' || servedModel.length === 0) return undefined;
  const promptCacheKey = typeof response.prompt_cache_key === 'string' ? response.prompt_cache_key : undefined;
  return {
    kind: 'observation',
    observation: {
      eventType: parsed.type as CodexServedModelObservation['eventType'],
      responseId,
      servedModel,
      source: payload.source,
      ...(promptCacheKey ? { promptCacheKey } : {}),
      ...(typeof response.safety_buffering === 'boolean' ? { safetyBuffering: response.safety_buffering } : {}),
    },
  };
}

/** Observation-only view of a trace line (Phase A callers). */
export function parseCodexSseTraceLine(line: string): CodexServedModelObservation | undefined {
  const parsed = parseCodexUpstreamTraceLine(line);
  return parsed?.kind === 'observation' ? parsed.observation : undefined;
}

function metadataFrameFromHeaders(headers: Record<string, unknown>): CodexUpstreamMetadataFrame {
  const frame: CodexUpstreamMetadataFrame = {};
  const turnState = headerString(headers, 'x-codex-turn-state');
  if (turnState !== undefined) frame.turnStateLength = turnState.length;
  const enabled = headerString(headers, 'x-codex-safety-buffering-enabled');
  if (enabled === 'true' || enabled === 'false') frame.safetyBufferingEnabled = enabled === 'true';
  const faster = headerString(headers, 'x-codex-safety-buffering-faster-model');
  if (faster) frame.safetyBufferingFasterModel = faster;
  return frame;
}

function headerString(headers: Record<string, unknown>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

/** `response.completed` follows `response.created` for the same id; keep what only one of them carried. */
function mergeSameResponse(
  previous: CodexServedModelObservation | undefined,
  next: CodexServedModelObservation,
): CodexServedModelObservation {
  if (!previous || previous.responseId !== next.responseId) return next;
  const upstream = next.upstream ?? previous.upstream;
  const safetyBuffering = next.safetyBuffering ?? previous.safetyBuffering;
  return {
    ...next,
    ...(upstream ? { upstream } : {}),
    ...(safetyBuffering !== undefined ? { safetyBuffering } : {}),
  };
}

export function snapshotFromObservation(observation: CodexServedModelObservation): CodexServedModelSnapshot {
  const upstream = observation.upstream;
  return {
    servedModel: observation.servedModel,
    servedResponseId: observation.responseId,
    servedModelSource: observation.source,
    ...(upstream?.turnStateLength !== undefined ? { upstreamTurnStateLength: upstream.turnStateLength } : {}),
    ...(upstream?.safetyBufferingFasterModel
      ? { upstreamSafetyBufferingFasterModel: upstream.safetyBufferingFasterModel }
      : {}),
    ...(observation.safetyBuffering !== undefined ? { upstreamSafetyBuffering: observation.safetyBuffering } : {}),
  };
}

export interface CodexServedModelTracker {
  /** Feed one complete stderr line; anything else is ignored. */
  onStderrLine(line: string): void;
  /** Latest observation, or `undefined` when nothing was observed. */
  snapshot(): CodexServedModelSnapshot | undefined;
  /** Latest raw observation (event type, prompt cache key). */
  latest(): CodexServedModelObservation | undefined;
  observationCount(): number;
}

interface PendingMetadata {
  frame: CodexUpstreamMetadataFrame;
  at: number;
  /** Two frames arrived before any response claimed one: neither can be attributed honestly. */
  ambiguous: boolean;
}

function takePendingMetadata(pending: PendingMetadata | undefined, at: number): CodexUpstreamMetadataFrame | undefined {
  if (!pending || pending.ambiguous) return undefined;
  if (at - pending.at > CODEX_UPSTREAM_METADATA_ATTACH_WINDOW_MS) return undefined;
  return pending.frame;
}

function pushPendingMetadata(
  pending: PendingMetadata | undefined,
  frame: CodexUpstreamMetadataFrame,
  at: number,
): PendingMetadata {
  const stillPending = !!pending && at - pending.at <= CODEX_UPSTREAM_METADATA_ATTACH_WINDOW_MS;
  return { frame, at, ambiguous: stillPending };
}

/**
 * One tracker per `codex exec` process: a single turn, so a metadata frame
 * always belongs to the next response on the same stderr.
 */
export function createCodexServedModelTracker(options?: { now?: () => number }): CodexServedModelTracker {
  const now = options?.now ?? Date.now;
  let latest: CodexServedModelObservation | undefined;
  let pending: PendingMetadata | undefined;
  let count = 0;
  return {
    onStderrLine(line) {
      const parsed = parseCodexUpstreamTraceLine(line);
      if (!parsed) return;
      const at = now();
      if (parsed.kind === 'metadata') {
        // A single process never runs two turns at once: the newest frame is the one that matters.
        pending = { frame: parsed.frame, at, ambiguous: false };
        return;
      }
      const upstream = takePendingMetadata(pending, at);
      pending = undefined;
      latest = mergeSameResponse(latest, upstream ? { ...parsed.observation, upstream } : parsed.observation);
      count += 1;
    },
    snapshot() {
      return latest ? snapshotFromObservation(latest) : undefined;
    },
    latest: () => latest,
    observationCount: () => count,
  };
}

/**
 * F319 Phase B: app-server hosts serve many threads from one process, so the
 * trace lines on the host's stderr are correlated to a thread by
 * `prompt_cache_key` (Codex sets it to the thread id). The registry keeps the
 * latest observation per thread; consumers filter by `sinceMs` so an
 * observation from an earlier turn can never be attributed to a later one.
 * Metadata frames carry no thread key: one is attributed to the next response
 * on the host stream only when it is the sole pending frame inside the attach
 * window; concurrent turns make it ambiguous and it is dropped.
 */
export interface CodexHostServedModelEntry extends CodexServedModelObservation {
  /** Wall-clock time the line was ingested (process-local). */
  observedAt: number;
}

export interface CodexHostServedModelRegistry {
  /** Feed one complete stderr line from an app-server host; non-observations are ignored. */
  ingestStderrLine(line: string): void;
  /** Latest observation for a Codex thread id, or `undefined` (unobserved / too old). */
  lookup(codexThreadId: string, sinceMs?: number): CodexHostServedModelEntry | undefined;
  size(): number;
}

export const DEFAULT_CODEX_HOST_SERVED_MODEL_MAX_ENTRIES = 2000;

export function createCodexHostServedModelRegistry(options?: {
  maxEntries?: number;
  now?: () => number;
}): CodexHostServedModelRegistry {
  const maxEntries = options?.maxEntries ?? DEFAULT_CODEX_HOST_SERVED_MODEL_MAX_ENTRIES;
  const now = options?.now ?? Date.now;
  const entries = new Map<string, CodexHostServedModelEntry>();
  let pending: PendingMetadata | undefined;
  return {
    ingestStderrLine(line) {
      const parsed = parseCodexUpstreamTraceLine(line);
      if (!parsed) return;
      const at = now();
      if (parsed.kind === 'metadata') {
        pending = pushPendingMetadata(pending, parsed.frame, at);
        return;
      }
      const upstream = takePendingMetadata(pending, at);
      pending = undefined;
      const observation = upstream ? { ...parsed.observation, upstream } : parsed.observation;
      if (!observation.promptCacheKey) return;
      const merged = mergeSameResponse(entries.get(observation.promptCacheKey), observation);
      // Re-insert so Map iteration order doubles as recency for eviction.
      entries.delete(observation.promptCacheKey);
      entries.set(observation.promptCacheKey, { ...merged, observedAt: at });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    lookup(codexThreadId, sinceMs) {
      const entry = entries.get(codexThreadId);
      if (!entry) return undefined;
      if (sinceMs !== undefined && entry.observedAt < sinceMs) return undefined;
      return entry;
    },
    size: () => entries.size,
  };
}

/** Process-wide registry fed by every Codex app-server host's stderr. */
export const codexHostServedModels: CodexHostServedModelRegistry = createCodexHostServedModelRegistry();

export function snapshotFromHostEntry(entry: CodexHostServedModelEntry): CodexServedModelSnapshot {
  return snapshotFromObservation(entry);
}

export function servedModelMatchesRequest(requestedModel: string, servedModel: string): boolean {
  return requestedModel.trim().toLowerCase() === servedModel.trim().toLowerCase();
}

export function buildCodexServedModelMismatchEvent(input: {
  catId: string;
  requestedModel: string;
  servedModel: string;
  servedResponseId: string;
  occurredAt: number;
  invocationId?: string;
  eventType?: CodexServedModelObservation['eventType'];
  carrier?: 'exec' | 'app_server';
}): ProviderWarningSemanticEvent | undefined {
  if (servedModelMatchesRequest(input.requestedModel, input.servedModel)) return undefined;
  return {
    v: 1,
    id: `served-model:codex:${input.catId}:${input.servedResponseId}`,
    kind: 'warning',
    category: 'model_reroute',
    severity: 'warning',
    occurredAt: input.occurredAt,
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    message: `请求 ${input.requestedModel}，上游实际应答 ${input.servedModel}（response ${input.servedResponseId}）。这条回复来自不同的模型，签名不变但判断请按 ${input.servedModel} 看待。`,
    provenance: {
      provider: 'codex',
      carrier: input.carrier ?? 'exec',
      nativeType: input.eventType ?? 'response.created',
    },
  };
}

/** Add the trace directives to an operator-supplied RUST_LOG without clobbering it. */
export function mergeRustLogDirective(existing: string | undefined): string {
  const current = (existing ?? '').trim();
  if (!current) return CODEX_SERVED_MODEL_RUST_LOG_DEFAULT;
  const parts = current.split(',').map((part) => part.trim());
  const missing = CODEX_SERVED_MODEL_RUST_LOG_DIRECTIVES.filter((directive) => !parts.includes(directive));
  if (missing.length === 0) return current;
  return `${current},${missing.join(',')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const SERVED_FACT_KEYS = [
  'servedModel',
  'servedResponseId',
  'servedModelSource',
  'upstreamTurnStateLength',
  'upstreamSafetyBufferingFasterModel',
  'upstreamSafetyBuffering',
] as const;

type ServedFactKey = (typeof SERVED_FACT_KEYS)[number];

/**
 * Phase E.1: the served facts of a finished turn, for the live `invocation_usage` channel.
 * Returns `{ served }` only when the turn was observed (`servedModel` present); otherwise `{}`
 * so an unobserved turn carries no `served` key at all (never an empty default).
 */
export function servedFactsPayload(metadata: Partial<Record<ServedFactKey, unknown>> | undefined): {
  served?: Partial<Record<ServedFactKey, unknown>>;
} {
  if (!metadata || typeof metadata.servedModel !== 'string' || metadata.servedModel.length === 0) return {};
  const served: Partial<Record<ServedFactKey, unknown>> = {};
  for (const key of SERVED_FACT_KEYS) {
    if (metadata[key] !== undefined) served[key] = metadata[key];
  }
  return { served };
}
