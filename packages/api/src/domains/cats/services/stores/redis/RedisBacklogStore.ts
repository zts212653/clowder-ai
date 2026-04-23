import type {
  AcquireBacklogLeaseInput,
  AtomicDispatchInput,
  BacklogDependencies,
  BacklogItem,
  BacklogLease,
  CreateBacklogItemInput,
  DecideBacklogClaimInput,
  DispatchBacklogItemInput,
  HeartbeatBacklogLeaseInput,
  MarkDoneInput,
  ReclaimBacklogLeaseInput,
  RefreshBacklogItemInput,
  ReleaseBacklogLeaseInput,
  SuggestBacklogClaimInput,
  ThreadPhase,
  UpdateBacklogDispatchProgressInput,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IBacklogStore } from '../ports/BacklogStore.js';
import { BacklogTransitionError } from '../ports/BacklogStore.js';
import { generateSortableId } from '../ports/MessageStore.js';
import { BacklogKeys } from '../redis-keys/backlog-keys.js';
import { makeCatActor, makeCreatorActor, makeUserActor } from '../shared/backlog-audit-actors.js';

const DEFAULT_TTL = 0; // persistent — set >0 via env to enable expiry

/**
 * KEYS[1] = backlog:item:{id}
 * ARGV[1] = now
 * ARGV[2] = catId
 * ARGV[3] = expiresAt
 * ARGV[4] = auditEntry(json)
 *
 * return: 1 success, -1 missing, -2 status!=dispatched, -3 active lease owned by another cat
 */
const LEASE_ACQUIRE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local catId = ARGV[2]
local expiresAt = tonumber(ARGV[3])
local auditEntryRaw = ARGV[4]

if redis.call('HGET', key, 'id') == false then
  return -1
end

if redis.call('HGET', key, 'status') ~= 'dispatched' then
  return -2
end

local leaseRaw = redis.call('HGET', key, 'lease')
if leaseRaw and leaseRaw ~= '' then
  local okLease, lease = pcall(cjson.decode, leaseRaw)
  if okLease and lease and lease['state'] == 'active' and tonumber(lease['expiresAt'] or 0) > now and lease['ownerCatId'] ~= catId then
    return -3
  end
end

local audit = {}
local auditRaw = redis.call('HGET', key, 'audit')
if auditRaw and auditRaw ~= '' then
  local okAudit, decodedAudit = pcall(cjson.decode, auditRaw)
  if okAudit and type(decodedAudit) == 'table' then
    audit = decodedAudit
  end
end

local okEntry, auditEntry = pcall(cjson.decode, auditEntryRaw)
if okEntry and type(auditEntry) == 'table' then
  table.insert(audit, auditEntry)
end

local leaseObj = {
  ownerCatId = catId,
  state = 'active',
  acquiredAt = now,
  heartbeatAt = now,
  expiresAt = expiresAt,
}

redis.call('HSET', key,
  'lease', cjson.encode(leaseObj),
  'updatedAt', tostring(now),
  'audit', cjson.encode(audit)
)

return 1
`;

/**
 * KEYS[1] = backlog:item:{id}
 * ARGV[1] = now
 * ARGV[2] = catId
 * ARGV[3] = expiresAt
 * ARGV[4] = auditEntry(json)
 *
 * return: 1 success, -1 missing, -2 status!=dispatched, -4 no active lease,
 *         -5 owner mismatch, -6 lease expired
 */
const LEASE_HEARTBEAT_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local catId = ARGV[2]
local expiresAt = tonumber(ARGV[3])
local auditEntryRaw = ARGV[4]

if redis.call('HGET', key, 'id') == false then
  return -1
end

if redis.call('HGET', key, 'status') ~= 'dispatched' then
  return -2
end

local leaseRaw = redis.call('HGET', key, 'lease')
if not leaseRaw or leaseRaw == '' then
  return -4
end

local okLease, lease = pcall(cjson.decode, leaseRaw)
if not okLease or not lease or lease['state'] ~= 'active' then
  return -4
end

if lease['ownerCatId'] ~= catId then
  return -5
end

if tonumber(lease['expiresAt'] or 0) <= now then
  return -6
end

local audit = {}
local auditRaw = redis.call('HGET', key, 'audit')
if auditRaw and auditRaw ~= '' then
  local okAudit, decodedAudit = pcall(cjson.decode, auditRaw)
  if okAudit and type(decodedAudit) == 'table' then
    audit = decodedAudit
  end
end

local okEntry, auditEntry = pcall(cjson.decode, auditEntryRaw)
if okEntry and type(auditEntry) == 'table' then
  table.insert(audit, auditEntry)
end

lease['heartbeatAt'] = now
lease['expiresAt'] = expiresAt

redis.call('HSET', key,
  'lease', cjson.encode(lease),
  'updatedAt', tostring(now),
  'audit', cjson.encode(audit)
)

return 1
`;

