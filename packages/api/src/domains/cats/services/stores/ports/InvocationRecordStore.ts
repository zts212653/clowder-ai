/**
 * InvocationRecord Store
 * 调用状态机：将"消息写入"与"猫调用执行"解耦。
 *
 * ADR-008 D1: InvocationRecord 轻量状态机
 * ADR-008 D2: IdempotencyKey 消息去重
 *
 * 有界 Map 实现，超过 MAX_RECORDS 时丢弃最旧记录。
 */

import { randomUUID } from 'node:crypto';
import type { CatId, FreshnessClosureStatus } from '@cat-cafe/shared';
import { isValidTransition } from './invocation-state-machine.js';

/** InvocationRecord lifecycle statuses */
export type InvocationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/**
 * F167 S.1-b: immutable carrier projection for an action-successor lease.
 * The action-successor store remains canonical; InvocationRecord only carries
 * the exact ref from queue admission to an invocation-authenticated callback.
 */
export interface InvocationActionLeaseRef {
  readonly leaseId: string;
  readonly generation: number;
}

/**
 * Every newly-created invocation classifies whether it carries action custody.
 * Keeping the discriminator and exact ref in one value prevents a half-state
 * where a record says a lease is required but has no generation to complete.
 */
export type InvocationActionLeaseCarrier =
  | { readonly kind: 'none' }
  | ({ readonly kind: 'action_successor' } & InvocationActionLeaseRef);

export function requireInvocationActionLeaseCarrier(value: unknown): InvocationActionLeaseCarrier {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new Error('InvocationRecord create requires an explicit action lease carrier classification');
  }
  if (value.kind === 'none') return Object.freeze({ kind: 'none' });
  if (
    value.kind !== 'action_successor' ||
    !('leaseId' in value) ||
    typeof value.leaseId !== 'string' ||
    value.leaseId.length === 0 ||
    !('generation' in value) ||
    !Number.isInteger(value.generation) ||
    (value.generation as number) <= 0
  ) {
    throw new Error('InvocationRecord create received an invalid action successor carrier');
  }
  return Object.freeze({
    kind: 'action_successor',
    leaseId: value.leaseId,
    generation: value.generation as number,
  });
}

/**
 * A single invocation record tracking the lifecycle of a cat invocation.
 */
export interface InvocationRecord {
  id: string;
  threadId: string;
  userId: string;
  /** Associated user message ID (null = message not yet written, needs compensation) */
  userMessageId: string | null;
  targetCats: CatId[];
  intent: 'execute' | 'ideate';
  status: InvocationStatus;
  /** F254: cats with an exact successful terminal event for this invocation.
   *  Persisted atomically with the running -> succeeded transition so restart
   *  recovery never infers per-target success from the aggregate parent status. */
  successfulCatIds?: readonly CatId[];
  /** Idempotency key (client-provided or server-generated, always present) */
  idempotencyKey: string;
  /** Error message when status is 'failed' */
  error?: string;
  /**
   * Epoch ms when the executor produced its first durable routing event.
   *
   * `status: running` is only an exclusive claim. Connector callers may not
   * acknowledge a wake until this receipt exists, otherwise a process exit
   * between the claim and router startup can silently consume pending work.
   */
  executionStartedAt?: number;
  /** F8: Per-cat token usage collected on invocation completion */
  usageByCat?: Record<string, import('../../types.js').TokenUsage>;
  /** F128: Epoch ms when usageByCat was first recorded. Stable for daily bucketing
   *  (unlike updatedAt which any subsequent update can shift). */
  usageRecordedAt?: number;
  /** F254 Phase E: typed custody proof for a catch-closure successor. */
  freshnessClosureId?: string;
  freshnessInputFrontierMessageId?: string;
  freshnessClosureStatus?: FreshnessClosureStatus;
  /** F167 S.1-b: server-written carrier classification recovered by holder callbacks. */
  actionLeaseCarrier: InvocationActionLeaseCarrier;
  createdAt: number;
  updatedAt: number;
}

/** Input for creating an InvocationRecord (id + timestamps auto-generated) */
export interface CreateInvocationInput {
  threadId: string;
  userId: string;
  targetCats: CatId[];
  intent: 'execute' | 'ideate';
  idempotencyKey: string;
  /** F167 S.1-b: exact carrier classification; every producer must choose one union arm. */
  actionLeaseCarrier: InvocationActionLeaseCarrier;
}

/** Result of atomic create-or-deduplicate */
export interface CreateResult {
  outcome: 'created' | 'duplicate';
  invocationId: string;
}

