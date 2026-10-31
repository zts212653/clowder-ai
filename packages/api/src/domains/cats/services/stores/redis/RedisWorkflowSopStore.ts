import {
  type CatId,
  normalizeSopDefinitionId,
  type UpdateWorkflowSopInput,
  type WorkAdmission,
  type WorkAttempt,
  type WorkflowSop,
  type WorkflowSopAdmissionBundle,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IWorkflowSopStore } from '../ports/WorkflowSopStore.js';
import { VersionConflictError } from '../ports/WorkflowSopStore.js';
import { deriveWorkflowSopAdmissionIds, ManagedWorkKeys } from '../redis-keys/managed-work-keys.js';
import { WorkflowSopKeys } from '../redis-keys/workflow-sop-keys.js';
import { bindManagedWorkAttemptInRedis } from './managed-work-attempt-binding.js';

const DEFAULT_TTL = 0; // persistent — set >0 via env to enable expiry

const DEFAULT_CHECKS = {
  remoteMainSynced: 'unknown' as const,
  qualityGatePassed: 'unknown' as const,
  reviewApproved: 'unknown' as const,
  visionGuardDone: 'unknown' as const,
};

const DEFAULT_RESUME_CAPSULE = {
  goal: '',
  done: [] as string[],
  currentFocus: '',
};

function normalizeWorkflowSop(raw: WorkflowSop): WorkflowSop {
  return {
    ...raw,
    sopDefinitionId: normalizeSopDefinitionId(raw.sopDefinitionId),
  };
}

/**
 * Lua script for atomic CAS upsert plus eligible first-create admission.
 * KEYS[1] = workflow:sop:{backlogItemId}
 * KEYS[2] = managed-work:admission:{workId}
 * KEYS[3] = managed-work:attempt:{attemptId}
 * ARGV[1] = expectedVersion (-1 = skip CAS)
 * ARGV[2] = new SOP JSON string
 * ARGV[3] = TTL seconds (-1 = no TTL)
 * ARGV[4] = authenticated ownerUserId (required)
 * ARGV[5] = WorkAdmission JSON
 * ARGV[6] = WorkAttempt JSON
 *
 * Returns tagged strings so first-create races hydrate canonical Redis truth.
 */
const CAS_UPSERT_LUA = `
local key = KEYS[1]
local expectedVersion = tonumber(ARGV[1])
local newJson = ARGV[2]
local ttl = tonumber(ARGV[3])
local ownerUserId = ARGV[4]

local existing = redis.call('GET', key)
local incoming = cjson.decode(newJson)
if ownerUserId == '' then
  return 'MANAGED_WORK_CONFLICT:missing_authenticated_owner'
end
if existing and incoming.version == 1 then
  return 'EXISTING:' .. existing
end
if existing and expectedVersion >= 0 then
  local current = cjson.decode(existing)
  if current.version ~= expectedVersion then
    return 'CONFLICT:' .. existing
  end
end

if not existing and incoming.sopDefinitionId == 'development' and incoming.stage ~= 'completion' then
  local existingAdmission = redis.call('GET', KEYS[2])
  local existingAttempt = redis.call('GET', KEYS[3])
  if (existingAdmission and not existingAttempt) or (existingAttempt and not existingAdmission) then
    return 'MANAGED_WORK_CONFLICT:partial_identity_bundle'
  end
  if existingAdmission and existingAttempt then
    local admission = cjson.decode(existingAdmission)
    local attempt = cjson.decode(existingAttempt)
    local candidateAdmission = cjson.decode(ARGV[5])
    local candidateAttempt = cjson.decode(ARGV[6])
    if admission.workId ~= candidateAdmission.workId
      or admission.ownerUserId ~= candidateAdmission.ownerUserId
      or admission.producerKind ~= candidateAdmission.producerKind
      or admission.producerRef ~= candidateAdmission.producerRef
      or admission.initialAttemptId ~= candidateAdmission.initialAttemptId
      or attempt.attemptId ~= candidateAttempt.attemptId
      or attempt.workId ~= candidateAttempt.workId
      or attempt.attemptNumber ~= 1 then
      return 'MANAGED_WORK_CONFLICT:identity_mismatch'
    end
  else
    redis.call('SET', KEYS[2], ARGV[5])
    redis.call('SET', KEYS[3], ARGV[6])
  end
end

redis.call('SET', key, newJson)
if ttl > 0 then
  redis.call('EXPIRE', key, ttl)
end
return 'OK'
`;

