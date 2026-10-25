import { type RoutingSignalEventV1, type RoutingSubjectRefV1, routingSignalEventV1Schema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  advanceRoutingSignalDecisionProjectionSequence,
  buildRoutingSignalDecisionProjection,
  parseRoutingSignalDecisionProjection,
  type RoutingSignalDecisionProjectionV1,
} from './preflight/RoutingSignalDecisionProjection.js';
import {
  type IRoutingSignalEventStore,
  type RoutingSignalEventAppendResult,
  RoutingSignalEventConflictError,
  RoutingSignalEventHydrationError,
} from './RoutingSignalEventStore.js';

const APPEND_EVENT_LUA = `
local function allowed_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  return actual == 'none' or actual == expected
end

local close_count = tonumber(ARGV[5])
if not close_count or #KEYS ~= 7 + close_count or #ARGV ~= 5 + close_count then
  return {'INVALID_ARGUMENTS', ''}
end
if not allowed_type(KEYS[1], 'string') or not allowed_type(KEYS[2], 'string') or
   not allowed_type(KEYS[3], 'zset') or not allowed_type(KEYS[4], 'zset') or
   not allowed_type(KEYS[5], 'hash') or not allowed_type(KEYS[6], 'string') then
  return {'TYPE_CONFLICT', ''}
end
local sequence_type = redis.call('TYPE', KEYS[7])['ok']
if sequence_type ~= 'none' and sequence_type ~= 'zset' then
  redis.call('DEL', KEYS[7])
end
local revision_raw = redis.call('GET', KEYS[6])
if revision_raw and not string.match(revision_raw, '^%d+$') then return {'TYPE_CONFLICT', ''} end
for i = 1, close_count do
  if not allowed_type(KEYS[7 + i], 'string') then
    return {'TYPE_CONFLICT', ''}
  end
end

local existing_command = redis.call('GET', KEYS[1])
if existing_command then
  if existing_command ~= ARGV[1] then return {'COMMAND_CONFLICT', ''} end
  local existing_detail = redis.call('GET', KEYS[2])
  if existing_detail ~= ARGV[1] then return {'CORRUPT_REPLAY', ''} end
  if not redis.call('ZSCORE', KEYS[3], ARGV[2]) or not redis.call('ZSCORE', KEYS[4], ARGV[2]) then
    return {'CORRUPT_REPLAY', ''}
  end
  for i = 1, close_count do
    if redis.call('HGET', KEYS[5], ARGV[5 + i]) ~= ARGV[2] then
      return {'CORRUPT_REPLAY', ''}
    end
  end
  return {'REPLAYED', existing_detail}
end
if redis.call('EXISTS', KEYS[2]) == 1 then return {'EVENT_CONFLICT', ''} end

for i = 1, close_count do
  local assertion_raw = redis.call('GET', KEYS[7 + i])
  if not assertion_raw or redis.call('HEXISTS', KEYS[5], ARGV[5 + i]) == 1 then
    return {'CLOSURE_CONFLICT', ''}
  end
  local decoded_ok, assertion = pcall(cjson.decode, assertion_raw)
  if not decoded_ok or type(assertion) ~= 'table' or assertion['eventType'] ~= 'asserted' then
    return {'CLOSURE_CONFLICT', ''}
  end
end

redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[2])
redis.call('ZADD', KEYS[4], tonumber(ARGV[3]), ARGV[2])
for i = 1, close_count do
  redis.call('HSET', KEYS[5], ARGV[5 + i], ARGV[2])
end
local next_revision = redis.call('INCR', KEYS[6])
redis.call('ZADD', KEYS[7], next_revision, ARGV[2])
return {'APPENDED', ARGV[1]}
`;

const STORE_DECISION_PROJECTION_LUA = `
local revision_type = redis.call('TYPE', KEYS[1])['ok']
local projection_type = redis.call('TYPE', KEYS[2])['ok']
if (revision_type ~= 'none' and revision_type ~= 'string') or
   (projection_type ~= 'none' and projection_type ~= 'string') then
  return 'TYPE_CONFLICT'
end
local current = redis.call('GET', KEYS[1]) or '0'
if current ~= ARGV[1] then return 'REVISION_MISMATCH' end
redis.call('SET', KEYS[2], ARGV[2])
return 'STORED'
`;

function keyPart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function subjectIdentity(subjectRef: RoutingSubjectRefV1): string {
  if (subjectRef.type === 'cat') return `cat:${subjectRef.catId}`;
  if (subjectRef.type === 'provider') return `provider:${subjectRef.providerId}`;
  return `quota_pool:${subjectRef.poolId}`;
}

