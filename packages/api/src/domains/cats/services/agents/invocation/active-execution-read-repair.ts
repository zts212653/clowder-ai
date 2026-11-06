import type { TurnExecutionRecord } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { LiveCliExecutionOwner } from '../../../../../utils/cli-process-ownership.js';
import type { InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';

const INITIAL_RETRY_MS = 30_000;
const MAX_RETRY_MS = 300_000;
const MAX_ENTRIES = 1_024;

interface RepairInput {
  record: InvocationRecord;
  targetCats: readonly string[];
  owners: readonly LiveCliExecutionOwner[];
  readChildren(): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]>;
  repair(): Promise<boolean>;
  log: FastifyBaseLogger;
}

interface RetryState {
  threadId: string;
  userId: string;
  revision?: string;
  failure?: string;
  failureCount: number;
  retryAt: number;
  skippedPolls: number;
  lastObservedAt: number;
}

function repairKey(record: Pick<InvocationRecord, 'threadId' | 'userId' | 'id'>): string {
  return JSON.stringify([record.threadId, record.userId, record.id]);
}

function revision(input: RepairInput, children: readonly TurnExecutionRecord[]): string {
  const { record } = input;
  return JSON.stringify([
    record.updatedAt,
    record.status,
    [...record.targetCats].sort(),
    [...input.targetCats].sort(),
    children
      .map((child) =>
        JSON.stringify([
          child.invocationId,
          child.catId,
          child.status,
          child.providerLifecycleTracked,
          child.providerStartedAt,
          child.providerTeardownAt,
          child.endedAt,
          child.outputFence,
        ]),
      )
      .sort(),
    input.owners
      .filter(
        (owner) =>
          owner.threadId === record.threadId &&
          owner.userId === record.userId &&
          record.targetCats.some((catId) => catId === owner.catId),
      )
      .map((owner) => JSON.stringify([owner.executionId, owner.invocationId, owner.catId, owner.startedAt]))
      .sort(),
  ]);
}

function errorIdentity(value: unknown): readonly unknown[] {
  if (!(value instanceof Error)) return [typeof value, String(value)];
  return [value.name, 'code' in value ? String(value.code) : undefined, value.message, value.stack?.split('\n')[1]];
}

function failureIdentity(err: unknown): string {
  return JSON.stringify([errorIdentity(err), err instanceof Error ? errorIdentity(err.cause) : undefined]);
}

/** Process-local retry advice only: this never supplies provider stop proof or changes lifecycle truth. */
export class ActiveExecutionReadRepair {
  private readonly states = new Map<string, RetryState>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  forget(record: Pick<InvocationRecord, 'threadId' | 'userId' | 'id'>): void {
    this.states.delete(repairKey(record));
  }

  forgetThread(threadId: string, userId: string): void {
    for (const [key, state] of this.states) {
      if (state.threadId === threadId && state.userId === userId) this.states.delete(key);
    }
  }

  run(input: RepairInput): Promise<boolean> {
    const key = repairKey(input.record);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const now = Date.now();
    let state = this.states.get(key);
    if (!state) {
      if (this.states.size >= MAX_ENTRIES) this.evictForAdmission(now);
      state = {
        threadId: input.record.threadId,
        userId: input.record.userId,
        failureCount: 0,
        retryAt: 0,
        skippedPolls: 0,
        lastObservedAt: now,
      };
      this.states.set(key, state);
    }
    state.lastObservedAt = now;
    const attempt = Promise.resolve()
      .then(() => this.attempt(key, state, input))
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, attempt);
    return attempt;
  }

  private evictForAdmission(now: number): void {
    // Stable polling scans must not displace every existing cooldown. Prefer unseen advice,
    // otherwise rotate the newest admission, preserving the rest of the observed cohort.
    // Overflow may reprobe evicted entries; it cannot turn a one-entry overflow into a full storm.
    let victim: string | undefined;
    for (const [key, state] of this.states) {
      victim = key;
      if (now - state.lastObservedAt >= MAX_RETRY_MS) break;
    }
    if (victim !== undefined) this.states.delete(victim);
  }

  private async attempt(key: string, state: RetryState, input: RepairInput): Promise<boolean> {
    try {
      // Read child proof even during cooldown: it can change without updating the parent record.
      const observed = revision(input, await input.readChildren());
      if (state.revision !== observed) {
        state.revision = observed;
        state.failureCount = 0;
        state.retryAt = 0;
        state.failure = undefined;
      }
      if (Date.now() < state.retryAt) {
        state.skippedPolls += 1;
        return false;
      }
      const repaired = await input.repair();
      if (this.states.get(key) === state) this.states.delete(key);
      return repaired;
    } catch (err) {
      const failure = failureIdentity(err);
      const newFailure = state.failure !== failure;
      if (!newFailure && Date.now() < state.retryAt) {
        state.skippedPolls += 1;
        return false;
      }
      state.failureCount += 1;
      const retryAfterMs = Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * 2 ** Math.min(state.failureCount - 1, 4));
      state.retryAt = Date.now() + retryAfterMs;
      state.failure = failure;
      const context = {
        threadId: input.record.threadId,
        userId: input.record.userId,
        executionId: input.record.id,
        targetCats: input.targetCats,
        retryAfterMs,
        failureCount: state.failureCount,
        skippedPolls: state.skippedPolls,
      };
      if (newFailure) input.log.error({ err, ...context }, 'active execution read-repair failed closed');
      else input.log.info({ ...context, failure }, 'active execution read-repair retry deferred');
      state.skippedPolls = 0;
      return false;
    }
  }
}
