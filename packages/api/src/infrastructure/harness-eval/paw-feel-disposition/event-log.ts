import type { PawFeelDispositionEvent, PawFeelDispositionProjection } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { TaskKeys } from '../../../domains/cats/services/stores/redis-keys/task-keys.js';
import { awaitPawFeelRead } from './projection/bounded-reads.js';
import { RedisPawFeelProjectionReader } from './projection/redis-projection-reader.js';
import { parsePawFeelDispositionEvent } from './schema.js';
import { type PawFeelSignalScanCursorV1, type PawFeelSignalScanPage, scanPawFeelSignalIds } from './signal-scan.js';

export type { PawFeelSignalScanCursorV1, PawFeelSignalScanPage } from './signal-scan.js';

const KEYSPACE = 'paw-feel:disposition';
const SOURCE_SCAN_COUNT = 1_000;

export const PawFeelDispositionKeys = {
  eventLog: (signalId: string): string => `${KEYSPACE}:log:${signalId}`,
  eventsSeen: `${KEYSPACE}:events:seen`,
  signals: `${KEYSPACE}:signals`,
} as const;

export type PawFeelDispositionAppendResult =
  | { outcome: 'appended'; sequence: number }
  | { outcome: 'duplicate' }
  | { outcome: 'conflict'; actualSequence: number };

export interface PawFeelAssignmentAppendFence {
  taskId: string;
  ownerRevision: number;
  taskThreadId: string;
  ownerCatId: string;
  userId: string;
  terminal: boolean;
}