/**
 * KEYS[1] = backlog:item:{id}
 * ARGV[1] = now
 * ARGV[2] = expectedCatId(optional; empty means no owner check)
 * ARGV[3] = actorId
 * ARGV[4] = auditEntry(json)
 *
 * return: 1 success, 2 noop(no active lease), -1 missing, -2 status!=dispatched, -5 owner mismatch
 */
const LEASE_RELEASE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local expectedCatId = ARGV[2]
local actorId = ARGV[3]
local auditEntryRaw = ARGV[4]

if redis.call('HGET', key, 'id') == false then
  return -1
end

if redis.call('HGET', key, 'status') ~= 'dispatched' then
  return -2
end

local leaseRaw = redis.call('HGET', key, 'lease')
if not leaseRaw or leaseRaw == '' then
  return 2
end

local okLease, lease = pcall(cjson.decode, leaseRaw)
if not okLease or not lease or lease['state'] ~= 'active' then
  return 2
end

if expectedCatId ~= '' and lease['ownerCatId'] ~= expectedCatId then
  return -5
end

local audit = {}
local auditRaw = redis.call('HGET', key, 'audit')
if auditRaw and auditRaw ~= '' then
  local okAudit, decodedAudit = pcall(cjson.decode, auditRaw)
  if okAudit and type(decodedAudit) == 'table' then
    audit = decodedAudit
  end
end

local okEntry, auditEntry = pcall(cjson.decode, auditEntryRaw)
if okEntry and type(auditEntry) == 'table' then
  table.insert(audit, auditEntry)
end

lease['state'] = 'released'
lease['releasedAt'] = now
lease['releasedBy'] = actorId

redis.call('HSET', key,
  'lease', cjson.encode(lease),
  'updatedAt', tostring(now),
  'audit', cjson.encode(audit)
)

return 1
`;

/**
 * KEYS[1] = backlog:item:{id}
 * ARGV[1] = now
 * ARGV[2] = actorId
 * ARGV[3] = auditEntry(json)
 *
 * return: 1 success, 2 noop(no active lease), -1 missing, -2 status!=dispatched, -7 lease not expired
 */
const LEASE_RECLAIM_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local actorId = ARGV[2]
local auditEntryRaw = ARGV[3]

if redis.call('HGET', key, 'id') == false then
  return -1
end

if redis.call('HGET', key, 'status') ~= 'dispatched' then
  return -2
end

local leaseRaw = redis.call('HGET', key, 'lease')
if not leaseRaw or leaseRaw == '' then
  return 2
end

local okLease, lease = pcall(cjson.decode, leaseRaw)
if not okLease or not lease or lease['state'] ~= 'active' then
  return 2
end

if tonumber(lease['expiresAt'] or 0) > now then
  return -7
end

local audit = {}
local auditRaw = redis.call('HGET', key, 'audit')
if auditRaw and auditRaw ~= '' then
  local okAudit, decodedAudit = pcall(cjson.decode, auditRaw)
  if okAudit and type(decodedAudit) == 'table' then
    audit = decodedAudit
  end
end

local okEntry, auditEntry = pcall(cjson.decode, auditEntryRaw)
if okEntry and type(auditEntry) == 'table' then
  table.insert(audit, auditEntry)
end

lease['state'] = 'reclaimed'
lease['reclaimedAt'] = now
lease['reclaimedBy'] = actorId

redis.call('HSET', key,
  'lease', cjson.encode(lease),
  'updatedAt', tostring(now),
  'audit', cjson.encode(audit)
)

return 1
`;

