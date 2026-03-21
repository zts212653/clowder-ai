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
import type { CatId } from '@cat-cafe/shared';
import { isValidTransition } from './invocation-state-machine.js';

/** InvocationRecord lifecycle statuses */
export type InvocationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

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
  /** Idempotency key (client-provided or server-generated, always present) */
  idempotencyKey: string;
  /** Error message when status is 'failed' */
  error?: string;
  /** F8: Per-cat token usage collected on invocation completion */
  usageByCat?: Record<string, import('../../types.js').TokenUsage>;
  /** F128: Epoch ms when usageByCat was first recorded. Stable for daily bucketing
   *  (unlike updatedAt which any subsequent update can shift). */
  usageRecordedAt?: number;
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
}

/** Result of atomic create-or-deduplicate */
export interface CreateResult {
  outcome: 'created' | 'duplicate';
  invocationId: string;
}

/** Fields that can be updated on an InvocationRecord */
export interface UpdateInvocationInput {
  status?: InvocationStatus;
  userMessageId?: string | null;
  error?: string;
  /** CAS guard: update only if current status matches. Returns null on mismatch. */
  expectedStatus?: InvocationStatus;
  /** F8: Per-cat token usage (key = catId) */
  usageByCat?: Record<string, import('../../types.js').TokenUsage>;
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

    if (input.status !== undefined) record.status = input.status;
    if (input.userMessageId !== undefined) record.userMessageId = input.userMessageId;
    if (input.error !== undefined) record.error = input.error;
    if (input.usageByCat !== undefined) {
      record.usageByCat = input.usageByCat;
      // F128: stamp usageRecordedAt only on first write (stable for daily bucketing)
      if (record.usageRecordedAt == null) record.usageRecordedAt = Date.now();
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

  /** Current record count (for testing) */
  get size(): number {
    return this.records.size;
  }
}
