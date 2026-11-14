import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { ActionSuccessorKeys } from './action-successor-keys.js';
import { CLASSIFY_ACTION_RECOVERY_LUA, UPDATE_ACTION_RECOVERY_LUA } from './action-successor-recovery-lua.js';
import {
  ACTION_RECOVERY_LANES,
  type ActionRecoveryFact,
  type ActionRecoveryLane,
  type ActionRecoverySnapshot,
  initialActionRecovery,
  validActionRecovery,
} from './action-successor-recovery-state.js';
import { parseActionSuccessorLease } from './action-successor-redis-codecs.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

const log = createModuleLogger('ball-custody/action-recovery-index');

interface RecoveryEnvelope extends Record<string, unknown> {
  _recovery?: Partial<Record<ActionRecoveryLane, unknown>>;
  _recoveryRevision?: number;
  _invalidRaw?: string | null;
}
/** This is an index adapter for the existing lease row, not a second lease ledger. */
export class ActionSuccessorRecoveryIndex {
  private initialization: Promise<void> | undefined;
  constructor(private readonly redis: RedisClient) {}

  private logicalKey(key: string): string {
    const prefix = this.redis.options.keyPrefix ?? '';
    return prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  initialize(rebuild = false): Promise<void> {
    if (!rebuild && this.initialization) return this.initialization;
    const work = this.classifyHistoricalRows(rebuild).catch((error) => {
      if (this.initialization === work) this.initialization = undefined;
      throw error;
    });
    this.initialization = work;
    return work;
  }

  private async classifyHistoricalRows(rebuild: boolean): Promise<void> {
    if (!rebuild && (await this.redis.get(ActionSuccessorKeys.RECOVERY_MIGRATION))) return;
    if (rebuild) await this.redis.del(...ActionSuccessorKeys.recoveryIndexes());
    const keys = (await this.redis.smembers(ActionSuccessorKeys.ALL)).map((key) => this.logicalKey(key));
    for (let start = 0; start < keys.length; start += 100) {
      const batch = keys.slice(start, start + 100);
      const raws = await this.redis.mget(...batch);
      for (const [n, key] of batch.entries()) await this.classify(key, raws[n] ?? null);
    }
    await this.redis.set(
      ActionSuccessorKeys.RECOVERY_MIGRATION,
      JSON.stringify({
        v: 1,
        completedAt: Date.now(),
        discovered: keys.length,
      }),
    );
  }

  private async classify(key: string, raw: string | null): Promise<void> {
    let next: RecoveryEnvelope;
    let lease: ActionSuccessorLease | null = null;
    try {
      if (raw === null) throw new Error('missing_lease');
      next = JSON.parse(raw) as RecoveryEnvelope;
      if (!Object.hasOwn(next, '_invalidRaw')) {
        lease = parseActionSuccessorLease(raw);
        if (!lease || key !== ActionSuccessorKeys.detail(lease.leaseId)) throw new Error('malformed_lease');
      }
    } catch {
      // Original malformed bytes remain queryable at the original ID. No route is guessed from them.
      next = {
        _invalidRaw: raw,
        disposition: 'needs_attention',
        reasonCode: raw === null ? 'lease_missing' : 'malformed_lease',
      };
    }
    if (lease) {
      // I/O errors are allowed to fail the census. They must never quarantine valid business bytes.
      const identity = await this.redis.get(ActionSuccessorKeys.identity(lease));
      const mismatch = lease.status !== 'completed' && (!identity || this.logicalKey(identity) !== key);
      const invalidContainer =
        next._recovery !== undefined &&
        (typeof next._recovery !== 'object' || next._recovery === null || Array.isArray(next._recovery));
      next._recovery = Object.fromEntries(
        ACTION_RECOVERY_LANES.map((lane) => {
          const stored = next._recovery?.[lane];
          const invalid = invalidContainer || (stored !== undefined && !validActionRecovery(stored, lease.generation));
          const reason = mismatch ? 'identity_index_mismatch' : 'malformed_recovery_fact';
          const fact = validActionRecovery(stored, lease.generation) ? stored : initialActionRecovery(lease.generation);
          const { notification: _legacyNotification, ...ownerFact } = fact as ActionRecoveryFact & {
            notification?: unknown;
          };
          return [
            lane,
            mismatch || invalid
              ? {
                  ...ownerFact,
                  nextAttemptAt: null,
                  disposition: 'needs_attention',
                  reasonCode: reason,
                }
              : ownerFact,
          ];
        }),
      );
      next._recoveryRevision = (Number.isSafeInteger(next._recoveryRevision) ? Number(next._recoveryRevision) : 0) + 1;
    }
    const committed = await this.redis.eval(
      CLASSIFY_ACTION_RECOVERY_LUA,
      4,
      key,
      ...ActionSuccessorKeys.recoveryIndexes(),
      raw ?? '',
      JSON.stringify(next),
      raw === null ? 'missing' : 'present',
    );
    if (Number(committed) === 1 && Object.hasOwn(next, '_invalidRaw') && raw !== JSON.stringify(next))
      log.warn(
        { recordRef: key, disposition: 'needs_attention', reasonCode: next.reasonCode },
        'Action recovery classified an unreadable owner; original bytes retained',
      );
  }

  async list(lane: ActionRecoveryLane, limit: number, now: number): Promise<ActionSuccessorLease[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_action_recovery_limit');
    await this.initialize();
    const keys = (
      await this.redis.zrangebyscore(ActionSuccessorKeys.recoveryDue(lane), '-inf', now, 'LIMIT', 0, limit)
    ).map((key) => this.logicalKey(key));
    if (!keys.length) return [];
    const raws = await this.redis.mget(...keys);
    const result: ActionSuccessorLease[] = [];
    for (const [n, key] of keys.entries()) {
      try {
        const lease = parseActionSuccessorLease(raws[n] ?? null);
        if (!lease || key !== ActionSuccessorKeys.detail(lease.leaseId)) throw new Error('invalid_lease');
        result.push(lease);
      } catch {
        await this.classify(key, raws[n] ?? null);
      }
    }
    return result;
  }

  async read(leaseId: string, lane: ActionRecoveryLane): Promise<ActionRecoverySnapshot | null> {
    const raw = await this.redis.get(ActionSuccessorKeys.detail(leaseId));
    const lease = parseActionSuccessorLease(raw);
    if (!raw || !lease) return null;
    const envelope = JSON.parse(raw) as RecoveryEnvelope;
    return {
      lease,
      revision:
        Number.isSafeInteger(envelope._recoveryRevision) && Number(envelope._recoveryRevision) >= 0
          ? Number(envelope._recoveryRevision)
          : 0,
      fact: validActionRecovery(envelope._recovery?.[lane], lease.generation)
        ? (envelope._recovery?.[lane] as ActionRecoveryFact)
        : {
            ...initialActionRecovery(lease.generation),
            disposition: 'needs_attention',
            reasonCode: 'malformed_recovery_fact',
          },
      needsRepair:
        !validActionRecovery(envelope._recovery?.[lane], lease.generation) ||
        !Number.isSafeInteger(envelope._recoveryRevision) ||
        Number(envelope._recoveryRevision) < 0,
    };
  }

  async update(
    snapshot: ActionRecoverySnapshot,
    lane: ActionRecoveryLane,
    fact: ActionRecoveryFact,
    fenceBusiness = false,
    expectedClaim = '',
  ): Promise<boolean> {
    const result = Number(
      await this.redis.eval(
        UPDATE_ACTION_RECOVERY_LUA,
        5,
        ActionSuccessorKeys.detail(snapshot.lease.leaseId),
        ActionSuccessorKeys.identity(snapshot.lease),
        ...ActionSuccessorKeys.recoveryIndexes(),
        lane,
        String(snapshot.lease.generation),
        String(snapshot.revision),
        String(fenceBusiness ? snapshot.lease.revision : -1),
        JSON.stringify(fact),
        expectedClaim,
      ),
    );
    if (result === -2) {
      const key = ActionSuccessorKeys.detail(snapshot.lease.leaseId);
      await this.classify(key, await this.redis.get(key));
    }
    return result === 1;
  }
}
