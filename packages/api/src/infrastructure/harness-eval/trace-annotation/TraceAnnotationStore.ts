import type { TraceAnnotation } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const ANNOTATION_PREFIX = 'trace-annotation:';
const ANNOTATION_CANONICAL_PREFIX = 'trace-annotation-canonical:';
const INCIDENT_PREFIX = 'trace-annotation-incident:';
const METRIC_INDEX_PREFIX = 'trace-annotation-metric-index:';

const annotationKey = (annotationId: string) => `${ANNOTATION_PREFIX}${annotationId}`;
const annotationCanonicalKey = (annotationId: string) => `${ANNOTATION_CANONICAL_PREFIX}${annotationId}`;
const incidentKey = (annotation: TraceAnnotation) =>
  `${INCIDENT_PREFIX}${annotation.episodeRef.ownerUserId}:${annotation.objectiveId}:${annotation.metricId}:${annotation.incidentKey}`;
const metricIndexKey = (ownerUserId: string, objectiveId: string, metricId: string) =>
  `${METRIC_INDEX_PREFIX}${ownerUserId}:${objectiveId}:${metricId}`;
const sequenceKey = (ownerUserId: string, objectiveId: string) =>
  `harness-annotation-seq:${ownerUserId}:${objectiveId}`;
const MAX_REDIS_SEQUENCE = '9223372036854775807';

function isIncrementableRedisSequence(value: string | null): boolean {
  if (value === null) return true;
  if (!(value === '0' || /^[1-9][0-9]*$/.test(value))) return false;
  return (
    value.length < MAX_REDIS_SEQUENCE.length ||
    (value.length === MAX_REDIS_SEQUENCE.length && value < MAX_REDIS_SEQUENCE)
  );
}

type AppendResult = { outcome: 'created' | 'duplicate'; annotationId: string };

interface FallbackKeys {
  incident: string;
  annotation: string;
  canonical: string;
  sequence: string;
  metricIndex: string;
}

/**
 * F257 R13: stable canonical JSON representation of an annotation, excluding
 * the store-assigned sequence and sorting object keys recursively. This is the
 * identity contract used for both the Lua atomic path and the sequential test
 * fallback.
 */
function canonicalJson(value: unknown): string {
  return stableStringify(value, true);
}

function stableStringify(value: unknown, omitStoreSequence = false): string {
  if (value === null) return 'null';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter(
      (key) =>
        !(omitStoreSequence && key === 'sequence') &&
        record[key] !== undefined &&
        typeof record[key] !== 'function' &&
        typeof record[key] !== 'symbol',
    )
    .sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${pairs.join(',')}}`;
}

/**
 * F257 R13: append annotation atomically through a single Redis Lua script.
 * The script preflights key types, claims the incident alias (authoritative
 * identity), verifies annotationId payload, assigns a monotonic sequence,
 * writes the annotation + canonical digest, and adds it to the metric index.
 * Either all of these happen, or none happen.
 */
export class TraceAnnotationStore {
  constructor(private readonly redis: RedisClient) {}

  private static readonly APPEND_ANNOTATION_LUA = `
-- @fake-redis-handler: appendAnnotation
local incidentKey = KEYS[1]
local annotationKey = KEYS[2]
local canonicalKey = KEYS[3]
local sequenceKey = KEYS[4]
local metricIndexKey = KEYS[5]

local annotationId = ARGV[1]
local incidentValue = ARGV[2]
local canonicalJson = ARGV[3]
local createdAt = ARGV[4]

local function isOk(reply)
  return reply == 'OK' or (type(reply) == 'table' and reply.ok == 'OK')
end

local function redisType(key)
  local reply = redis.call('TYPE', key)
  if type(reply) == 'table' then return reply.ok end
  return reply
end

local function checkOrError(key, expected)
  local actual = redisType(key)
  if actual == 'none' then return true end
  for _, allowed in ipairs(expected) do
    if actual == allowed then return true end
  end
  return false
end

-- Preflight every key we are about to touch so a WRONGTYPE cannot leave a
-- half-written annotation record.
if not checkOrError(incidentKey, {'string'}) then
  return {'error', 'incident_key_wrong_type'}
end
if not checkOrError(annotationKey, {'string'}) then
  return {'error', 'annotation_key_wrong_type'}
end
if not checkOrError(canonicalKey, {'string'}) then
  return {'error', 'canonical_key_wrong_type'}
end
if not checkOrError(sequenceKey, {'string'}) then
  return {'error', 'sequence_key_wrong_type'}
end
if not checkOrError(metricIndexKey, {'zset'}) then
  return {'error', 'metric_index_wrong_type'}
end

