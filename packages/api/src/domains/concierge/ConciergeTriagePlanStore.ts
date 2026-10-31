/**
 * ConciergeTriagePlanStore (F229 Phase B)
 *
 * TriagePlan 持久化。TTL=0（铁律 5 LL-048）。
 * 三件模式：port interface + Redis 实现 + Memory 实现（测试用）。
 *
 * 状态机：proposed → confirmed → dispatched → completed | failed
 *         proposed → cancelled
 *         failed → confirmed (retry)
 *
 * INV T1: 先落 proposed 再出确认卡
 * INV T2: 确认后才 dispatch
 * INV T3: failed 可手动重试（→ confirmed）
 */

import type { TriagePlan, TriagePlanResult, TriagePlanStatus } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { ConciergeKeys } from './concierge-keys.js';

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface IConciergeTriagePlanStore {
  /** Create a new triage plan (status = 'proposed') */
  create(plan: TriagePlan): Promise<void>;
  /** Get plan by ID */
  get(planId: string): Promise<TriagePlan | null>;
  /** Update plan status (state transition) — sets timestamps for dispatched/completed */
  updateStatus(planId: string, status: TriagePlanStatus): Promise<void>;
  /**
   * Atomic compare-and-swap status transition.
   * Returns true if the plan existed AND its current status matched `expectedStatus`,
   * in which case it is atomically updated to `newStatus`.
   * Returns false otherwise (plan missing or status mismatch — another caller won the race).
   *
   * Use this instead of get+check+updateStatus for confirm/cancel to prevent
   * double-dispatch on concurrent requests (cloud P1 fix).
   */
  claimTransition(planId: string, expectedStatus: TriagePlanStatus, newStatus: TriagePlanStatus): Promise<boolean>;
  /** Set dispatch result on plan */
  setResult(planId: string, result: TriagePlanResult): Promise<void>;
  /** Persist user-selected relay target cats before dispatching an ambiguous plan */
  setTargetCats(planId: string, targetCats: string[]): Promise<void>;
  /** Link the plan to the assistant message that rendered its confirmation card */
  setConfirmationMessageId(planId: string, messageId: string): Promise<void>;
  /** List plans for a user (most recent first) */
  listByUser(userId: string): Promise<TriagePlan[]>;
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

/**
 * Lua CAS script for atomic status transition (cloud P1 fix).
 * Returns 1 on success (status matched & updated), 0 on failure (missing or mismatch).
 * Handles timestamp bookkeeping (dispatchedAt, completedAt) inside the atomic operation.
 */
const CLAIM_TRANSITION_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local plan = cjson.decode(raw)
if plan.status ~= ARGV[1] then return 0 end
plan.status = ARGV[2]
plan.updatedAt = tonumber(ARGV[3])
if ARGV[2] == 'dispatched' then plan.dispatchedAt = plan.updatedAt end
if ARGV[2] == 'completed' then plan.completedAt = plan.updatedAt end
redis.call('SET', KEYS[1], cjson.encode(plan))
return 1
`;

export class RedisConciergeTriagePlanStore implements IConciergeTriagePlanStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async create(plan: TriagePlan): Promise<void> {
    // TTL=0 = persistent (铁律 5 LL-048)
    await this.redis.set(ConciergeKeys.triagePlan(plan.id), JSON.stringify(plan));
    await this.redis.sadd(ConciergeKeys.triagePlanIndex(plan.userId), plan.id);
  }

  async get(planId: string): Promise<TriagePlan | null> {
    const raw = await this.redis.get(ConciergeKeys.triagePlan(planId));
    return raw ? (JSON.parse(raw) as TriagePlan) : null;
  }

  async updateStatus(planId: string, status: TriagePlanStatus): Promise<void> {
    const raw = await this.redis.get(ConciergeKeys.triagePlan(planId));
    if (!raw) return;
    const plan = JSON.parse(raw) as TriagePlan;
    plan.status = status;
    plan.updatedAt = Date.now();
    if (status === 'dispatched') plan.dispatchedAt = plan.updatedAt;
    if (status === 'completed') plan.completedAt = plan.updatedAt;
    await this.redis.set(ConciergeKeys.triagePlan(planId), JSON.stringify(plan));
  }

  /**
   * Atomic compare-and-swap via Lua script.
   * Only updates status if current status matches expectedStatus.
   * Prevents double-dispatch race on concurrent confirm clicks.
   */
  async claimTransition(
    planId: string,
    expectedStatus: TriagePlanStatus,
    newStatus: TriagePlanStatus,
  ): Promise<boolean> {
    const key = ConciergeKeys.triagePlan(planId);
    // Lua CAS: atomically check status → update only if match
    // KEYS[1] = plan key (ioredis auto-prefixes)
    // ARGV[1] = expectedStatus, ARGV[2] = newStatus, ARGV[3] = now timestamp
    const result = await this.redis.eval(
      CLAIM_TRANSITION_LUA,
      1,
      key,
      expectedStatus,
      newStatus,
      Date.now().toString(),
    );
    return result === 1;
  }

  async setResult(planId: string, result: TriagePlanResult): Promise<void> {
    const raw = await this.redis.get(ConciergeKeys.triagePlan(planId));
    if (!raw) return;
    const plan = JSON.parse(raw) as TriagePlan;
    plan.result = result;
    plan.updatedAt = Date.now();
    await this.redis.set(ConciergeKeys.triagePlan(planId), JSON.stringify(plan));
  }

  async setTargetCats(planId: string, targetCats: string[]): Promise<void> {
    const raw = await this.redis.get(ConciergeKeys.triagePlan(planId));
    if (!raw) return;
    const plan = JSON.parse(raw) as TriagePlan;
    plan.target = { ...plan.target, targetCats };
    plan.updatedAt = Date.now();
    await this.redis.set(ConciergeKeys.triagePlan(planId), JSON.stringify(plan));
  }

  async setConfirmationMessageId(planId: string, messageId: string): Promise<void> {
    const raw = await this.redis.get(ConciergeKeys.triagePlan(planId));
    if (!raw) return;
    const plan = JSON.parse(raw) as TriagePlan;
    plan.confirmationMessageId = messageId;
    plan.updatedAt = Date.now();
    await this.redis.set(ConciergeKeys.triagePlan(planId), JSON.stringify(plan));
  }

  async listByUser(userId: string): Promise<TriagePlan[]> {
    const ids = await this.redis.smembers(ConciergeKeys.triagePlanIndex(userId));
    if (ids.length === 0) return [];
    const results: TriagePlan[] = [];
    for (const id of ids) {
      const raw = await this.redis.get(ConciergeKeys.triagePlan(id));
      if (raw) results.push(JSON.parse(raw) as TriagePlan);
    }
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation（仅用于单元测试 / stub）
// ---------------------------------------------------------------------------

export class MemoryConciergeTriagePlanStore implements IConciergeTriagePlanStore {
  private readonly store = new Map<string, TriagePlan>();

  async create(plan: TriagePlan): Promise<void> {
    this.store.set(plan.id, { ...plan, target: { ...plan.target } });
  }

  async get(planId: string): Promise<TriagePlan | null> {
    const entry = this.store.get(planId);
    return entry ? { ...entry, target: { ...entry.target } } : null;
  }

  async updateStatus(planId: string, status: TriagePlanStatus): Promise<void> {
    const entry = this.store.get(planId);
    if (!entry) return;
    entry.status = status;
    entry.updatedAt = Date.now();
    if (status === 'dispatched') entry.dispatchedAt = entry.updatedAt;
    if (status === 'completed') entry.completedAt = entry.updatedAt;
    this.store.set(planId, { ...entry, target: { ...entry.target } });
  }

  async claimTransition(
    planId: string,
    expectedStatus: TriagePlanStatus,
    newStatus: TriagePlanStatus,
  ): Promise<boolean> {
    const entry = this.store.get(planId);
    if (!entry || entry.status !== expectedStatus) return false;
    entry.status = newStatus;
    entry.updatedAt = Date.now();
    if (newStatus === 'dispatched') entry.dispatchedAt = entry.updatedAt;
    if (newStatus === 'completed') entry.completedAt = entry.updatedAt;
    this.store.set(planId, { ...entry, target: { ...entry.target } });
    return true;
  }

  async setResult(planId: string, result: TriagePlanResult): Promise<void> {
    const entry = this.store.get(planId);
    if (!entry) return;
    entry.result = { ...result };
    entry.updatedAt = Date.now();
    this.store.set(planId, { ...entry, target: { ...entry.target } });
  }

  async setTargetCats(planId: string, targetCats: string[]): Promise<void> {
    const entry = this.store.get(planId);
    if (!entry) return;
    entry.target = { ...entry.target, targetCats };
    entry.updatedAt = Date.now();
    this.store.set(planId, { ...entry, target: { ...entry.target } });
  }

  async setConfirmationMessageId(planId: string, messageId: string): Promise<void> {
    const entry = this.store.get(planId);
    if (!entry) return;
    entry.confirmationMessageId = messageId;
    entry.updatedAt = Date.now();
    this.store.set(planId, { ...entry, target: { ...entry.target } });
  }

  async listByUser(userId: string): Promise<TriagePlan[]> {
    const results: TriagePlan[] = [];
    for (const entry of this.store.values()) {
      if (entry.userId === userId) results.push({ ...entry, target: { ...entry.target } });
    }
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }
}
