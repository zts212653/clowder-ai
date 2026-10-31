import { createHash } from 'node:crypto';
import {
  type EvolutionProgramEventEnvelopeV1,
  type EvolutionProgramEventV1,
  evolutionProgramEventEnvelopeV1Schema,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const KEYSPACE = 'capability-evolution:programs';

export const EvolutionProgramKeys = {
  eventLog: (programId: string): string => `${KEYSPACE}:log:${programId}`,
  eventIds: (programId: string): string => `${KEYSPACE}:event-ids:${programId}`,
  clientMessageIds: (programId: string): string => `${KEYSPACE}:client-message-ids:${programId}`,
  programIndex: (programId: string): string => `${KEYSPACE}:index:${programId}`,
  programIndexPrefix: `${KEYSPACE}:index:`,
} as const;

export type EvolutionProgramAppendResult =
  | { outcome: 'appended'; sequence: number }
  | { outcome: 'duplicate' }
  | { outcome: 'conflict'; actualSequence: number }
  | { outcome: 'idempotency_collision' };

export interface EvolutionProgramLogSnapshot {
  events: EvolutionProgramEventEnvelopeV1[];
  ttl: number;
}

export interface EvolutionProgramAppendOptions {
  ttlSeconds?: number;
  persist?: boolean;
}

export interface IEvolutionProgramEventLog {
  append(
    envelope: EvolutionProgramEventEnvelopeV1,
    options?: EvolutionProgramAppendOptions,
  ): Promise<EvolutionProgramAppendResult>;
  appendActiveForget(
    withdrawal: EvolutionProgramEventEnvelopeV1,
    retention: EvolutionProgramEventEnvelopeV1,
    ttlSeconds: number,
  ): Promise<EvolutionProgramAppendResult>;
  read(programId: string): Promise<EvolutionProgramEventEnvelopeV1[]>;
  readWithTtl(programId: string): Promise<EvolutionProgramLogSnapshot>;
  listProgramIds(workspaceId: string): Promise<string[]>;
  ttl(programId: string): Promise<number>;
}

function requireSequence(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function requireTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('ttlSeconds must be a positive safe integer');
  }
}

/**
 * Builds the canonical envelope. The event id is derived from (program, clientMessageId, type) so a
 * retry of the same command lands on the same identity, which is what makes the append path able to
 * tell a replay from a collision at all.
 */
export function buildEvolutionProgramEnvelope(input: {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  actorRef: string;
  originRef: string;
  event: EvolutionProgramEventV1;
  occurredAt: string;
  eventId: string;
  commandDigest?: string;
}): EvolutionProgramEventEnvelopeV1 {
  return evolutionProgramEventEnvelopeV1Schema.parse({
    ...(input.commandDigest === undefined ? {} : { commandDigest: input.commandDigest }),
    schemaVersion: 1,
    eventId: input.eventId,
    programId: input.programId,
    expectedSequence: input.expectedSequence,
    clientMessageId: input.clientMessageId,
    actorRef: input.actorRef,
    originRef: input.originRef,
    occurredAt: input.occurredAt,
    event: input.event,
  });
}

export function evolutionEventIdentityDigest(envelope: EvolutionProgramEventEnvelopeV1): string {
  const event =
    envelope.event.type === 'retention_opted_in'
      ? {
          ...envelope.event,
          retention: { ...envelope.event.retention, optedInAt: undefined },
        }
      : envelope.event;
  const stableIdentity = {
    schemaVersion: envelope.schemaVersion,
    eventId: envelope.eventId,
    programId: envelope.programId,
    clientMessageId: envelope.clientMessageId,
    actorRef: envelope.actorRef,
    originRef: envelope.originRef,
    // The COMMAND is part of the identity, not just the event it derived. Two different requests can
    // legitimately derive the same event — an attribution whose owner-resolved facts collapse to the
    // same diagnosis, say — and without this they were answered `duplicate`, silently discarding the
    // second command. Absent on events written before the field existed, and `JSON.stringify` drops
    // `undefined`, so their digests are byte-identical to what was already tombstoned.
    commandDigest: envelope.commandDigest,
    event,
  };
  return `${envelope.programId}:${createHash('sha256').update(JSON.stringify(stableIdentity)).digest('hex')}`;
}

