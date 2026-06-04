/**
 * F153 Phase F AC-F4/F5: Hydrate LocalTraceStore from Redis messages on cold start.
 *
 * Pointer-only restoration: scans recent messages, extracts tracing pointers
 * from extra.tracing, and creates stub DTOs with real timing.
 *
 * F153 Phase J Slice J-B AC-J8: additionally reads `toolEvents[]` on each message
 * and synthesizes real-duration `cat_cafe.tool_use {toolName}` child spans by
 * pairing `tool_use` (startTimeMs) with matching `tool_result` (endTimeMs) by
 * `toolUseId`. Each synthesized span carries the persisted `tracing` pointer so
 * the hydrated trace shows the tool span under the invocation span — not as an
 * orphan trace or a flat `cat_cafe.invocation.restored` marker (KD-39 boundary).
 *
 * For providers without Phase J wiring (no toolUseId / tracing), tool events are
 * skipped on hydrate per KD-41 honesty (no fake duration). They still appear in
 * the message history view via existing UI paths.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { StoredToolEvent } from '../../domains/cats/services/stores/ports/MessageStore.js';
import { safeParseExtra, safeParseToolEvents } from '../../domains/cats/services/stores/redis/redis-message-parsers.js';
import { MessageKeys } from '../../domains/cats/services/stores/redis-keys/message-keys.js';
import { createModuleLogger } from '../logger.js';
import { LOCAL_TRACE_STORE_DEFAULT_MAX_AGE_MS, type LocalTraceStore, type TraceSpanDTO } from './local-trace-store.js';

/**
 * F153 Phase J Slice J-B AC-J8: pair tool_use / tool_result events by toolUseId and
 * synthesize one `cat_cafe.tool_use {toolName}` span per pair with real duration.
 *
 * Exported for unit testing — the loop is pure (no Redis / store side effects), so
 * tests can drive it directly with crafted StoredToolEvent[] inputs.
 */
export function synthesizeToolSpansFromEvents(
  events: readonly StoredToolEvent[],
  catId: string | undefined,
  storedAt: number,
): TraceSpanDTO[] {
  // Index tool_use events by toolUseId so tool_result can find its mate.
  // 云端 Codex P2: preserve FIRST tool_use on duplicate id (mirrors
  // ToolSpanTracker.start() which is a no-op for duplicates, keeping the
  // original span's start time). Without this, a re-emitted later tool_use
  // would overwrite the earlier entry → under-reported duration or even
  // a pair drop when the duplicate timestamp lands after the result.
  const starts = new Map<string, StoredToolEvent>();
  for (const ev of events) {
    if (ev.type === 'tool_use' && ev.toolUseId && !starts.has(ev.toolUseId)) {
      starts.set(ev.toolUseId, ev);
    }
  }

  const dtos: TraceSpanDTO[] = [];
  for (const ev of events) {
    // 砚砚 R1 P2-1: enforce the four-piece set including status. Missing
    // status falls back to legacy invocation.restored on the parent, not
    // a fake UNSET tool span (KD-41 honesty: don't materialize what we
    // don't actually know). Explicit `status: 'unknown'` is allowed and
    // maps to UNSET — the caller deliberately surfaced ambiguity.
    if (ev.type !== 'tool_result' || !ev.toolUseId || !ev.tracing || !ev.status) continue;
    const startEv = starts.get(ev.toolUseId);
    if (!startEv || !startEv.tracing) continue;

    const startTimeMs = startEv.startTimeMs ?? startEv.timestamp;
    const endTimeMs = ev.endTimeMs ?? ev.timestamp;
    if (!(endTimeMs > startTimeMs)) continue; // sanity guard: must have positive duration

    // R6 maintainer: prefer the persisted `toolName` data field; fall back to
    // parsing the display `label` only for legacy stored events (pre-R6 wiring).
    // This decouples hydrate from UI/display contract — label format changes
    // (arrow→colon, localization, shortening) no longer silently degrade traces
    // to `unknown` or the wrong tool name.
    let toolName = startEv.toolName;
    if (!toolName) {
      const arrowIdx = startEv.label.indexOf(' → ');
      toolName = arrowIdx > 0 ? startEv.label.slice(arrowIdx + 3) : 'unknown';
    }

    const attributes: Record<string, unknown> = { 'tool.use_id': ev.toolUseId };
    if (catId) attributes['agent.id'] = catId;
    if (ev.status) attributes['tool.result.status'] = ev.status;

    // OTel status: 2 = ERROR, 1 = OK, 0 = UNSET. Hydrated spans default UNSET for
    // 'unknown' status (matches KD-38 honesty: surface ambiguity, don't fake OK).
    const statusCode: 0 | 1 | 2 = ev.status === 'error' ? 2 : ev.status === 'ok' ? 1 : 0;

    dtos.push({
      traceId: startEv.tracing.traceId,
      spanId: startEv.tracing.spanId,
      parentSpanId: startEv.tracing.parentSpanId,
      name: `cat_cafe.tool_use ${toolName}`,
      kind: 0,
      startTimeMs,
      endTimeMs,
      durationMs: endTimeMs - startTimeMs,
      status: { code: statusCode },
      attributes,
      events: [],
      storedAt,
    });
  }
  return dtos;
}

