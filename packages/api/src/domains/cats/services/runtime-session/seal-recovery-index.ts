import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import { RuntimeSessionKeys } from '../stores/redis-keys/runtime-session-keys.js';
import { normalizeRuntimeSessionMetadata, type RuntimeSessionMetadata } from './RuntimeSessionMetadata.js';
import {
  needsRuntimeSealRecovery,
  planRuntimeSealRecoveryFailure,
  runtimeSealRecoveryScore,
  sameRuntimeSealExecution,
} from './runtime-seal-recovery-state.js';

const log = createModuleLogger('runtime-session/seal-recovery');
const PROJECT = `
local kind = redis.call('TYPE',KEYS[2])
if type(kind) == 'table' then kind = kind.ok end
if kind ~= 'none' and kind ~= 'zset' then error('runtime_seal_index_wrong_type') end
local raw = redis.call('GET',KEYS[1])
if not ((not raw and ARGV[1] == '') or raw == ARGV[1]) then return 0 end
if ARGV[2] == '1' then redis.call('ZADD',KEYS[2],ARGV[3],ARGV[4])
else redis.call('ZREM',KEYS[2],ARGV[4]) end
return 1
`;
const METADATA_CAS = `
local kind = redis.call('TYPE',KEYS[2])
if type(kind) == 'table' then kind = kind.ok end
if kind ~= 'none' and kind ~= 'zset' then error('runtime_seal_index_wrong_type') end
if ARGV[4] and ARGV[4] ~= '' and not tonumber(ARGV[4]) then error('invalid_runtime_seal_score') end
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET',KEYS[1],ARGV[2])
if ARGV[4] and ARGV[4] ~= '' then redis.call('ZADD',KEYS[2],ARGV[4],ARGV[3])
else redis.call('ZREM',KEYS[2],ARGV[3]) end
return 1
`;

/** All durable facts remain in the original sidecar; this class only rebuilds/selects its projection. */
export class RuntimeSealRecoveryIndex {
  private initialization: Promise<void> | undefined;
  constructor(private readonly redis: RedisClient) {}

  initialize(rebuild = false): Promise<void> {
    if (!rebuild && this.initialization) return this.initialization;
    const work = this.rebuild(rebuild).catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    this.initialization = work;
    return work;
  }
  private async rebuild(force: boolean): Promise<void> {
    if (!force && (await this.redis.get(RuntimeSessionKeys.sealRecoveryComplete()))) return;
    if (force) await this.redis.del(RuntimeSessionKeys.sealRecovery());
    const ids = await this.redis.zrange(RuntimeSessionKeys.byLifecycleState('runtime_seal_pending'), 0, -1);
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100);
      const raws = await this.redis.mget(...batch.map((id) => RuntimeSessionKeys.detail(id)));
      for (const [index, id] of batch.entries()) await this.project(id, raws[index] ?? null);
    }
    await this.redis.set(RuntimeSessionKeys.sealRecoveryComplete(), JSON.stringify({ v: 1, completedAt: Date.now() }));
  }
  private async project(id: string, raw: string | null): Promise<RuntimeSessionMetadata | null> {
    let record: RuntimeSessionMetadata | null = null;
    let malformed = false;
    if (raw) {
      try {
        const input = JSON.parse(raw) as Record<string, unknown>;
        if (!Object.hasOwn(input, '_sealRecoveryCorruption')) {
          record = normalizeRuntimeSessionMetadata(input);
          if (record.sessionId !== id) throw new Error('runtime_session_identity_mismatch');
        }
      } catch {
        malformed = true;
      }
    }
    if (malformed && raw) {
      const result = await this.redis.eval(
        METADATA_CAS,
        2,
        RuntimeSessionKeys.detail(id),
        RuntimeSessionKeys.sealRecovery(),
        raw,
        JSON.stringify({
          _sealRecoveryCorruption: raw,
          recoveryDisposition: 'needs_attention',
          reasonCode: 'invalid_runtime_metadata',
        }),
        id,
      );
      if (Number(result) === 1)
        log.warn(
          { sessionId: id, reasonCode: 'invalid_runtime_metadata' },
          'Runtime seal recovery retained unreadable source for inspection',
        );
      return null;
    }
    const eligible = !!record && needsRuntimeSealRecovery(record);
    await this.redis.eval(
      PROJECT,
      2,
      RuntimeSessionKeys.detail(id),
      RuntimeSessionKeys.sealRecovery(),
      raw ?? '',
      eligible ? '1' : '0',
      String(record ? runtimeSealRecoveryScore(record) : 0),
      id,
    );
    return eligible ? record : null;
  }
  async list(limit = 100): Promise<RuntimeSessionMetadata[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_runtime_seal_batch_limit');
    await this.initialize();
    const ids = await this.redis.zrange(RuntimeSessionKeys.sealRecovery(), 0, limit - 1);
    if (!ids.length) return [];
    const raws = await this.redis.mget(...ids.map((id) => RuntimeSessionKeys.detail(id)));
    const records: RuntimeSessionMetadata[] = [];
    for (const [index, id] of ids.entries()) {
      const record = await this.project(id, raws[index] ?? null);
      if (record) records.push(record);
    }
    return records;
  }
  async park(selected: RuntimeSessionMetadata, now: number): Promise<boolean> {
    const raw = await this.redis.get(RuntimeSessionKeys.detail(selected.sessionId));
    if (!raw) return false;
    const current = normalizeRuntimeSessionMetadata(JSON.parse(raw));
    if (
      !needsRuntimeSealRecovery(current) ||
      !sameRuntimeSealExecution(current, selected) ||
      (current.lifecycle.retryCount ?? 0) !== (selected.lifecycle.retryCount ?? 0)
    )
      return false;
    // Patch the parsed original bytes, not a re-encoded Lua record or a normalized business projection.
    const original = JSON.parse(raw) as RuntimeSessionMetadata;
    const next = {
      ...original,
      lifecycle: {
        ...original.lifecycle,
        recoveryDisposition: 'needs_attention',
        recoveryReasonCode: 'seal_retry_exhausted',
        recoveryDisposedAt: now,
      },
    };
    return (
      Number(
        await this.redis.eval(
          METADATA_CAS,
          2,
          RuntimeSessionKeys.detail(selected.sessionId),
          RuntimeSessionKeys.sealRecovery(),
          raw,
          JSON.stringify(next),
          selected.sessionId,
        ),
      ) === 1
    );
  }
  async fail(selected: RuntimeSessionMetadata, now: number, maxRetries: number, reason: string): Promise<boolean> {
    const raw = await this.redis.get(RuntimeSessionKeys.detail(selected.sessionId));
    if (!raw) return false;
    const original = JSON.parse(raw) as RuntimeSessionMetadata;
    const current = normalizeRuntimeSessionMetadata(original);
    const planned = planRuntimeSealRecoveryFailure(current, selected, now, maxRetries, reason);
    if (!planned) return false;
    const next = { ...original, lifecycle: { ...original.lifecycle, ...planned.lifecycle } };
    return (
      Number(
        await this.redis.eval(
          METADATA_CAS,
          2,
          RuntimeSessionKeys.detail(selected.sessionId),
          RuntimeSessionKeys.sealRecovery(),
          raw,
          JSON.stringify(next),
          selected.sessionId,
          needsRuntimeSealRecovery(planned) ? runtimeSealRecoveryScore(planned) : '',
        ),
      ) === 1
    );
  }
}