/** Fields that can be updated on an InvocationRecord */
export interface UpdateInvocationInput {
  status?: InvocationStatus;
  /** Exact successful targets. Valid only on the transition to `succeeded`. */
  successfulCatIds?: readonly CatId[];
  userMessageId?: string | null;
  error?: string;
  /** Durable proof that the claimed executor reached router execution. */
  executionStartedAt?: number;
  /** CAS guard: update only if current status matches. Returns null on mismatch. */
  expectedStatus?: InvocationStatus;
  /** CAS guard: update only if usageByCat is missing or an empty object. Returns null on mismatch. */
  expectedUsageByCatAbsent?: boolean;
  /** F8: Per-cat token usage (key = catId) */
  usageByCat?: Record<string, import('../../types.js').TokenUsage>;
  /** Issue #845 backfill: override the usageRecordedAt timestamp (epoch ms).
   *  Live writers should NEVER set this — let the store stamp Date.now() so day bucketing
   *  stays honest. Only the backfill script sets it, anchoring to existing
   *  usageRecordedAt, a duration-derived message completion time, or legacy
   *  updatedAt fallback. Never `invocation.createdAt` (would mis-bucket
   *  cross-midnight runs onto the start day instead of the finish day). */
  usageRecordedAt?: number;
  freshnessClosureId?: string;
  freshnessInputFrontierMessageId?: string;
  freshnessClosureStatus?: FreshnessClosureStatus;
}

/**
 * Common interface for invocation record stores (in-memory and Redis).
 * Methods that may hit Redis are async; in-memory returns immediately.
 */
export interface IInvocationRecordStore {
  /** Atomic create-or-deduplicate: returns existing record if idempotency key matches */
  create(input: CreateInvocationInput): CreateResult | Promise<CreateResult>;
  /** Get a record by its ID */
  get(id: string): InvocationRecord | null | Promise<InvocationRecord | null>;
  /** Update fields on a record */
  update(id: string, input: UpdateInvocationInput): InvocationRecord | null | Promise<InvocationRecord | null>;
  /** Look up an invocation by its idempotency key */
  getByIdempotencyKey(
    threadId: string,
    userId: string,
    key: string,
  ): InvocationRecord | null | Promise<InvocationRecord | null>;

  /** F128: Scan all invocation records (optional — only Redis impl provides this) */
  scanAll?(): Promise<InvocationRecord[]>;

  /**
   * F194 Phase B: Enumerate currently running invocation records scoped to (threadId, userId).
   *
   * Required by `getThreadLiveInvocations` so canonical liveness read can detect zombie records
   * even after their drafts have been TTL-reaped — the helper enumerates from records ∪ drafts.
   * In-memory: filter the records map. Redis: SMEMBERS index Set + pipeline HGETALL on hit ids
   * + defensive filter (Set is maintained inside ATOMIC_UPDATE_LUA on status transitions —
   * crash-safe, no post-Lua best-effort window).
   */
  listRunningByThread(threadId: string, userId: string): InvocationRecord[] | Promise<InvocationRecord[]>;
}

/** Max records in memory store */
const MAX_RECORDS = 500;

/** Idempotency key TTL (5 minutes) */
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

/**
 * In-memory bounded InvocationRecord store.
 * Node.js single-threaded → synchronous Map operations are atomically equivalent.
 */
export class InvocationRecordStore implements IInvocationRecordStore {
  private records = new Map<string, InvocationRecord>();
  /** Map: compositeKey → { invocationId, expiresAt } */
  private idempotencyIndex = new Map<string, { invocationId: string; expiresAt: number }>();
  private readonly maxRecords: number;

  constructor(options?: { maxRecords?: number }) {
    this.maxRecords = options?.maxRecords ?? MAX_RECORDS;
  }

  private compositeKey(threadId: string, userId: string, key: string): string {
    return `${threadId}:${userId}:${key}`;
  }

