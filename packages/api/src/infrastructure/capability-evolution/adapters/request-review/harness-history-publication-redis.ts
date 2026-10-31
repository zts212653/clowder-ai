import { harnessHistoryCommitSchema, harnessHistoryPublicationAttemptSchema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  type HarnessHistoryPublicationAppend,
  type HarnessHistoryPublicationAppendResult,
  type HarnessHistoryPublicationSnapshot,
  type HarnessHistoryPublicationStore,
  historyCommandKey,
} from './harness-history-publication-store.js';

export function harnessHistoryPublicationKeys(programId: string) {
  const prefix = `capability-evolution:f314:history-publications:${programId}`;
  return { metadata: `${prefix}:metadata`, attempts: `${prefix}:attempts`, commands: `${prefix}:commands` };
}

const APPEND = `
local prior = redis.call('HGET', KEYS[3], ARGV[1])
if prior then
  local command = cjson.decode(prior)
  if command.digest ~= ARGV[2] then return {-1, ''} end
  return {0, redis.call('LINDEX', KEYS[2], command.revision - 1)}
end
local current = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0')
if current ~= tonumber(ARGV[3]) then return {-2, ''} end
local nextRevision = current + 1
redis.call('HSETNX', KEYS[1], 'baseline', ARGV[4])
redis.call('RPUSH', KEYS[2], ARGV[5])
redis.call('HSET', KEYS[1], 'revision', nextRevision)
if ARGV[6] == 'published' then redis.call('HSET', KEYS[1], 'current', nextRevision) end
redis.call('HSET', KEYS[3], ARGV[1], cjson.encode({digest = ARGV[2], revision = nextRevision}))
for _, key in ipairs(KEYS) do redis.call('PERSIST', key) end
return {1, ARGV[5]}
`;
const READ = `
local revision = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0')
local selected = tonumber(redis.call('HGET', KEYS[1], 'current') or '0')
local current = ''
if selected > 0 then current = redis.call('LINDEX', KEYS[2], selected - 1) end
return {revision, redis.call('HGET', KEYS[1], 'baseline') or '', current, redis.call('LRANGE', KEYS[2], -50, -1)}
`;
const REPLAY = `
local prior = redis.call('HGET', KEYS[2], ARGV[1])
if not prior then return {2, ''} end
local command = cjson.decode(prior)
if command.digest ~= ARGV[2] then return {-1, ''} end
return {0, redis.call('LINDEX', KEYS[1], command.revision - 1)}
`;
const INITIALIZE_BASELINE = `
redis.call('HSETNX', KEYS[1], 'baseline', ARGV[1])
redis.call('PERSIST', KEYS[1])
return redis.call('HGET', KEYS[1], 'baseline')
`;

function decodeAttempt(encoded: string) {
  return harnessHistoryPublicationAttemptSchema.parse(JSON.parse(encoded));
}
function result(tuple: [number, string]): HarnessHistoryPublicationAppendResult {
  if (tuple[0] === -1) return { outcome: 'idempotency_collision' };
  if (tuple[0] === -2) return { outcome: 'conflict' };
  return { outcome: tuple[0] === 0 ? 'duplicate' : 'appended', attempt: decodeAttempt(tuple[1]) };
}

export class RedisHarnessHistoryPublicationStore implements HarnessHistoryPublicationStore {
  constructor(private readonly redis: RedisClient) {}

  async initializeBaseline(programId: string, sourceRevision: string) {
    const candidate = harnessHistoryCommitSchema.parse(sourceRevision);
    const baseline = await this.redis.eval(
      INITIALIZE_BASELINE,
      1,
      harnessHistoryPublicationKeys(programId).metadata,
      candidate,
    );
    return harnessHistoryCommitSchema.parse(baseline);
  }

  async read(programId: string): Promise<HarnessHistoryPublicationSnapshot> {
    const keys = harnessHistoryPublicationKeys(programId);
    const [revision, baseline, current, attempts] = (await this.redis.eval(READ, 2, keys.metadata, keys.attempts)) as [
      number,
      string,
      string,
      string[],
    ];
    return {
      revision,
      ...(baseline ? { baselineSourceRevision: harnessHistoryCommitSchema.parse(baseline) } : {}),
      ...(current ? { current: decodeAttempt(current) } : {}),
      attempts: attempts.map(decodeAttempt),
    };
  }

  async get(programId: string, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
    const value = await this.redis.lindex(harnessHistoryPublicationKeys(programId).attempts, revision - 1);
    return value ? decodeAttempt(value) : undefined;
  }

  async replay(programId: string, actorRef: string, clientMessageId: string, digest: string) {
    const keys = harnessHistoryPublicationKeys(programId);
    const value = (await this.redis.eval(
      REPLAY,
      2,
      keys.attempts,
      keys.commands,
      historyCommandKey(actorRef, clientMessageId),
      digest,
    )) as [number, string];
    return value[0] === 2 ? undefined : result(value);
  }

  async append(input: HarnessHistoryPublicationAppend): Promise<HarnessHistoryPublicationAppendResult> {
    const attempt = harnessHistoryPublicationAttemptSchema.parse(input.attempt);
    if (attempt.revision !== input.expectedRevision + 1) throw new Error('invalid history append sequence');
    const baseline = harnessHistoryCommitSchema.parse(input.baselineSourceRevision);
    const keys = harnessHistoryPublicationKeys(input.programId);
    const value = (await this.redis.eval(
      APPEND,
      3,
      keys.metadata,
      keys.attempts,
      keys.commands,
      historyCommandKey(attempt.actorRef, attempt.clientMessageId),
      input.commandDigest,
      String(input.expectedRevision),
      baseline,
      JSON.stringify(attempt),
      attempt.status,
    )) as [number, string];
    return result(value);
  }
}
