import type { BallCustodyProjection } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { recoveryRedis } from '../../infrastructure/recovery/recovery-redis.js';
import { BallCustodyKeys as keys } from './ball-custody-keys.js';
import {
  BallProbeRecoveryCensusPending,
  BallProbeRecoveryConflict,
  type BallRecoveryIndex,
  type BallRecoveryMutation,
} from './ball-probe-recovery-backend.js';
import { BallProbeRecoveryCensus } from './ball-probe-recovery-census.js';
import { type BallProbeRecoveryFacts, ballProbeScores, reconcileBallProbeFacts } from './ball-probe-recovery-state.js';
import { validBallRecoveryFacts, validBallRecoveryProjection } from './ball-probe-recovery-validation.js';

export const BALL_PROBE_DUE = 'ballcustody:recovery:probe:due';
export const BALL_IDLE_ELIGIBLE = 'ballcustody:recovery:idle:eligible';
export const BALL_IDLE_RETRY = 'ballcustody:recovery:idle:retry';
export const BALL_NOTICE_DUE = 'ballcustody:recovery:notice:due';
export const BALL_WAKE_AUDIT_DUE = 'ballcustody:recovery:wake-audit:due';
const metadataKey = (subject: string) => `ballcustody:events:meta:${subject}`;
const INDEX: Record<BallRecoveryIndex, string> = {
  probe: BALL_PROBE_DUE,
  idle: BALL_IDLE_ELIGIBLE,
  retry: BALL_IDLE_RETRY,
  notice: BALL_NOTICE_DUE,
  audit: BALL_WAKE_AUDIT_DUE,
};
const PUBLISH = `
for i, expected in ipairs({'string', 'hash', 'set', 'zset', 'zset', 'zset', 'zset', 'zset'}) do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= expected then return redis.error_reply('invalid_ball_recovery_index') end
end
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[2]
  or (redis.call('HGET', KEYS[2], 'probeRecovery') or '') ~= ARGV[3] then return 0 end
if ARGV[13] ~= '' and redis.call('HEXISTS', KEYS[2], ARGV[13]) == 1 then return 2 end
local archive = cjson.decode(ARGV[12])
for i=7,11 do
  if ARGV[i] ~= '' and not tonumber(ARGV[i]) then return redis.error_reply('invalid_ball_recovery_score') end
end
if ARGV[4] == 'write' then redis.call('SET', KEYS[1], ARGV[5]); redis.call('SADD', KEYS[3], ARGV[1])
elseif ARGV[4] == 'delete' then redis.call('DEL', KEYS[1]); redis.call('SREM', KEYS[3], ARGV[1]) end
redis.call('HSET', KEYS[2], 'probeRecovery', ARGV[6])
for field, value in pairs(archive) do redis.call('HSET', KEYS[2], field, value) end
for i=4,8 do
  if ARGV[i+3] == '' then redis.call('ZREM', KEYS[i], ARGV[1])
  else redis.call('ZADD', KEYS[i], ARGV[i+3], ARGV[1]) end
end
return 1`;

