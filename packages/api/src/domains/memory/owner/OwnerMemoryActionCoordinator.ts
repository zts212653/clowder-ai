import { createHash } from 'node:crypto';
import type { MemoryOwnerActionError, MemoryOwnerActionOutcome, MemoryOwnerActionReceipt } from '@cat-cafe/shared';
import type { SessionMutex } from '../../cats/services/agents/invocation/SessionMutex.js';
import {
  type OwnerMemoryActionReceiptKey,
  type OwnerMemoryActionReceiptRecord,
  type OwnerMemoryActionReceiptStore,
  type OwnerMemoryLane,
} from './OwnerMemoryActionReceiptStore.js';

export {
  InMemoryOwnerMemoryActionReceiptStore,
  RedisOwnerMemoryActionReceiptStore,
} from './OwnerMemoryActionReceiptStore.js';

export interface OwnerMemoryActionExecutionInput {
  ownerUserId: string;
  lane: OwnerMemoryLane;
  memoryId: string;
  requestId: string;
  command: unknown;
}

export type OwnerMemoryActionExecutionResult = MemoryOwnerActionReceipt | { error: MemoryOwnerActionError };

export interface OwnerMemoryActionExecutionHandlers {
  run: () => Promise<
    | { status: 'applied'; receipt: Omit<MemoryOwnerActionReceipt, 'outcome'> & { outcome?: MemoryOwnerActionOutcome } }
    | { status: 'rejected'; error: MemoryOwnerActionError }
  >;
  recover?: (
    pending: OwnerMemoryActionReceiptRecord,
  ) => Promise<(Omit<MemoryOwnerActionReceipt, 'outcome'> & { outcome?: MemoryOwnerActionOutcome }) | null>;
}

export class OwnerMemoryActionCoordinator {
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      store: OwnerMemoryActionReceiptStore;
      lock: SessionMutex;
      now?: () => number;
    },
  ) {
    this.now = deps.now ?? Date.now;
  }

  async execute(
    input: OwnerMemoryActionExecutionInput,
    handlers: OwnerMemoryActionExecutionHandlers,
  ): Promise<OwnerMemoryActionExecutionResult> {
    const key: OwnerMemoryActionReceiptKey = input;
    const requestDigest = requestDigestOf(input);
    const release = await this.deps.lock.acquire(lockKey(input));
    try {
      let record = await this.deps.store.read(key);
      const terminal = terminalRecordResult(record, requestDigest);
      if (terminal) return terminal;

      if (record?.status === 'pending' && handlers.recover) {
        const recovered = await this.recover(key, requestDigest, record, handlers.recover);
        if (recovered) return recovered;
      }

      if (!record) {
        record = await this.begin(input, requestDigest);
        const raced = terminalRecordResult(record, requestDigest);
        if (raced) return raced;
      }

      return this.runAndComplete(key, requestDigest, handlers.run);
    } finally {
      release();
    }
  }

  private begin(input: OwnerMemoryActionExecutionInput, requestDigest: string) {
    return this.deps.store.begin({
      version: 1,
      ownerUserId: input.ownerUserId,
      lane: input.lane,
      memoryId: input.memoryId,
      requestId: input.requestId,
      requestDigest,
      status: 'pending',
      startedAt: this.now(),
    });
  }

  private async recover(
    key: OwnerMemoryActionReceiptKey,
    requestDigest: string,
    record: OwnerMemoryActionReceiptRecord,
    recover: NonNullable<OwnerMemoryActionExecutionHandlers['recover']>,
  ): Promise<MemoryOwnerActionReceipt | null> {
    const recovered = await recover(record);
    if (!recovered) return null;
    const applied = appliedReceipt(recovered);
    if (!(await this.deps.store.complete(key, requestDigest, applied, this.now()))) {
      throw new Error('Owner memory action recovery receipt lost its pending fence');
    }
    return replay(applied);
  }

  private async runAndComplete(
    key: OwnerMemoryActionReceiptKey,
    requestDigest: string,
    run: OwnerMemoryActionExecutionHandlers['run'],
  ): Promise<OwnerMemoryActionExecutionResult> {
    const result = await run();
    if (result.status === 'rejected') {
      await this.deps.store.clearPending(key, requestDigest);
      return { error: result.error };
    }
    const applied = appliedReceipt(result.receipt);
    if (!(await this.deps.store.complete(key, requestDigest, applied, this.now()))) {
      throw new Error('Owner memory action receipt lost its pending fence');
    }
    return applied;
  }
}

function terminalRecordResult(
  record: OwnerMemoryActionReceiptRecord | null,
  requestDigest: string,
): OwnerMemoryActionExecutionResult | null {
  if (record && record.requestDigest !== requestDigest) return { error: 'idempotency_conflict' };
  if (record?.status === 'applied' && record.result) return replay(record.result);
  return null;
}

function appliedReceipt(
  receipt: Omit<MemoryOwnerActionReceipt, 'outcome'> & { outcome?: MemoryOwnerActionOutcome },
): MemoryOwnerActionReceipt {
  return { ...receipt, outcome: 'applied' };
}

function replay(receipt: MemoryOwnerActionReceipt): MemoryOwnerActionReceipt {
  return { ...structuredClone(receipt), outcome: 'replayed' };
}

function lockKey(input: Pick<OwnerMemoryActionExecutionInput, 'ownerUserId' | 'lane' | 'memoryId'>): string {
  return `owner-memory:${input.ownerUserId}:${input.lane}:${input.memoryId}`;
}

function requestDigestOf(input: OwnerMemoryActionExecutionInput): string {
  return `sha256:${createHash('sha256').update(canonicalJson(input)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}