/**
 * KEYS: Program log, Program-scoped event-id tombstones, Program-scoped client-message tombstones,
 *       and one Program index marker holding the workspace id.
 * ARGV: eventId, clientMessageId, identity digest, expected LLEN, encoded envelope,
 *       retention directive (`persist` or TTL seconds), optional workspace id.
 *
 * Both identities are checked before the sequence fence. Exact retries therefore
 * stay idempotent after later events land, while reusing an identity for different
 * content fails closed.
 */
const APPEND_LUA = `
local event_seen = redis.call('HGET', KEYS[2], ARGV[1])
local client_seen = redis.call('HGET', KEYS[3], ARGV[2])
if event_seen or client_seen then
  if event_seen == ARGV[3] and client_seen == ARGV[3] then return {0, -1} end
  return {-2, -1}
end

local current = redis.call('LLEN', KEYS[1])
if current ~= tonumber(ARGV[4]) then return {-1, current} end

redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
redis.call('HSET', KEYS[3], ARGV[2], ARGV[3])
if ARGV[7] ~= '' then redis.call('SET', KEYS[4], ARGV[7]) end
redis.call('RPUSH', KEYS[1], ARGV[5])
if ARGV[6] == 'persist' then
  for key_index = 1, 4 do redis.call('PERSIST', KEYS[key_index]) end
elseif ARGV[6] ~= '' then
  for key_index = 1, 4 do redis.call('EXPIRE', KEYS[key_index], tonumber(ARGV[6])) end
end
return {1, current + 1}
`;

/**
 * The active-forget transition is one Redis transaction: withdrawal is appended
 * first, retention second, and only then is the Program stream made expirable.
 * No observer can see an active Program with a positive TTL.
 */
const ACTIVE_FORGET_LUA = `
local event_a = redis.call('HGET', KEYS[2], ARGV[1])
local client_a = redis.call('HGET', KEYS[3], ARGV[2])
local event_b = redis.call('HGET', KEYS[2], ARGV[4])
local client_b = redis.call('HGET', KEYS[3], ARGV[5])
if event_a or client_a or event_b or client_b then
  if event_a == ARGV[3] and client_a == ARGV[3] and event_b == ARGV[6] and client_b == ARGV[6] then
    return {0, -1}
  end
  return {-2, -1}
end

local current = redis.call('LLEN', KEYS[1])
if current ~= tonumber(ARGV[7]) then return {-1, current} end

redis.call('HSET', KEYS[2], ARGV[1], ARGV[3], ARGV[4], ARGV[6])
redis.call('HSET', KEYS[3], ARGV[2], ARGV[3], ARGV[5], ARGV[6])
redis.call('RPUSH', KEYS[1], ARGV[8], ARGV[9])
for key_index = 1, 4 do redis.call('EXPIRE', KEYS[key_index], tonumber(ARGV[10])) end
return {1, current + 2}
`;

const READ_WITH_TTL_LUA = `
local events = redis.call('LRANGE', KEYS[1], 0, -1)
local ttl = redis.call('TTL', KEYS[1])
return {events, ttl}
`;

function mapAppendResult(result: [number, number]): EvolutionProgramAppendResult {
  if (result[0] === 0) return { outcome: 'duplicate' };
  if (result[0] === -1) return { outcome: 'conflict', actualSequence: result[1] };
  if (result[0] === -2) return { outcome: 'idempotency_collision' };
  return { outcome: 'appended', sequence: result[1] };
}

function parseEvents(values: string[]): EvolutionProgramEventEnvelopeV1[] {
  return values.map((encoded) => evolutionProgramEventEnvelopeV1Schema.parse(JSON.parse(encoded)));
}

export class RedisEvolutionProgramEventLog implements IEvolutionProgramEventLog {
  constructor(private readonly redis: RedisClient) {}

  async append(
    rawEnvelope: EvolutionProgramEventEnvelopeV1,
    options: EvolutionProgramAppendOptions = {},
  ): Promise<EvolutionProgramAppendResult> {
    const envelope = evolutionProgramEventEnvelopeV1Schema.parse(rawEnvelope);
    requireSequence(envelope.expectedSequence, 'expectedSequence');
    if (options.ttlSeconds !== undefined) requireTtl(options.ttlSeconds);
    if (options.persist && options.ttlSeconds !== undefined) {
      throw new RangeError('append cannot expire and persist a Program in one event');
    }
    const workspaceId = envelope.event.type === 'program_created' ? envelope.event.workspaceId : '';
    const result = (await this.redis.eval(
      APPEND_LUA,
      4,
      EvolutionProgramKeys.eventLog(envelope.programId),
      EvolutionProgramKeys.eventIds(envelope.programId),
      EvolutionProgramKeys.clientMessageIds(envelope.programId),
      EvolutionProgramKeys.programIndex(envelope.programId),
      envelope.eventId,
      envelope.clientMessageId,
      evolutionEventIdentityDigest(envelope),
      envelope.expectedSequence.toString(),
      JSON.stringify(envelope),
      options.persist ? 'persist' : (options.ttlSeconds?.toString() ?? ''),
      workspaceId,
    )) as [number, number];
    return mapAppendResult(result);
  }