/** Recovery facts extend the original EventLog subject metadata; business projection JSON remains disposable. */
export class RedisBallProbeRecovery {
  private readonly census: BallProbeRecoveryCensus;
  constructor(private readonly redis: RedisClient) {
    this.redis = recoveryRedis(redis);
    this.census = new BallProbeRecoveryCensus(this.redis, Object.values(INDEX), async (subject) => {
      await this.mutate(subject, ({ facts, projection }) => {
        const archive = Object.fromEntries(
          Object.entries(facts.notices).map(([key, notice]) => [`notice:${key}`, JSON.stringify(notice)]),
        );
        facts.notices = {};
        return {
          result: undefined,
          facts: reconcileBallProbeFacts(subject, projection, facts),
          archive,
        };
      });
    });
  }
  async readArchive(subject: string, key: string): Promise<string | null> {
    return this.redis.hget(metadataKey(subject), key);
  }
  async readFacts(subject: string): Promise<BallProbeRecoveryFacts | null> {
    const raw = await this.redis.hget(metadataKey(subject), 'probeRecovery');
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (validBallRecoveryFacts(parsed, subject)) return parsed;
    } catch {
      /* Invalid original bytes are retained by the same-owner mutation below. */
    }
    return this.mutate(subject, ({ facts }) => ({ result: structuredClone(facts) }));
  }

  async mutate<T>(
    subject: string,
    change: (input: {
      projection: BallCustodyProjection | null;
      facts: BallProbeRecoveryFacts;
    }) => BallRecoveryMutation<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = await this.redis.get(keys.projection(subject));
      const metadata = await this.redis.hget(metadataKey(subject), 'probeRecovery');
      let projection: BallCustodyProjection | null = null;
      let facts: BallProbeRecoveryFacts = { v: 1, subjectKey: subject, generation: 0, notices: {} };
      if (metadata) {
        try {
          const parsed: unknown = JSON.parse(metadata);
          if (!validBallRecoveryFacts(parsed, subject)) throw new Error('invalid metadata');
          facts = parsed;
        } catch {
          facts.disposition = 'needs_attention';
          facts.reasonCode = 'invalid_recovery_metadata';
          facts.originalRaw = metadata;
        }
      }
      if (raw !== null) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!validBallRecoveryProjection(parsed, subject)) throw new Error('invalid projection');
          projection = parsed;
        } catch {
          facts.disposition = 'needs_attention';
          facts.reasonCode = 'invalid_projection';
          facts.originalRaw ??= raw;
        }
      }
      const output = change({ projection, facts });
      const next = output.projection === undefined ? projection : output.projection;
      const nextFacts = output.facts ?? facts;
      if (!validBallRecoveryFacts(nextFacts, subject) || (next && !validBallRecoveryProjection(next, subject)))
        throw new Error('invalid_ball_recovery_publication');
      const scores = ballProbeScores(next, nextFacts);
      const result = await this.redis.eval(
        PUBLISH,
        8,
        keys.projection(subject),
        metadataKey(subject),
        keys.projectionsIndex,
        BALL_PROBE_DUE,
        BALL_IDLE_ELIGIBLE,
        BALL_IDLE_RETRY,
        BALL_NOTICE_DUE,
        BALL_WAKE_AUDIT_DUE,
        subject,
        raw ?? '',
        metadata ?? '',
        output.mode ?? 'keep',
        next ? JSON.stringify(next) : '',
        JSON.stringify(nextFacts),
        scores.probe ?? '',
        scores.idle ?? '',
        scores.retry ?? '',
        scores.notice ?? '',
        scores.audit ?? '',
        JSON.stringify(output.archive ?? {}),
        output.requireArchiveAbsent ?? '',
      );
      if (Number(result) === 1) return output.result;
      if (Number(result) === 2) throw new BallProbeRecoveryConflict('ball_recovery_archive_already_recorded');
    }
    throw new BallProbeRecoveryConflict('ball_probe_recovery_stale');
  }

  async save(projection: BallCustodyProjection): Promise<void> {
    await this.mutate(projection.subjectKey, ({ facts }) => {
      return {
        result: undefined,
        mode: 'write',
        projection,
        facts: reconcileBallProbeFacts(projection.subjectKey, projection, facts),
      };
    });
  }
  async deleteProjection(subject: string): Promise<void> {
    await this.mutate(subject, ({ facts }) => {
      facts.rebuilding = true;
      return { result: undefined, mode: 'delete', projection: null };
    });
  }
  async finishRebuild(subject: string): Promise<void> {
    await this.mutate(subject, ({ facts, projection }) => {
      return { result: undefined, facts: reconcileBallProbeFacts(subject, projection, facts, true) };
    });
  }
  async initialize(rebuild = false): Promise<void> {
    if (rebuild || Number(await this.redis.zcard(BALL_NOTICE_DUE)) > 0) await this.census.reset();
    // Explicit initialization/rebuild retains its existing complete-on-return contract.
    while (!(await this.census.advance())) {
      /* Each page is independently durable. */
    }
  }
  async due(index: BallRecoveryIndex, before: number, limit: number): Promise<string[]> {
    if (!(await this.census.advance())) throw new BallProbeRecoveryCensusPending('ball_recovery_census_pending');
    return this.redis.zrangebyscore(INDEX[index], '-inf', before, 'LIMIT', 0, limit);
  }
}