  create(input: CreateInvocationInput): CreateResult {
    const now = Date.now();
    const composite = this.compositeKey(input.threadId, input.userId, input.idempotencyKey);

    // Check idempotency (with TTL expiry)
    const existing = this.idempotencyIndex.get(composite);
    if (existing && existing.expiresAt > now) {
      return { outcome: 'duplicate', invocationId: existing.invocationId };
    }

    const id = randomUUID();
    const record: InvocationRecord = {
      id,
      threadId: input.threadId,
      userId: input.userId,
      userMessageId: null,
      targetCats: [...input.targetCats],
      intent: input.intent,
      status: 'queued',
      idempotencyKey: input.idempotencyKey,
      actionLeaseCarrier: requireInvocationActionLeaseCarrier(input.actionLeaseCarrier),
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(id, record);
    this.idempotencyIndex.set(composite, { invocationId: id, expiresAt: now + IDEMPOTENCY_TTL_MS });

    // Trim oldest if over capacity
    if (this.records.size > this.maxRecords) {
      const firstKey = this.records.keys().next().value as string;
      this.records.delete(firstKey);
    }

    return { outcome: 'created', invocationId: id };
  }

  get(id: string): InvocationRecord | null {
    return this.records.get(id) ?? null;
  }

  update(id: string, input: UpdateInvocationInput): InvocationRecord | null {
    const record = this.records.get(id);
    if (!record) return null;

    // State machine guard: reject illegal transitions (F25)
    if (input.status !== undefined && !isValidTransition(record.status, input.status)) {
      return null;
    }

    // CAS guard: reject if current status doesn't match expected
    if (input.expectedStatus !== undefined && record.status !== input.expectedStatus) {
      return null;
    }
    if (
      input.expectedUsageByCatAbsent === true &&
      record.usageByCat !== undefined &&
      Object.keys(record.usageByCat).length > 0
    ) {
      return null;
    }
    const successfulCatIds = normalizeSuccessfulCatIds(record.targetCats, input);
    const startsNewExecutionAttempt = input.status === 'running' && record.status !== 'running';

    if (input.status !== undefined) record.status = input.status;
    if (successfulCatIds !== undefined) record.successfulCatIds = Object.freeze(successfulCatIds);
    if (input.userMessageId !== undefined) record.userMessageId = input.userMessageId;
    if (input.error !== undefined) record.error = input.error;
    if (startsNewExecutionAttempt) {
      // The receipt proves one specific execution attempt. A queued/failed
      // record reclaimed for a new attempt must not inherit the old proof.
      delete record.executionStartedAt;
    } else if (input.executionStartedAt !== undefined) {
      record.executionStartedAt = input.executionStartedAt;
    }
    if (input.freshnessClosureId !== undefined) record.freshnessClosureId = input.freshnessClosureId;
    if (input.freshnessInputFrontierMessageId !== undefined) {
      record.freshnessInputFrontierMessageId = input.freshnessInputFrontierMessageId;
    }
    if (input.freshnessClosureStatus !== undefined) record.freshnessClosureStatus = input.freshnessClosureStatus;
    if (input.usageByCat !== undefined) {
      record.usageByCat = input.usageByCat;
      // F128: stamp usageRecordedAt only on first write (stable for daily bucketing).
      // Issue #845 backfill: explicit input.usageRecordedAt overrides — anchored to the
      // stable historical completion signal chosen by the planner.
      if (input.usageRecordedAt != null) {
        record.usageRecordedAt = input.usageRecordedAt;
      } else if (record.usageRecordedAt == null) {
        record.usageRecordedAt = Date.now();
      }
    }
    record.updatedAt = Date.now();

    return record;
  }

  getByIdempotencyKey(threadId: string, userId: string, key: string): InvocationRecord | null {
    const composite = this.compositeKey(threadId, userId, key);
    const entry = this.idempotencyIndex.get(composite);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return this.records.get(entry.invocationId) ?? null;
  }

  listRunningByThread(threadId: string, userId: string): InvocationRecord[] {
    const out: InvocationRecord[] = [];
    for (const r of this.records.values()) {
      if (r.status === 'running' && r.threadId === threadId && r.userId === userId) out.push(r);
    }
    return out;
  }

  /** Current record count (for testing) */
  get size(): number {
    return this.records.size;
  }
}

export class InvalidInvocationSuccessWitnessError extends Error {
  readonly code = 'INVALID_INVOCATION_SUCCESS_WITNESS';
}

export function normalizeSuccessfulCatIds(
  targetCats: readonly CatId[],
  input: UpdateInvocationInput,
): CatId[] | undefined {
  if (input.successfulCatIds === undefined) return undefined;
  if (input.status !== 'succeeded') {
    throw new InvalidInvocationSuccessWitnessError('successfulCatIds may only be supplied with status succeeded');
  }
  if (targetCats.length > 0 && input.successfulCatIds.length === 0) {
    throw new InvalidInvocationSuccessWitnessError('successfulCatIds must be non-empty for a targeted invocation');
  }
  const targetSet = new Set(targetCats);
  if (input.successfulCatIds.some((catId) => !targetSet.has(catId))) {
    throw new InvalidInvocationSuccessWitnessError('successfulCatIds must be a subset of immutable targetCats');
  }
  const successfulSet = new Set(input.successfulCatIds);
  return targetCats.filter((catId) => successfulSet.has(catId));
}
