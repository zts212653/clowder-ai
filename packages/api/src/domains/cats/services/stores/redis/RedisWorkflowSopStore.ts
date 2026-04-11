import type { UpdateWorkflowSopInput, WorkflowSop } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IWorkflowSopStore } from '../ports/WorkflowSopStore.js';
import { VersionConflictError } from '../ports/WorkflowSopStore.js';
import { WorkflowSopKeys } from '../redis-keys/workflow-sop-keys.js';

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

/**
 * Lua script for atomic CAS upsert.
 * KEYS[1] = workflow:sop:{backlogItemId}
 * ARGV[1] = expectedVersion (-1 = skip CAS)
 * ARGV[2] = new SOP JSON string
 * ARGV[3] = TTL seconds (-1 = no TTL)
 *
 * Returns: "OK" on success, existing JSON on version mismatch.
 */
const CAS_UPSERT_LUA = `
local key = KEYS[1]
local expectedVersion = tonumber(ARGV[1])
local newJson = ARGV[2]
local ttl = tonumber(ARGV[3])

local existing = redis.call('GET', key)
if existing and expectedVersion >= 0 then
  local current = cjson.decode(existing)
  if current.version ~= expectedVersion then
    return existing
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
      return JSON.parse(raw) as WorkflowSop;
    } catch {
      return null;
    }
  }

  async upsert(
    backlogItemId: string,
    featureId: string,
    input: UpdateWorkflowSopInput,
    updatedBy: string,
  ): Promise<WorkflowSop> {
    const key = WorkflowSopKeys.detail(backlogItemId);

    // Read current state to build the new object
    const existing = await this.get(backlogItemId);
    const now = Date.now();

    const sop: WorkflowSop = existing
      ? {
          ...existing,
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

    const result = (await this.redis.eval(
      CAS_UPSERT_LUA,
      1, // numKeys
      key,
      String(expectedVersion),
      JSON.stringify(sop),
      String(ttl),
    )) as string;

    if (result !== 'OK') {
      // Lua returned existing JSON = version mismatch
      const current = JSON.parse(result) as WorkflowSop;
      throw new VersionConflictError(current);
    }

    return sop;
  }

  async delete(backlogItemId: string): Promise<boolean> {
    const key = WorkflowSopKeys.detail(backlogItemId);
    const count = await this.redis.del(key);
    return count > 0;
  }
}