export class RedisWorkflowSopStore implements IWorkflowSopStore {
  private readonly redis: RedisClient;
  private readonly ttlSeconds: number | null;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number }) {
    this.redis = redis;
    const ttl = options?.ttlSeconds;
    if (ttl === undefined) {
      this.ttlSeconds = DEFAULT_TTL;
    } else if (!Number.isFinite(ttl) || ttl <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(ttl);
    }
  }

  async get(backlogItemId: string): Promise<WorkflowSop | null> {
    const key = WorkflowSopKeys.detail(backlogItemId);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return normalizeWorkflowSop(JSON.parse(raw) as WorkflowSop);
    } catch {
      return null;
    }
  }

  async getManagedWorkAdmission(
    ownerUserId: string,
    backlogItemId: string,
  ): Promise<WorkflowSopAdmissionBundle | null> {
    const { workId, attemptId } = deriveWorkflowSopAdmissionIds(ownerUserId, backlogItemId);
    const [admissionRaw, attemptRaw] = await Promise.all([
      this.redis.get(ManagedWorkKeys.admission(workId)),
      this.redis.get(ManagedWorkKeys.attempt(attemptId)),
    ]);
    if (!admissionRaw && !attemptRaw) return null;
    if (!admissionRaw || !attemptRaw) {
      throw new Error(`Managed-work identity bundle is incomplete for ${workId}`);
    }

    try {
      const admission = JSON.parse(admissionRaw) as WorkAdmission;
      const attempt = JSON.parse(attemptRaw) as WorkAttempt;
      if (
        admission.workId !== workId ||
        admission.ownerUserId !== ownerUserId ||
        admission.producerKind !== 'workflow_sop_v1' ||
        admission.producerRef !== backlogItemId ||
        admission.initialAttemptId !== attemptId ||
        attempt.attemptId !== attemptId ||
        attempt.workId !== workId ||
        attempt.attemptNumber !== 1
      ) {
        throw new Error('identity fields do not match the admission anchor');
      }
      return { admission, attempt };
    } catch (error) {
      throw new Error(`Invalid managed-work identity bundle for ${workId}: ${String(error)}`);
    }
  }

  async bindManagedWorkAttempt(
    ownerUserId: string,
    backlogItemId: string,
    executorCatId: CatId,
  ): Promise<WorkflowSopAdmissionBundle | null> {
    return bindManagedWorkAttemptInRedis({ redis: this.redis, ownerUserId, backlogItemId, executorCatId });
  }

  async upsert(
    backlogItemId: string,
    featureId: string,
    input: UpdateWorkflowSopInput,
    updatedBy: string,
    ownerUserId: string,
  ): Promise<WorkflowSop> {
    if (typeof ownerUserId !== 'string' || ownerUserId.trim().length === 0) {
      throw new Error('WorkflowSop upsert requires authenticated ownerUserId');
    }
    const authenticatedOwnerUserId = ownerUserId.trim();
    const key = WorkflowSopKeys.detail(backlogItemId);

    // Read current state to build the new object
    const existing = await this.get(backlogItemId);
    const now = Date.now();

    const sop: WorkflowSop = existing
      ? {
          ...existing,
          sopDefinitionId: input.sopDefinitionId ?? existing.sopDefinitionId,
          stage: input.stage ?? existing.stage,
          batonHolder: input.batonHolder ?? existing.batonHolder,
          nextSkill: input.nextSkill !== undefined ? input.nextSkill : existing.nextSkill,
          resumeCapsule: input.resumeCapsule
            ? { ...existing.resumeCapsule, ...input.resumeCapsule }
            : existing.resumeCapsule,
          checks: input.checks ? { ...existing.checks, ...input.checks } : existing.checks,
          version: existing.version + 1,
          updatedAt: now,
          updatedBy,
        }
      : {
          featureId,
          backlogItemId,
          sopDefinitionId: input.sopDefinitionId ?? 'development',
          stage: input.stage ?? 'kickoff',
          batonHolder: input.batonHolder ?? updatedBy,
          nextSkill: input.nextSkill !== undefined ? input.nextSkill : null,
          resumeCapsule: input.resumeCapsule
            ? { ...DEFAULT_RESUME_CAPSULE, ...input.resumeCapsule }
            : { ...DEFAULT_RESUME_CAPSULE },
          checks: input.checks ? { ...DEFAULT_CHECKS, ...input.checks } : { ...DEFAULT_CHECKS },
          version: 1,
          updatedAt: now,
          updatedBy,
        };

    // Atomic CAS via Lua: Redis checks version inside the script
    const expectedVersion = input.expectedVersion !== undefined ? input.expectedVersion : -1;
    const ttl = this.ttlSeconds ?? -1;
    const { workId, attemptId } = deriveWorkflowSopAdmissionIds(authenticatedOwnerUserId, backlogItemId);
    const admission: WorkAdmission = {
      workId,
      ownerUserId: authenticatedOwnerUserId,
      producerKind: 'workflow_sop_v1',
      producerRef: backlogItemId,
      initialAttemptId: attemptId,
      admittedAt: now,
    };
    const attempt: WorkAttempt = {
      attemptId,
      workId,
      attemptNumber: 1,
      executorCatId: null,
      createdAt: now,
      executorBoundAt: null,
    };

    const result = (await this.redis.eval(
      CAS_UPSERT_LUA,
      3,
      key,
      ManagedWorkKeys.admission(workId),
      ManagedWorkKeys.attempt(attemptId),
      String(expectedVersion),
      JSON.stringify(sop),
      String(ttl),
      authenticatedOwnerUserId,
      JSON.stringify(admission),
      JSON.stringify(attempt),
    )) as string;

    if (result.startsWith('CONFLICT:')) {
      const current = normalizeWorkflowSop(JSON.parse(result.slice('CONFLICT:'.length)) as WorkflowSop);
      throw new VersionConflictError(current);
    }
    if (result.startsWith('EXISTING:')) {
      return normalizeWorkflowSop(JSON.parse(result.slice('EXISTING:'.length)) as WorkflowSop);
    }
    if (result.startsWith('MANAGED_WORK_CONFLICT:')) {
      throw new Error(`Managed-work admission failed closed: ${result.slice('MANAGED_WORK_CONFLICT:'.length)}`);
    }
    if (result !== 'OK') throw new Error(`Unexpected WorkflowSop upsert result: ${result}`);

    return sop;
  }

  async delete(backlogItemId: string): Promise<boolean> {
    const key = WorkflowSopKeys.detail(backlogItemId);
    const count = await this.redis.del(key);
    return count > 0;
  }
}
