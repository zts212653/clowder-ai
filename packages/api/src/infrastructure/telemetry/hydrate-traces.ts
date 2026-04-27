/**
 * F153 Phase F AC-F4/F5: Hydrate LocalTraceStore from Redis messages on cold start.
 *
 * Pointer-only restoration: scans recent messages, extracts tracing pointers
 * from extra.tracing, and creates stub DTOs with real timing. Does NOT restore
 * the full route/invocation/cli_session/llm_call span hierarchy — all restored
 * spans appear as flat `cat_cafe.invocation.restored` entries. Full semantic
 * reconstruction is deferred to a follow-up slice.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { safeParseExtra } from '../../domains/cats/services/stores/redis/redis-message-parsers.js';
import { MessageKeys } from '../../domains/cats/services/stores/redis-keys/message-keys.js';
import { createModuleLogger } from '../logger.js';
import type { LocalTraceStore, TraceSpanDTO } from './local-trace-store.js';

const log = createModuleLogger('telemetry:hydrate');

const MAX_SCAN = 500;
const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export async function hydrateTraceStoreFromRedis(
  traceStore: LocalTraceStore,
  redis: RedisClient,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;

  try {
    const ids = await redis.zrevrangebyscore(MessageKeys.TIMELINE, '+inf', String(cutoff), 'LIMIT', 0, MAX_SCAN);

    if (ids.length === 0) return;

    const pipeline = redis.pipeline();
    for (const id of ids) {
      pipeline.hmget(MessageKeys.detail(id), 'extra', 'timestamp', 'catId', 'metadata');
    }
    const results = await pipeline.exec();

    const dtos: TraceSpanDTO[] = [];

    for (const result of results ?? []) {
      const [err, fields] = result as [Error | null, (string | null)[] | null];
      if (err || !fields) continue;
      const [extraStr, timestampStr, catIdStr, metadataStr] = fields;
      if (!extraStr) continue;

      const extra = safeParseExtra(extraStr);
      if (!extra?.tracing) continue;

      const ts = Number.parseInt(timestampStr ?? '0', 10);
      if (!ts) continue;

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
