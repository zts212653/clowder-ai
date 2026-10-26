import type { RoutingSubjectRefV1 } from '@cat-cafe/shared';

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

export const APPEND_ROUTING_SIGNAL_EVENT_LUA = `
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
  return {'REPLAYED', existing_detail, revision_raw or '0'}
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
return {'APPENDED', ARGV[1], tostring(next_revision)}
`;

export const STORE_ROUTING_SIGNAL_DECISION_PROJECTION_LUA = `
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
