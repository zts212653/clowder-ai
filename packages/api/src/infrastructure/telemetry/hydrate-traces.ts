/**
 * F153 Phase F AC-F4/F5: Hydrate LocalTraceStore from Redis messages on cold start.
 *
 * Scans recent messages from msg:timeline, extracts tracing pointers from
 * extra.tracing, synthesizes stub TraceSpanDTOs, and bulk-loads them.
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
      pipeline.hmget(MessageKeys.detail(id), 'extra', 'timestamp');
    }
    const results = await pipeline.exec();

    const dtos: TraceSpanDTO[] = [];

    for (const result of results ?? []) {
      const [err, fields] = result as [Error | null, [string | null, string | null] | null];
      if (err || !fields) continue;
      const [extraStr, timestampStr] = fields;
      if (!extraStr) continue;

      const extra = safeParseExtra(extraStr);
      if (!extra?.tracing) continue;

      const ts = Number.parseInt(timestampStr ?? '0', 10);
      if (!ts) continue;

      dtos.push({
        traceId: extra.tracing.traceId,
        spanId: extra.tracing.spanId,
        parentSpanId: extra.tracing.parentSpanId,
        name: 'cat_cafe.invocation.restored',
        kind: 0,
        startTimeMs: ts,
        endTimeMs: ts,
        durationMs: 0,
        status: { code: 0 },
        attributes: {},
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