export const RoutingSignalEventKeys = {
  detail: (ownerId: string, eventId: string) => `routing-context:signals:${keyPart(ownerId)}:event:${keyPart(eventId)}`,
  command: (ownerId: string, commandId: string) =>
    `routing-context:signals:${keyPart(ownerId)}:command:${keyPart(commandId)}`,
  ownerTimeline: (ownerId: string) => `routing-context:signals:${keyPart(ownerId)}:timeline`,
  ownerRevision: (ownerId: string) => `routing-context:signals:${keyPart(ownerId)}:revision`,
  ownerAppendSequence: (ownerId: string) => `routing-context:signals:${keyPart(ownerId)}:append-sequence`,
  decisionProjection: (ownerId: string) => `routing-context:signals:${keyPart(ownerId)}:decision-projection:v1`,
  subjectTimeline: (ownerId: string, subjectRef: RoutingSubjectRefV1) =>
    `routing-context:signals:${keyPart(ownerId)}:subject:${keyPart(subjectIdentity(subjectRef))}:timeline`,
  closures: (ownerId: string) => `routing-context:signals:${keyPart(ownerId)}:closures`,
} as const;

export class RedisRoutingSignalEventStore implements IRoutingSignalEventStore {
  constructor(private readonly redis: RedisClient) {}

  async append(eventInput: RoutingSignalEventV1): Promise<RoutingSignalEventAppendResult> {
    const event = routingSignalEventV1Schema.parse(eventInput);
    const raw = JSON.stringify(event);
    const closesSignalIds = event.eventType === 'asserted' ? [] : event.closesSignalIds;
    const keys = [
      RoutingSignalEventKeys.command(event.ownerId, event.commandId),
      RoutingSignalEventKeys.detail(event.ownerId, event.eventId),
      RoutingSignalEventKeys.ownerTimeline(event.ownerId),
      RoutingSignalEventKeys.subjectTimeline(event.ownerId, event.subjectRef),
      RoutingSignalEventKeys.closures(event.ownerId),
      RoutingSignalEventKeys.ownerRevision(event.ownerId),
      RoutingSignalEventKeys.ownerAppendSequence(event.ownerId),
      ...closesSignalIds.map((eventId) => RoutingSignalEventKeys.detail(event.ownerId, eventId)),
    ];
    const result = (await this.redis.eval(
      APPEND_EVENT_LUA,
      keys.length,
      ...keys,
      raw,
      event.eventId,
      String(event.observedAt),
      event.eventType,
      String(closesSignalIds.length),
      ...closesSignalIds,
    )) as [string, string];
    const [outcome, payload] = result;
    if (outcome === 'APPENDED') return { outcome: 'appended', event: this.parsePersisted(payload, event.eventId) };
    if (outcome === 'REPLAYED') return { outcome: 'replayed', event: this.parsePersisted(payload, event.eventId) };
    if (outcome === 'COMMAND_CONFLICT') {
      throw new RoutingSignalEventConflictError(`routing signal command conflict: ${event.commandId}`);
    }
    if (outcome === 'EVENT_CONFLICT') {
      throw new RoutingSignalEventConflictError(`routing signal event id conflict: ${event.eventId}`);
    }
    if (outcome === 'CLOSURE_CONFLICT') {
      throw new RoutingSignalEventConflictError(`routing signal closure conflict: ${event.eventId}`);
    }
    if (outcome === 'TYPE_CONFLICT') {
      throw new RoutingSignalEventHydrationError(`routing signal Redis type conflict: ${event.eventId}`);
    }
    if (outcome === 'CORRUPT_REPLAY') {
      throw new RoutingSignalEventHydrationError(`routing signal replay indexes are inconsistent: ${event.eventId}`);
    }
    throw new RoutingSignalEventHydrationError(`routing signal append failed (${outcome}): ${event.eventId}`);
  }

  async get(ownerId: string, eventId: string): Promise<RoutingSignalEventV1 | null> {
    const raw = await this.redis.get(RoutingSignalEventKeys.detail(ownerId, eventId));
    return raw === null ? null : this.parsePersisted(raw, eventId);
  }

  async getByCommand(ownerId: string, commandId: string): Promise<RoutingSignalEventV1 | null> {
    const raw = await this.redis.get(RoutingSignalEventKeys.command(ownerId, commandId));
    return raw === null ? null : this.parsePersisted(raw, `command:${commandId}`);
  }

  async getOwnerRevision(ownerId: string): Promise<number> {
    const raw = await this.redis.get(RoutingSignalEventKeys.ownerRevision(ownerId));
    if (raw === null) return 0;
    if (!/^(0|[1-9]\d*)$/.test(raw)) {
      throw new RoutingSignalEventHydrationError(`malformed routing signal owner revision: ${ownerId}`);
    }
    const revision = Number(raw);
    if (!Number.isSafeInteger(revision)) {
      throw new RoutingSignalEventHydrationError(`unsafe routing signal owner revision: ${ownerId}`);
    }
    return revision;
  }

  async readDecisionProjection(ownerId: string): Promise<RoutingSignalDecisionProjectionV1> {
    let projection = await this.readPersistedDecisionProjection(ownerId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const targetRevision = await this.getOwnerRevision(ownerId);
      projection = await this.projectDecisionRevision(ownerId, projection, targetRevision);

      if (projection.revision !== (await this.getOwnerRevision(ownerId))) continue;
      const stored = await this.persistDecisionProjection(ownerId, projection);
      if (stored) return projection;
    }
    throw new RoutingSignalEventHydrationError(
      `routing signal projection could not reach a stable revision: ${ownerId}`,
    );
  }