/**
 * Atomic dispatch: approved → dispatched in one Redis operation.
 * KEYS[1] = backlog:item:{id}
 * ARGV[1] = now
 * ARGV[2] = dispatchAttemptId
 * ARGV[3] = pendingThreadId
 * ARGV[4] = kickoffMessageId
 * ARGV[5] = threadId
 * ARGV[6] = threadPhase
 * ARGV[7] = auditEntry(json)
 *
 * return: 1 success, 2 idempotent (already dispatched to same thread),
 *         -1 missing, -2 not approved, -3 dispatched to different thread
 */
const ATOMIC_DISPATCH_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local dispatchAttemptId = ARGV[2]
local pendingThreadId = ARGV[3]
local kickoffMessageId = ARGV[4]
local threadId = ARGV[5]
local threadPhase = ARGV[6]
local auditEntryRaw = ARGV[7]

if redis.call('HGET', key, 'id') == false then
  return -1
end

local status = redis.call('HGET', key, 'status')

if status == 'dispatched' then
  local existingThread = redis.call('HGET', key, 'dispatchedThreadId') or ''
  local existingPhase = redis.call('HGET', key, 'dispatchedThreadPhase') or ''
  if existingThread == threadId and existingPhase == threadPhase then
    return 2
  end
  return -3
end

if status ~= 'approved' then
  return -2
end

local audit = {}
local auditRaw = redis.call('HGET', key, 'audit')
if auditRaw and auditRaw ~= '' then
  local okAudit, decodedAudit = pcall(cjson.decode, auditRaw)
  if okAudit and type(decodedAudit) == 'table' then
    audit = decodedAudit
  end
end

local okEntry, auditEntry = pcall(cjson.decode, auditEntryRaw)
if okEntry and type(auditEntry) == 'table' then
  table.insert(audit, auditEntry)
end

redis.call('HSET', key,
  'status', 'dispatched',
  'dispatchAttemptId', dispatchAttemptId,
  'pendingThreadId', pendingThreadId,
  'kickoffMessageId', kickoffMessageId,
  'dispatchedThreadId', threadId,
  'dispatchedThreadPhase', threadPhase,
  'dispatchedAt', tostring(now),
  'updatedAt', tostring(now),
  'audit', cjson.encode(audit)
)