const log = createModuleLogger('telemetry:hydrate');

const MAX_SCAN = 500;

export async function hydrateTraceStoreFromRedis(
  traceStore: LocalTraceStore,
  redis: RedisClient,
  maxAgeMs = LOCAL_TRACE_STORE_DEFAULT_MAX_AGE_MS,
): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;

  try {
    const ids = await redis.zrevrangebyscore(MessageKeys.TIMELINE, '+inf', String(cutoff), 'LIMIT', 0, MAX_SCAN);

    if (ids.length === 0) return;

    const pipeline = redis.pipeline();
    for (const id of ids) {
      // F153 Phase J Slice J-B AC-J8: also pull toolEvents so we can synthesize
      // real-duration tool spans (KD-39 boundary: no flat invocation.restored when
      // toolEvents carry full timing + tracing pointers).
      pipeline.hmget(MessageKeys.detail(id), 'extra', 'timestamp', 'catId', 'metadata', 'toolEvents');
    }
    const results = await pipeline.exec();

    const dtos: TraceSpanDTO[] = [];

    for (const result of results ?? []) {
      const [err, fields] = result as [Error | null, (string | null)[] | null];
      if (err || !fields) continue;
      const [extraStr, timestampStr, catIdStr, metadataStr, toolEventsStr] = fields;

      const ts = Number.parseInt(timestampStr ?? '0', 10);
      if (!ts) continue;

      // Parse extra opportunistically: msg-level tracing only gates the
      // `invocation.restored` DTO. toolEvents are processed independently below
      // (maintainer R3 P2 fix): error/tool-only message records persisted via
      // route fallback paths carry `extra.stream` (invocation correlation) but
      // no `extra.tracing` (no done event arrived). Their toolEvents already
      // carry per-event tracing pointers, so cold-start hydrate must still
      // restore tool spans for those records — gating on msg-level tracing
      // would silently drop exactly the recover-on-refresh case the records
      // were persisted for.
      const extra = extraStr ? safeParseExtra(extraStr) : undefined;

      if (extra?.tracing) {
        const durationMs = parseDurationMs(metadataStr);
        const startTimeMs = durationMs > 0 ? ts - durationMs : ts;

        const attributes: Record<string, unknown> = {};
        if (catIdStr) attributes['agent.id'] = catIdStr;
        if (extra.stream?.invocationId) attributes.invocationId = extra.stream.invocationId;

        dtos.push({
          traceId: extra.tracing.traceId,
          spanId: extra.tracing.spanId,
          parentSpanId: extra.tracing.parentSpanId,
          name: 'cat_cafe.invocation.restored',
          kind: 0,
          startTimeMs,
          endTimeMs: ts,
          durationMs: durationMs > 0 ? durationMs : ts - startTimeMs,
          status: { code: 0 },
          attributes,
          events: [],
          storedAt: ts,
        });
      }

      // F153 Phase J Slice J-B AC-J8: synthesize tool spans whenever the
      // four-piece set is present at event level (independent of message-level
      // tracing — see comment above).
      const toolEvents = safeParseToolEvents(toolEventsStr ?? undefined);
      if (toolEvents && toolEvents.length > 0) {
        const toolDtos = synthesizeToolSpansFromEvents(toolEvents, catIdStr ?? undefined, ts);
        dtos.push(...toolDtos);
      }
    }

    if (dtos.length > 0) {
      traceStore.hydrate(dtos);
      log.info({ count: dtos.length, scanned: ids.length }, 'Hydrated trace store from Redis');
    }
  } catch (err) {
    log.warn({ err }, 'Trace store hydration failed (non-fatal)');
  }
}

function parseDurationMs(metadataStr: string | null | undefined): number {
  if (!metadataStr) return 0;
  try {
    const meta = JSON.parse(metadataStr);
    return typeof meta?.usage?.durationMs === 'number' ? meta.usage.durationMs : 0;
  } catch {
    return 0;
  }
}