  private async projectDecisionRevision(
    ownerId: string,
    projection: RoutingSignalDecisionProjectionV1 | null,
    targetRevision: number,
  ): Promise<RoutingSignalDecisionProjectionV1> {
    if (projection === null || projection.revision > targetRevision) {
      return this.rebuildDecisionProjection(ownerId);
    }
    if (projection.revision === targetRevision) return projection;
    const deltas = await this.readAppendSequence(ownerId, projection.revision + 1, targetRevision);
    if (deltas === null) return this.rebuildDecisionProjection(ownerId);
    try {
      return advanceRoutingSignalDecisionProjectionSequence(projection, deltas);
    } catch {
      return this.rebuildDecisionProjection(ownerId);
    }
  }

  async listByOwner(ownerId: string): Promise<RoutingSignalEventV1[]> {
    return this.listTimeline(ownerId, RoutingSignalEventKeys.ownerTimeline(ownerId));
  }

  async listBySubject(ownerId: string, subjectRef: RoutingSubjectRefV1): Promise<RoutingSignalEventV1[]> {
    return this.listTimeline(ownerId, RoutingSignalEventKeys.subjectTimeline(ownerId, subjectRef));
  }

  private async listTimeline(ownerId: string, timelineKey: string): Promise<RoutingSignalEventV1[]> {
    const eventIds = await this.redis.zrange(timelineKey, 0, -1);
    if (eventIds.length === 0) return [];
    const raws = await this.redis.mget(...eventIds.map((eventId) => RoutingSignalEventKeys.detail(ownerId, eventId)));
    return raws.map((raw, index) => {
      if (raw === null) {
        throw new RoutingSignalEventHydrationError(`malformed persisted routing signal: missing ${eventIds[index]}`);
      }
      return this.parsePersisted(raw, eventIds[index]);
    });
  }

  private async readPersistedDecisionProjection(ownerId: string): Promise<RoutingSignalDecisionProjectionV1 | null> {
    const key = RoutingSignalEventKeys.decisionProjection(ownerId);
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('WRONGTYPE')) throw error;
      await this.redis.del(key);
      return null;
    }
    if (raw === null) return null;
    try {
      return parseRoutingSignalDecisionProjection(JSON.parse(raw), ownerId);
    } catch {
      return null;
    }
  }

  private async rebuildDecisionProjection(ownerId: string): Promise<RoutingSignalDecisionProjectionV1> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const revisionBefore = await this.getOwnerRevision(ownerId);
      const events = await this.listByOwner(ownerId);
      const revisionAfter = await this.getOwnerRevision(ownerId);
      if (revisionBefore === revisionAfter) {
        return buildRoutingSignalDecisionProjection({ ownerId, revision: revisionAfter, events });
      }
    }
    throw new RoutingSignalEventHydrationError(
      `routing signal owner revision changed during projection rebuild: ${ownerId}`,
    );
  }

  private async readAppendSequence(
    ownerId: string,
    firstRevision: number,
    lastRevision: number,
  ): Promise<RoutingSignalEventV1[] | null> {
    const eventIds = await this.redis.zrangebyscore(
      RoutingSignalEventKeys.ownerAppendSequence(ownerId),
      firstRevision,
      lastRevision,
    );
    if (eventIds.length !== lastRevision - firstRevision + 1) return null;
    const raws = await this.redis.mget(...eventIds.map((eventId) => RoutingSignalEventKeys.detail(ownerId, eventId)));
    const events: RoutingSignalEventV1[] = [];
    for (const [index, raw] of raws.entries()) {
      if (raw === null) return null;
      events.push(this.parsePersisted(raw, eventIds[index]));
    }
    return events;
  }

  private async persistDecisionProjection(
    ownerId: string,
    projection: RoutingSignalDecisionProjectionV1,
  ): Promise<boolean> {
    const outcome = (await this.redis.eval(
      STORE_DECISION_PROJECTION_LUA,
      2,
      RoutingSignalEventKeys.ownerRevision(ownerId),
      RoutingSignalEventKeys.decisionProjection(ownerId),
      String(projection.revision),
      JSON.stringify(projection),
    )) as string;
    if (outcome === 'STORED') return true;
    if (outcome === 'REVISION_MISMATCH') return false;
    if (outcome === 'TYPE_CONFLICT') {
      throw new RoutingSignalEventHydrationError(`routing signal projection Redis type conflict: ${ownerId}`);
    }
    throw new RoutingSignalEventHydrationError(`routing signal projection persist failed (${outcome}): ${ownerId}`);
  }

  private parsePersisted(raw: string, eventId: string): RoutingSignalEventV1 {
    try {
      const parsed = routingSignalEventV1Schema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Fall through to the typed fail-closed boundary below.
    }
    throw new RoutingSignalEventHydrationError(`malformed persisted routing signal: ${eventId}`);
  }
}