export interface IPawFeelDispositionEventLog {
  readProjections?(
    signalIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, PawFeelDispositionProjection>>;
  append(
    event: PawFeelDispositionEvent,
    expectedSequence: number,
    assignment?: PawFeelAssignmentAppendFence,
  ): Promise<PawFeelDispositionAppendResult>;
  read(signalId: string, fromSequence?: number, signal?: AbortSignal): Promise<PawFeelDispositionEvent[]>;
  readMany?(signalIds: readonly string[], signal?: AbortSignal): Promise<Map<string, PawFeelDispositionEvent[]>>;
  scanSignalIds(cursor: PawFeelSignalScanCursorV1 | undefined, limit: number): Promise<PawFeelSignalScanPage>;
  listSignalIds(signal?: AbortSignal): Promise<string[]>;
  listSignalIdsBySourceMessageId(sourceMessageId: string, signal?: AbortSignal): Promise<string[]>;
}

const APPEND_LUA = `
local duplicate = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if duplicate == 1 then
  return {0, -1}
end

local current = redis.call('LLEN', KEYS[1])
if current ~= tonumber(ARGV[2]) then
  return {-1, current}
end

if KEYS[4] then
  local expected = cjson.decode(ARGV[5])
  local fields = redis.call('HMGET', KEYS[4], 'id', 'kind', 'subjectKey', 'entrustedWork', 'userId', 'ownerCatId', 'threadId', 'ownerRevision', 'status')
  local revision = tonumber(fields[8]) or 0
  local terminal = fields[9] == 'done'
  if fields[1] ~= expected.taskId or fields[2] ~= 'work' or (fields[3] and fields[3] ~= '') or
    (fields[4] and fields[4] ~= '') or fields[5] ~= expected.userId or fields[6] ~= expected.ownerCatId or
    fields[7] ~= expected.taskThreadId or revision ~= expected.ownerRevision or terminal ~= expected.terminal then
    return {-2, current}
  end
end

redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[4])
redis.call('RPUSH', KEYS[1], ARGV[3])
return {1, current}
`;

function requireSequence(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function escapeRedisGlob(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('*', '\\*')
    .replaceAll('?', '\\?')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

export class RedisPawFeelDispositionEventLog implements IPawFeelDispositionEventLog {
  private readonly projectionReader: RedisPawFeelProjectionReader;
  constructor(private readonly redis: RedisClient) {
    this.projectionReader = new RedisPawFeelProjectionReader(
      redis,
      PawFeelDispositionKeys.eventLog,
      async (id, from, to) => {
        const encoded = await redis.lrange(PawFeelDispositionKeys.eventLog(id), from, to);
        return encoded.map((value) => parsePawFeelDispositionEvent(JSON.parse(value)));
      },
    );
  }

  readProjections(ids: readonly string[], signal?: AbortSignal): Promise<Map<string, PawFeelDispositionProjection>> {
    return this.projectionReader.readMany(ids, signal);
  }

  async append(
    event: PawFeelDispositionEvent,
    expectedSequence: number,
    assignment?: PawFeelAssignmentAppendFence,
  ): Promise<PawFeelDispositionAppendResult> {
    requireSequence(expectedSequence, 'expectedSequence');
    const validated = parsePawFeelDispositionEvent(event);
    const keys = [
      PawFeelDispositionKeys.eventLog(validated.signalId),
      PawFeelDispositionKeys.eventsSeen,
      PawFeelDispositionKeys.signals,
    ];
    if (assignment) keys.push(TaskKeys.detail(assignment.taskId));
    const result = (await this.redis.eval(
      APPEND_LUA,
      keys.length,
      ...keys,
      validated.eventId,
      expectedSequence.toString(),
      JSON.stringify(validated),
      validated.signalId,
      JSON.stringify(assignment ?? null),
    )) as [number, number];
    if (result[0] === -2) throw new Error('repair Task assignment changed at event append');

    if (result[0] === 0) return { outcome: 'duplicate' };
    if (result[0] === -1) return { outcome: 'conflict', actualSequence: result[1] };
    return { outcome: 'appended', sequence: result[1] };
  }

  async read(signalId: string, fromSequence = 0, signal?: AbortSignal): Promise<PawFeelDispositionEvent[]> {
    signal?.throwIfAborted();
    requireSequence(fromSequence, 'fromSequence');
    const encoded = await awaitPawFeelRead(
      this.redis.lrange(PawFeelDispositionKeys.eventLog(signalId), fromSequence, -1),
      signal,
    );
    return encoded.map((value) => parsePawFeelDispositionEvent(JSON.parse(value)));
  }

  async scanSignalIds(rawCursor: PawFeelSignalScanCursorV1 | undefined, limit: number): Promise<PawFeelSignalScanPage> {
    return scanPawFeelSignalIds(this.redis, PawFeelDispositionKeys.signals, rawCursor, limit);
  }

  async listSignalIds(signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    return (await awaitPawFeelRead(this.redis.smembers(PawFeelDispositionKeys.signals), signal)).sort();
  }

  async listSignalIdsBySourceMessageId(sourceMessageId: string, signal?: AbortSignal): Promise<string[]> {
    const signalIds = new Set<string>();
    const pattern = `${escapeRedisGlob(sourceMessageId)}:*`;
    let cursor = '0';
    do {
      signal?.throwIfAborted();
      const [nextCursor, matches] = await awaitPawFeelRead(
        this.redis.sscan(PawFeelDispositionKeys.signals, cursor, 'MATCH', pattern, 'COUNT', SOURCE_SCAN_COUNT),
        signal,
      );
      for (const signalId of matches) signalIds.add(signalId);
      cursor = nextCursor;
    } while (cursor !== '0');
    return [...signalIds].sort();
  }

  async readMany(signalIds: readonly string[], signal?: AbortSignal): Promise<Map<string, PawFeelDispositionEvent[]>> {
    signal?.throwIfAborted();
    const pipeline = this.redis.pipeline();
    for (const signalId of signalIds) pipeline.lrange(PawFeelDispositionKeys.eventLog(signalId), 0, -1);
    const replies = await awaitPawFeelRead(pipeline.exec(), signal);
    if (!replies) throw new Error('paw-feel event-log pipeline returned no replies');
    const events = new Map<string, PawFeelDispositionEvent[]>();
    for (let index = 0; index < signalIds.length; index += 1) {
      const signalId = signalIds[index];
      const reply = replies[index];
      if (!signalId || !reply) throw new Error('paw-feel event-log pipeline response is incomplete');
      const [error, encoded] = reply;
      if (error) throw error;
      events.set(
        signalId,
        (encoded as string[]).map((value) => parsePawFeelDispositionEvent(JSON.parse(value))),
      );
    }
    return events;
  }
}