return 1
`;

export class RedisBacklogStore implements IBacklogStore {
  private readonly redis: RedisClient;
  private readonly ttlSeconds: number | null;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number }) {
    this.redis = redis;
    const raw = options?.ttlSeconds ?? DEFAULT_TTL;
    if (!Number.isFinite(raw) || raw <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(raw);
    }
  }

  async create(input: CreateBacklogItemInput): Promise<BacklogItem> {
    const now = Date.now();
    const item: BacklogItem = {
      id: generateSortableId(now),
      userId: input.userId,
      title: input.title,
      summary: input.summary,
      priority: input.priority,
      tags: [...input.tags],
      status: input.initialStatus ?? 'open',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      audit: [
        {
          id: generateSortableId(now + 1),
          action: 'created',
          actor: makeCreatorActor(input),
          timestamp: now,
          detail: input.title,
        },
        // When importing as done, add done audit + doneAt in one shot
        ...(input.initialStatus === 'done'
          ? [
              {
                id: generateSortableId(now + 2),
                action: 'done' as const,
                actor: makeCreatorActor(input),
                timestamp: now,
                detail: 'imported as done',
              },
            ]
          : []),
      ],
      ...(input.initialStatus === 'done' ? { doneAt: now } : {}),
    };

    await this.writeItem(item);
    const pipeline = this.redis.multi();
    pipeline.zadd(BacklogKeys.userList(item.userId), String(item.createdAt), item.id);
    if (this.ttlSeconds !== null) {
      pipeline.expire(BacklogKeys.userList(item.userId), this.ttlSeconds);
    }
    await pipeline.exec();
    return item;
  }

  async refreshMetadata(itemId: string, input: RefreshBacklogItemInput): Promise<BacklogItem | null> {
    const existing = await this.get(itemId);
    if (!existing) return null;

    // Status upgrade: only open→dispatched or open→done, never downgrade
    const statusUpgrade =
      input.importStatus && existing.status === 'open' && input.importStatus !== 'open'
        ? input.importStatus
        : undefined;

    const unchanged =
      existing.title === input.title &&
      existing.summary === input.summary &&
      existing.priority === input.priority &&
      this.sameTags(existing.tags, input.tags) &&
      this.sameDependencies(existing.dependencies, input.dependencies) &&
      !statusUpgrade;
    if (unchanged) return existing;

    const now = Date.now();
    const updated: BacklogItem = {
      ...existing,
      title: input.title,
      summary: input.summary,
      priority: input.priority,
      tags: [...input.tags],
      ...(input.dependencies !== undefined ? { dependencies: input.dependencies } : {}),
      ...(statusUpgrade ? { status: statusUpgrade } : {}),
      updatedAt: now,
      audit: [
        ...existing.audit,
        {
          id: generateSortableId(now + 1),
          action: 'refreshed',
          actor: makeUserActor(input.refreshedBy),
          timestamp: now,
          detail: statusUpgrade ? `docs-backlog-sync (status: ${statusUpgrade})` : 'docs-backlog-sync',
        },
      ],
    };
    await this.writeItem(updated);
    return updated;
  }

  async get(itemId: string, userId?: string): Promise<BacklogItem | null> {
    const data = await this.redis.hgetall(BacklogKeys.detail(itemId));
    if (!data || !data.id) return null;
    const item = this.hydrateItem(data);
    if (userId && item.userId !== userId) return null;
    return item;
  }

  async listByUser(userId: string): Promise<BacklogItem[]> {
    const ids = await this.redis.zrevrange(BacklogKeys.userList(userId), 0, -1);
    if (ids.length === 0) return [];

    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.hgetall(BacklogKeys.detail(id));
    }
    const rows = await pipeline.exec();
    if (!rows) return [];

    const result: BacklogItem[] = [];
    for (const [err, data] of rows) {
      if (err || !data || typeof data !== 'object') continue;
      const row = data as Record<string, string>;
      if (!row.id) continue;
      result.push(this.hydrateItem(row));
    }
    return result;
  }

  async suggestClaim(itemId: string, input: SuggestBacklogClaimInput): Promise<BacklogItem | null> {
    const existing = await this.get(itemId);
    if (!existing) return null;
    if (existing.status === 'suggested' && existing.suggestion?.status === 'pending') {
      if (existing.suggestion.catId === input.catId) {
        return existing;
      }
      throw new BacklogTransitionError('Invalid backlog transition: item already suggested by another cat');
    }
    if (existing.status !== 'open') {
      throw new BacklogTransitionError('Invalid backlog transition: only open items can be suggested');
    }

    const now = Date.now();
    const updated: BacklogItem = {
      ...existing,
      status: 'suggested',
      suggestion: {
        catId: input.catId,
        why: input.why,
        plan: input.plan,
        requestedPhase: input.requestedPhase,
        status: 'pending',
        suggestedAt: now,
      },
      updatedAt: now,
      audit: [
        ...existing.audit,
        {
          id: generateSortableId(now + 1),
          action: 'suggested',
          actor: makeCatActor(input.catId),
          timestamp: now,
          detail: input.plan,
        },
      ],
    };

    await this.writeItem(updated);
    return updated;
  }

  async decideClaim(itemId: string, input: DecideBacklogClaimInput): Promise<BacklogItem | null> {
    const existing = await this.get(itemId);
    if (!existing) return null;
    if (existing.status !== 'suggested' || !existing.suggestion || existing.suggestion.status !== 'pending') {
      throw new BacklogTransitionError('Invalid backlog transition: item is not waiting for decision');
    }

    const now = Date.now();
    if (input.decision === 'reject') {
      const rejectedSuggestionBase = {
        ...existing.suggestion,
        status: 'rejected' as const,
        decidedAt: now,
        decidedBy: input.decidedBy,
      };
      const rejectedSuggestion = input.note ? { ...rejectedSuggestionBase, note: input.note } : rejectedSuggestionBase;
      const rejectAuditBase = {
        id: generateSortableId(now + 1),
        action: 'rejected' as const,
        actor: makeUserActor(input.decidedBy),
        timestamp: now,
      };
      const rejectAudit = input.note ? { ...rejectAuditBase, detail: input.note } : rejectAuditBase;
      const updated: BacklogItem = {
        ...existing,
        status: 'open',
        suggestion: rejectedSuggestion,
        updatedAt: now,
        audit: [...existing.audit, rejectAudit],
      };
      await this.writeItem(updated);
      return updated;
    }

    const approvedSuggestionBase = {
      ...existing.suggestion,
      status: 'approved' as const,
      decidedAt: now,
      decidedBy: input.decidedBy,
    };
    const approvedSuggestion = input.note ? { ...approvedSuggestionBase, note: input.note } : approvedSuggestionBase;
    const approveAuditBase = {
      id: generateSortableId(now + 1),
      action: 'approved' as const,
      actor: makeUserActor(input.decidedBy),
      timestamp: now,
    };
    const approveAudit = input.note ? { ...approveAuditBase, detail: input.note } : approveAuditBase;
    const updated: BacklogItem = {
      ...existing,
      status: 'approved',
      approvedAt: now,
      suggestion: approvedSuggestion,
      updatedAt: now,
      audit: [...existing.audit, approveAudit],
    };
    await this.writeItem(updated);
    return updated;
  }

  async updateDispatchProgress(itemId: string, input: UpdateBacklogDispatchProgressInput): Promise<BacklogItem | null> {
    const existing = await this.get(itemId);
    if (!existing) return null;
    if (existing.status !== 'approved') {
      throw new BacklogTransitionError('Invalid backlog transition: dispatch progress requires approved item');
    }

    const now = Date.now();
    const updated: BacklogItem = {
      ...existing,
      ...(input.dispatchAttemptId ? { dispatchAttemptId: input.dispatchAttemptId } : {}),
      ...(input.pendingThreadId ? { pendingThreadId: input.pendingThreadId } : {}),
      ...(input.kickoffMessageId ? { kickoffMessageId: input.kickoffMessageId } : {}),
      updatedAt: now,
    };
    await this.writeItem(updated);
    return updated;
  }

  async markDispatched(itemId: string, input: DispatchBacklogItemInput): Promise<BacklogItem | null> {
    const existing = await this.get(itemId);
    if (!existing) return null;
    if (existing.status === 'dispatched') {
      if (existing.dispatchedThreadId === input.threadId && existing.dispatchedThreadPhase === input.threadPhase) {
        return existing;
      }
      throw new BacklogTransitionError('Invalid backlog transition: item already dispatched to another thread');
    }
    if (existing.status !== 'approved') {
      throw new BacklogTransitionError('Invalid backlog transition: only approved items can be dispatched');
    }
    if ((existing.dispatchAttemptId || existing.pendingThreadId) && !existing.kickoffMessageId) {
      throw new BacklogTransitionError('Invalid backlog transition: kickoff message is required before dispatch');
    }
    if (existing.pendingThreadId && existing.pendingThreadId !== input.threadId) {
      throw new BacklogTransitionError('Invalid backlog transition: pending dispatch thread mismatch');
    }

    const now = Date.now();
    const updated: BacklogItem = {
      ...existing,
      status: 'dispatched',
      dispatchedThreadId: input.threadId,
      dispatchedThreadPhase: input.threadPhase,
      pendingThreadId: existing.pendingThreadId ?? input.threadId,
      dispatchedAt: now,
      updatedAt: now,
      audit: [
        ...existing.audit,
        {
          id: generateSortableId(now + 1),
          action: 'dispatched',
          actor: makeUserActor(input.dispatchedBy),
          timestamp: now,
          detail: `${input.threadId}:${input.threadPhase}`,
        },
      ],
    };
    await this.writeItem(updated);
    return updated;
  }

  async markDone(itemId: string, input: MarkDoneInput): Promise<BacklogItem | null> {
    const item = await this.get(itemId);
    if (!item) return null;
    if (item.status === 'done') return item;

    const now = Date.now();
    const updated: BacklogItem = {
      ...item,
      status: 'done',
      doneAt: now,
      updatedAt: now,
      audit: [
        ...item.audit,
        {
          id: generateSortableId(now + 1),
          action: 'done',
          actor: makeUserActor(input.doneBy),
          timestamp: now,
        },
      ],
    };
    await this.writeItem(updated);
    return updated;
  }

  async atomicDispatch(itemId: string, input: AtomicDispatchInput): Promise<BacklogItem | null> {
    const now = Date.now();
    const auditEntry = JSON.stringify({
      id: generateSortableId(now + 1),
      action: 'dispatched',
      actor: makeUserActor(input.dispatchedBy),
      timestamp: now,
      detail: `${input.threadId}:${input.threadPhase}`,
    });

    const raw = await this.redis.eval(
      ATOMIC_DISPATCH_LUA,
      1,
      BacklogKeys.detail(itemId),
      String(now),
      input.dispatchAttemptId,
      input.pendingThreadId,
      input.kickoffMessageId,
      input.threadId,
      input.threadPhase,
      auditEntry,
    );

    const code = typeof raw === 'number' ? raw : Number(raw);
    if (code === -1) return null;
    if (code === -2) {
      throw new BacklogTransitionError('Invalid backlog transition: only approved items can be atomically dispatched');
    }
    if (code === -3) {
      throw new BacklogTransitionError('Invalid backlog transition: item already dispatched to another thread');
    }
    if (code !== 1 && code !== 2) {
      throw new BacklogTransitionError('Invalid backlog transition: atomic dispatch rejected');
    }

    return this.get(itemId);
  }

  async acquireLease(itemId: string, input: AcquireBacklogLeaseInput): Promise<BacklogItem | null> {
    const now = Date.now();
    const ttlMs = this.normalizeLeaseTtl(input.ttlMs);
    const expiresAt = now + ttlMs;
    const auditEntry = JSON.stringify({
      id: generateSortableId(now + 1),
      action: 'lease_acquired',
      actor: makeUserActor(input.actorId),
      timestamp: now,
      detail: `${input.catId}:${expiresAt}`,
    });

    const result = await this.runLeaseLua(
      LEASE_ACQUIRE_LUA,
      itemId,
      String(now),
      input.catId,
      String(expiresAt),
      auditEntry,
    );

    if (result === -1) return null;
    if (result === -2) {
      throw new BacklogTransitionError('Invalid backlog transition: only dispatched items can acquire lease');
    }
    if (result === -3) {
      throw new BacklogTransitionError('Invalid backlog transition: active lease owned by another cat');
    }
    if (result !== 1) {
      throw new BacklogTransitionError('Invalid backlog transition: lease acquire rejected');
    }

    const updated = await this.get(itemId);
    if (!updated) return null;
    await this.touchLeaseTtl(updated);
    return updated;
  }

  async heartbeatLease(itemId: string, input: HeartbeatBacklogLeaseInput): Promise<BacklogItem | null> {
    const now = Date.now();
    const ttlMs = this.normalizeLeaseTtl(input.ttlMs);
    const expiresAt = now + ttlMs;
    const auditEntry = JSON.stringify({
      id: generateSortableId(now + 1),
      action: 'lease_heartbeat',
      actor: makeUserActor(input.actorId),
      timestamp: now,
      detail: `${input.catId}`,
    });

    const result = await this.runLeaseLua(
      LEASE_HEARTBEAT_LUA,
      itemId,
      String(now),
      input.catId,
      String(expiresAt),
      auditEntry,
    );

    if (result === -1) return null;
    if (result === -2) {
      throw new BacklogTransitionError('Invalid backlog transition: only dispatched items can heartbeat lease');
    }
    if (result === -4) {
      throw new BacklogTransitionError('Invalid backlog transition: no active lease to heartbeat');
    }
    if (result === -5) {
      throw new BacklogTransitionError('Invalid backlog transition: lease owned by another cat');
    }
    if (result === -6) {
      throw new BacklogTransitionError('Invalid backlog transition: lease already expired');
    }
    if (result !== 1) {
      throw new BacklogTransitionError('Invalid backlog transition: lease heartbeat rejected');
    }

    const updated = await this.get(itemId);
    if (!updated) return null;
    await this.touchLeaseTtl(updated);
    return updated;
  }

  async releaseLease(itemId: string, input: ReleaseBacklogLeaseInput): Promise<BacklogItem | null> {
    const now = Date.now();
    const auditEntry = JSON.stringify({
      id: generateSortableId(now + 1),
      action: 'lease_released',
      actor: makeUserActor(input.actorId),
      timestamp: now,
      detail: input.catId ?? '',
    });

    const result = await this.runLeaseLua(
      LEASE_RELEASE_LUA,
      itemId,
      String(now),
      input.catId ?? '',
      input.actorId,
      auditEntry,
    );

    if (result === -1) return null;
    if (result === -2) {
      throw new BacklogTransitionError('Invalid backlog transition: only dispatched items can release lease');
    }
    if (result === -5) {
      throw new BacklogTransitionError('Invalid backlog transition: lease owned by another cat');
    }
    if (result !== 1 && result !== 2) {
      throw new BacklogTransitionError('Invalid backlog transition: lease release rejected');
    }

    const updated = await this.get(itemId);
    if (!updated) return null;
    if (result === 1) {
      await this.touchLeaseTtl(updated);
    }
    return updated;
  }

  async reclaimExpiredLease(itemId: string, input: ReclaimBacklogLeaseInput): Promise<BacklogItem | null> {
    const now = Date.now();
    const auditEntry = JSON.stringify({
      id: generateSortableId(now + 1),
      action: 'lease_reclaimed',
      actor: makeUserActor(input.actorId),
      timestamp: now,
      detail: '',
    });

    const result = await this.runLeaseLua(LEASE_RECLAIM_LUA, itemId, String(now), input.actorId, auditEntry);

    if (result === -1) return null;
    if (result === -2) {
      throw new BacklogTransitionError('Invalid backlog transition: only dispatched items can reclaim lease');
    }
    if (result === -7) {
      throw new BacklogTransitionError('Invalid backlog transition: lease not expired yet');
    }
    if (result !== 1 && result !== 2) {
      throw new BacklogTransitionError('Invalid backlog transition: lease reclaim rejected');
    }

    const updated = await this.get(itemId);
    if (!updated) return null;
    if (result === 1) {
      await this.touchLeaseTtl(updated);
    }
    return updated;
  }

  private async writeItem(item: BacklogItem): Promise<void> {
    const key = BacklogKeys.detail(item.id);
    const pipeline = this.redis.multi();
    pipeline.hset(key, this.serializeItem(item));
    if (this.ttlSeconds !== null) {
      pipeline.expire(key, this.ttlSeconds);
      pipeline.expire(BacklogKeys.userList(item.userId), this.ttlSeconds);
    }
    await pipeline.exec();
  }

  private serializeItem(item: BacklogItem): Record<string, string> {
    const result: Record<string, string> = {
      id: item.id,
      userId: item.userId,
      title: item.title,
      summary: item.summary,
      priority: item.priority,
      status: item.status,
      createdBy: item.createdBy,
      tags: JSON.stringify(item.tags),
      audit: JSON.stringify(item.audit),
      createdAt: String(item.createdAt),
      updatedAt: String(item.updatedAt),
    };
    if (item.suggestion) result.suggestion = JSON.stringify(item.suggestion);
    if (item.lease) result.lease = JSON.stringify(item.lease);
    if (item.approvedAt) result.approvedAt = String(item.approvedAt);
    if (item.dispatchedAt) result.dispatchedAt = String(item.dispatchedAt);
    if (item.dispatchedThreadId) result.dispatchedThreadId = item.dispatchedThreadId;
    if (item.dispatchedThreadPhase) result.dispatchedThreadPhase = item.dispatchedThreadPhase;
    if (item.dispatchAttemptId) result.dispatchAttemptId = item.dispatchAttemptId;
    if (item.pendingThreadId) result.pendingThreadId = item.pendingThreadId;
    if (item.kickoffMessageId) result.kickoffMessageId = item.kickoffMessageId;
    if (item.projectId) result.projectId = item.projectId;
    return result;
  }

  private hydrateItem(data: Record<string, string>): BacklogItem {
    const suggestion = data.suggestion
      ? this.parseJson(data.suggestion, null as BacklogItem['suggestion'] | null)
      : null;
    const lease = data.lease ? this.parseJson(data.lease, null as BacklogLease | null) : null;
    const approvedAt = data.approvedAt ? Number.parseInt(data.approvedAt, 10) : null;
    const dispatchedAt = data.dispatchedAt ? Number.parseInt(data.dispatchedAt, 10) : null;
    return {
      id: data.id ?? '',
      userId: data.userId ?? '',
      title: data.title ?? '',
      summary: data.summary ?? '',
      priority: (data.priority ?? 'p2') as BacklogItem['priority'],
      status: (data.status ?? 'open') as BacklogItem['status'],
      createdBy: (data.createdBy ?? 'user') as BacklogItem['createdBy'],
      tags: this.parseJson(data.tags, []),
      createdAt: Number.parseInt(data.createdAt ?? '0', 10),
      updatedAt: Number.parseInt(data.updatedAt ?? '0', 10),
      audit: this.parseJson(data.audit, []),
      ...(suggestion ? { suggestion } : {}),
      ...(lease ? { lease } : {}),
      ...(data.dispatchedThreadId ? { dispatchedThreadId: data.dispatchedThreadId } : {}),
      ...(data.dispatchedThreadPhase ? { dispatchedThreadPhase: data.dispatchedThreadPhase as ThreadPhase } : {}),
      ...(data.dispatchAttemptId ? { dispatchAttemptId: data.dispatchAttemptId } : {}),
      ...(data.pendingThreadId ? { pendingThreadId: data.pendingThreadId } : {}),
      ...(data.kickoffMessageId ? { kickoffMessageId: data.kickoffMessageId } : {}),
      ...(data.projectId ? { projectId: data.projectId } : {}),
      ...(approvedAt ? { approvedAt } : {}),
      ...(dispatchedAt ? { dispatchedAt } : {}),
    };
  }

  private parseJson<T>(raw: string | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private sameTags(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    const leftSorted = [...left].sort();
    const rightSorted = [...right].sort();
    for (let index = 0; index < leftSorted.length; index += 1) {
      if (leftSorted[index] !== rightSorted[index]) return false;
    }
    return true;
  }

  private sameStringArray(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    const as = [...a].sort();
    const bs = [...b].sort();
    for (let i = 0; i < as.length; i += 1) {
      if (as[i] !== bs[i]) return false;
    }
    return true;
  }

  private sameDependencies(a: BacklogDependencies | undefined, b: BacklogDependencies | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
      this.sameStringArray(a.evolvedFrom, b.evolvedFrom) &&
      this.sameStringArray(a.blockedBy, b.blockedBy) &&
      this.sameStringArray(a.related, b.related)
    );
  }

  private normalizeLeaseTtl(ttlMs: number): number {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 60_000;
    return Math.floor(ttlMs);
  }

  private async runLeaseLua(script: string, itemId: string, ...args: string[]): Promise<number> {
    const raw = await this.redis.eval(script, 1, BacklogKeys.detail(itemId), ...args);
    if (typeof raw === 'number') return raw;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
    throw new BacklogTransitionError('Invalid backlog transition: lease script returned unexpected result');
  }

  private async touchLeaseTtl(item: BacklogItem): Promise<void> {
    if (this.ttlSeconds === null) return;
    const pipeline = this.redis.multi();
    pipeline.expire(BacklogKeys.detail(item.id), this.ttlSeconds);
    pipeline.expire(BacklogKeys.userList(item.userId), this.ttlSeconds);
    await pipeline.exec();
  }

  async tryAcquireDispatchLock(itemId: string, ttlMs = 30_000): Promise<string | false> {
    const key = BacklogKeys.dispatchLock(itemId);
    const token = crypto.randomUUID();
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    const result = await this.redis.set(key, token, 'EX', ttlSec, 'NX');
    return result === 'OK' ? token : false;
  }

  async releaseDispatchLock(itemId: string, token: string): Promise<void> {
    const key = BacklogKeys.dispatchLock(itemId);
    // CAS delete: only remove if the token still matches (prevents deleting another request's lock)
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    );
  }
}