-- TYPE=string is not sufficient for INCR: reject non-canonical integers and
-- the signed 64-bit ceiling before claiming an incident alias. This keeps every
-- command after the first write free of data-dependent runtime errors.
local currentSequence = redis.call('GET', sequenceKey)
if currentSequence then
  local maxSequence = '9223372036854775807'
  local canonicalInteger = currentSequence == '0' or string.match(currentSequence, '^[1-9][0-9]*$')
  local exhausted = #currentSequence > #maxSequence or
    (#currentSequence == #maxSequence and currentSequence >= maxSequence)
  if not canonicalInteger or exhausted then
    return {'error', 'sequence_value_invalid'}
  end
end

-- The incident alias is the authoritative idempotency identity, including for
-- records written before the canonical sidecar existed. A read-only early
-- return preserves those legacy retries without mutating or rewriting them.
local existingIncidentAnnotationId = redis.call('GET', incidentKey)
if existingIncidentAnnotationId then
  return {'duplicate', existingIncidentAnnotationId}
end

-- R12 records can exist without the R13 canonical sidecar. Never interpret a
-- missing sidecar as permission to overwrite an existing annotation (or vice
-- versa); preserve the authoritative record and surface a fenced conflict.
local existingAnnotation = redis.call('GET', annotationKey)
local existingCanonical = redis.call('GET', canonicalKey)
if (existingAnnotation and not existingCanonical) or (existingCanonical and not existingAnnotation) then
  return {'conflict', annotationId}
end

-- Claim the incident-to-annotation alias. If the alias already exists, it is
-- the authoritative identity: return the annotationId it points to.
local claimed = redis.call('SET', incidentKey, incidentValue, 'NX')
if not isOk(claimed) then
  local existingAnnotationId = redis.call('GET', incidentKey)
  if existingAnnotationId and existingAnnotationId ~= annotationId then
    return {'duplicate', existingAnnotationId}
  end
  if existingAnnotationId == annotationId then
    return {'duplicate', annotationId}
  end
  -- Alias disappeared between SET and GET; fall through to annotation key check.
end

-- Annotation already exists: compare stable canonical digests.
if existingCanonical then
  if existingCanonical == canonicalJson then
    return {'duplicate', annotationId}
  end
  -- Conflict: roll back the incident alias we just claimed (if any).
  if isOk(claimed) then
    redis.call('DEL', incidentKey)
  end
  return {'conflict', annotationId}
end

local seq = redis.call('INCR', sequenceKey)
-- Append sequence to the stable canonical JSON before the closing brace.
local fullJson = string.sub(canonicalJson, 1, -2) .. ',"sequence":' .. seq .. '}'
redis.call('SET', annotationKey, fullJson)
redis.call('SET', canonicalKey, canonicalJson)
redis.call('ZADD', metricIndexKey, createdAt, annotationId)
return {'created', annotationId, tostring(seq)}
`;

  async append(annotation: TraceAnnotation): Promise<AppendResult> {
    if (!Number.isFinite(annotation.createdAt)) {
      throw new Error(`trace_annotation_invalid_created_at:${annotation.annotationId}`);
    }

    // Production Redis provides EVAL; test stubs without it fall back to a
    // sequential implementation. The real-Redis regression suite exercises the
    // atomic Lua path.
    if (typeof (this.redis as RedisClient & { eval?: unknown }).eval !== 'function') {
      return this.appendWithFallback(annotation);
    }

    const canonical = canonicalJson(annotation);
    const result = (await (this.redis as RedisClient & { eval: EvalLike }).eval(
      TraceAnnotationStore.APPEND_ANNOTATION_LUA,
      5,
      incidentKey(annotation),
      annotationKey(annotation.annotationId),
      annotationCanonicalKey(annotation.annotationId),
      sequenceKey(annotation.episodeRef.ownerUserId, annotation.objectiveId),
      metricIndexKey(annotation.episodeRef.ownerUserId, annotation.objectiveId, annotation.metricId),
      annotation.annotationId,
      annotation.annotationId,
      canonical,
      String(annotation.createdAt),
    )) as [string, string, string?];

    const [outcome, annotationId] = result;
    if (outcome === 'error' || outcome === 'conflict') {
      throw new Error(
        `${outcome === 'error' ? 'trace_annotation_preflight_failed' : 'trace_annotation_conflict'}:${annotationId}`,
      );
    }
    return { outcome: outcome as 'created' | 'duplicate', annotationId };
  }

  /**
   * Non-atomic fallback used only by test stubs that do not implement EVAL.
   * Keeps the same identity semantics (retry vs conflict) for serial tests.
   */
  private async appendWithFallback(annotation: TraceAnnotation): Promise<AppendResult> {
    const ownerUserId = annotation.episodeRef.ownerUserId;
    const objectiveId = annotation.objectiveId;
    const metricId = annotation.metricId;
    const keys: FallbackKeys = {
      incident: incidentKey(annotation),
      annotation: annotationKey(annotation.annotationId),
      canonical: annotationCanonicalKey(annotation.annotationId),
      sequence: sequenceKey(ownerUserId, objectiveId),
      metricIndex: metricIndexKey(ownerUserId, objectiveId, metricId),
    };
    const inspected = await this.inspectFallbackState(annotation, keys);
    if (inspected.duplicate) return inspected.duplicate;

    const claim = await this.claimFallbackIncident(annotation, keys.incident);
    if (claim.duplicate) return claim.duplicate;

    if (inspected.existingCanonical) {
      if (inspected.existingCanonical !== canonicalJson(annotation)) {
        await this.redis.del(keys.incident);
        throw new Error(`trace_annotation_conflict:${annotation.annotationId}`);
      }
      return { outcome: 'duplicate', annotationId: annotation.annotationId };
    }

    const sequence = Number(await this.redis.incr(keys.sequence));
    const scored = { ...annotation, sequence };

    const serialized = JSON.stringify(scored);
    const created = await this.redis.set(keys.annotation, serialized, 'NX');
    if (created !== 'OK') {
      return this.resolveFallbackRace(annotation, keys);
    }

    await this.redis.set(keys.canonical, canonicalJson(scored));
    await this.redis.zadd(keys.metricIndex, scored.createdAt, scored.annotationId);
    return { outcome: 'created', annotationId: scored.annotationId };
  }

  private async inspectFallbackState(
    annotation: TraceAnnotation,
    keys: FallbackKeys,
  ): Promise<{ existingCanonical: string | null; duplicate?: AppendResult }> {
    const existingIncidentId = await this.redis.get(keys.incident);
    if (existingIncidentId) {
      return {
        existingCanonical: null,
        duplicate: { outcome: 'duplicate', annotationId: existingIncidentId },
      };
    }

    const storedAnnotation = await this.redis.get(keys.annotation);
    const existingCanonical = await this.redis.get(keys.canonical);
    if ((storedAnnotation !== null) !== (existingCanonical !== null)) {
      throw new Error(`trace_annotation_conflict:${annotation.annotationId}`);
    }

    const currentSequence = await this.redis.get(keys.sequence);
    if (!isIncrementableRedisSequence(currentSequence)) {
      throw new Error('trace_annotation_preflight_failed:sequence_value_invalid');
    }
    return { existingCanonical };
  }

  private async claimFallbackIncident(annotation: TraceAnnotation, key: string): Promise<{ duplicate?: AppendResult }> {
    const claimed = await this.redis.set(key, annotation.annotationId, 'NX');
    if (claimed === 'OK') return {};

    const existingId = await this.redis.get(key);
    if (!existingId) throw new Error(`trace_annotation_incident_claim_lost:${annotation.incidentKey}`);
    return { duplicate: { outcome: 'duplicate', annotationId: existingId } };
  }

  private async resolveFallbackRace(annotation: TraceAnnotation, keys: FallbackKeys): Promise<AppendResult> {
    const raced = await this.redis.get(keys.annotation);
    if (!raced) throw new Error(`trace_annotation_race_lost:${annotation.annotationId}`);
    if (canonicalJson(JSON.parse(raced)) !== canonicalJson(annotation)) {
      await this.redis.del(keys.incident);
      throw new Error(`trace_annotation_conflict:${annotation.annotationId}`);
    }
    return { outcome: 'duplicate', annotationId: annotation.annotationId };
  }

  async get(annotationId: string): Promise<TraceAnnotation | null> {
    const raw = await this.redis.get(annotationKey(annotationId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TraceAnnotation;
    } catch {
      return null;
    }
  }

  async queryMetricWindow(
    ownerUserId: string,
    objectiveId: string,
    metricId: string,
    startAt: number,
    endAt: number,
  ): Promise<TraceAnnotation[]> {
    // Half-open score range [startAt, endAt) in annotation createdAt millis. An
    // annotation whose score equals the upper bound belongs to the next Unit run.
    const ids = await this.redis.zrangebyscore(
      metricIndexKey(ownerUserId, objectiveId, metricId),
      String(startAt),
      `(${endAt}`,
    );
    const out: TraceAnnotation[] = [];
    for (const id of ids) {
      const annotation = await this.get(id);
      if (annotation) out.push(annotation);
    }
    return out;
  }
}

type EvalLike = (script: string, numKeys: number, ...args: unknown[]) => Promise<unknown>;