  async appendActiveForget(
    rawWithdrawal: EvolutionProgramEventEnvelopeV1,
    rawRetention: EvolutionProgramEventEnvelopeV1,
    ttlSeconds: number,
  ): Promise<EvolutionProgramAppendResult> {
    const withdrawal = evolutionProgramEventEnvelopeV1Schema.parse(rawWithdrawal);
    const retention = evolutionProgramEventEnvelopeV1Schema.parse(rawRetention);
    requireTtl(ttlSeconds);
    if (
      withdrawal.programId !== retention.programId ||
      withdrawal.event.type !== 'program_withdrawn' ||
      retention.event.type !== 'retention_opted_in' ||
      retention.expectedSequence !== withdrawal.expectedSequence + 1
    ) {
      throw new Error('active forget requires adjacent withdrawal and retention events for one Program');
    }
    const result = (await this.redis.eval(
      ACTIVE_FORGET_LUA,
      4,
      EvolutionProgramKeys.eventLog(withdrawal.programId),
      EvolutionProgramKeys.eventIds(withdrawal.programId),
      EvolutionProgramKeys.clientMessageIds(withdrawal.programId),
      EvolutionProgramKeys.programIndex(withdrawal.programId),
      withdrawal.eventId,
      withdrawal.clientMessageId,
      evolutionEventIdentityDigest(withdrawal),
      retention.eventId,
      retention.clientMessageId,
      evolutionEventIdentityDigest(retention),
      withdrawal.expectedSequence.toString(),
      JSON.stringify(withdrawal),
      JSON.stringify(retention),
      ttlSeconds.toString(),
    )) as [number, number];
    return mapAppendResult(result);
  }

  async read(programId: string): Promise<EvolutionProgramEventEnvelopeV1[]> {
    const raw = await this.redis.lrange(EvolutionProgramKeys.eventLog(programId), 0, -1);
    return parseEvents(raw);
  }

  async readWithTtl(programId: string): Promise<EvolutionProgramLogSnapshot> {
    const raw = (await this.redis.eval(READ_WITH_TTL_LUA, 1, EvolutionProgramKeys.eventLog(programId))) as unknown as [
      string[],
      number,
    ];
    return { events: parseEvents(raw[0]), ttl: raw[1] };
  }

  async listProgramIds(workspaceId: string): Promise<string[]> {
    const redisPrefix = this.redis.options.keyPrefix;
    if (typeof redisPrefix !== 'string') throw new Error('Evolution Program Redis requires a keyPrefix');
    if (redisPrefix.length === 0) throw new Error('Evolution Program Redis requires a non-empty keyPrefix');
    const logicalPrefix = EvolutionProgramKeys.programIndexPrefix;
    const matchPattern = `${redisPrefix}${logicalPrefix}*`;
    const programIds = new Set<string>();
    let cursor = '0';
    do {
      const [nextCursor, rawKeys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = nextCursor;
      const logicalKeys = rawKeys
        .map((key) => (redisPrefix && key.startsWith(redisPrefix) ? key.slice(redisPrefix.length) : key))
        .filter((key) => key.startsWith(logicalPrefix));
      if (logicalKeys.length === 0) continue;
      const indexedWorkspaces = await this.redis.mget(...logicalKeys);
      logicalKeys.forEach((key, index) => {
        const programId = key.slice(logicalPrefix.length);
        if (/^evolution-program:[0-9a-f]{32}$/.test(programId) && indexedWorkspaces[index] === workspaceId) {
          programIds.add(programId);
        }
      });
    } while (cursor !== '0');
    return [...programIds].sort();
  }

  ttl(programId: string): Promise<number> {
    return this.redis.ttl(EvolutionProgramKeys.eventLog(programId));
  }
}
