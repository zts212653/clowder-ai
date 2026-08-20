import type { InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';
import type { ExecutionOwnerMatch, StaleInvocationSlotInfo } from './InvocationTracker.js';

export interface StaleProcessingOwnerLease {
  threadId: string;
  catId: string;
  userId: string;
  executionId: string;
  startedAt: number;
  ageMs: number;
}

export interface InvocationOwnerTrackerLike {
  listStaleSlots(now?: number): StaleInvocationSlotInfo[];
  classifyExecutionId(threadId: string, catId: string, executionId: string): ExecutionOwnerMatch;
}

export interface OwnerCandidate {
  executionId: string;
  threadId: string;
  userId: string;
  startedAt: number;
  targetCats: Set<string>;
  trackerSlots: Array<{ threadId: string; catId: string }>;
  scopeCollision: boolean;
}

export async function collectInvocationOwnerCandidates(options: {
  invocationTracker: InvocationOwnerTrackerLike;
  listStaleProcessingLeases?: (now?: number) => StaleProcessingOwnerLease[];
  listRunningRecords?: () => InvocationRecord[] | Promise<InvocationRecord[]>;
  ownerLeaseTtlMs: number;
  now: number;
  onUnboundTrackerLease: (lease: StaleInvocationSlotInfo) => void;
  onRecordScanError: (err: unknown) => void;
}): Promise<OwnerCandidate[]> {
  const byExecution = new Map<string, OwnerCandidate>();
  collectTrackerCandidates(byExecution, options);
  collectProcessingCandidates(byExecution, options);
  await collectRecordCandidates(byExecution, options);
  return [...byExecution.values()];
}

function collectTrackerCandidates(
  byExecution: Map<string, OwnerCandidate>,
  options: Parameters<typeof collectInvocationOwnerCandidates>[0],
): void {
  for (const lease of options.invocationTracker.listStaleSlots(options.now)) {
    if (!lease.executionId) {
      options.onUnboundTrackerLease(lease);
      continue;
    }
    const candidate = upsertCandidate(byExecution, {
      executionId: lease.executionId,
      threadId: lease.threadId,
      userId: lease.userId,
      startedAt: lease.startedAt,
      catId: lease.catId,
    });
    candidate.trackerSlots.push({ threadId: lease.threadId, catId: lease.catId });
  }
}

function collectProcessingCandidates(
  byExecution: Map<string, OwnerCandidate>,
  options: Parameters<typeof collectInvocationOwnerCandidates>[0],
): void {
  for (const lease of options.listStaleProcessingLeases?.(options.now) ?? []) {
    upsertCandidate(byExecution, {
      executionId: lease.executionId,
      threadId: lease.threadId,
      userId: lease.userId,
      startedAt: lease.startedAt,
      catId: lease.catId,
    });
  }
}

async function collectRecordCandidates(
  byExecution: Map<string, OwnerCandidate>,
  options: Parameters<typeof collectInvocationOwnerCandidates>[0],
): Promise<void> {
  if (!options.listRunningRecords || options.ownerLeaseTtlMs <= 0) return;
  try {
    for (const record of await options.listRunningRecords()) {
      if (record.status !== 'running') continue;
      const startedAt = record.executionStartedAt ?? record.createdAt;
      if (options.now - startedAt <= options.ownerLeaseTtlMs) continue;
      for (const catId of record.targetCats) {
        upsertCandidate(byExecution, {
          executionId: record.id,
          threadId: record.threadId,
          userId: record.userId,
          startedAt,
          catId,
        });
      }
    }
  } catch (err) {
    options.onRecordScanError(err);
  }
}

function upsertCandidate(
  candidates: Map<string, OwnerCandidate>,
  input: { executionId: string; threadId: string; userId: string; startedAt: number; catId: string },
): OwnerCandidate {
  const existing = candidates.get(input.executionId);
  if (existing) {
    if (existing.threadId !== input.threadId || existing.userId !== input.userId) existing.scopeCollision = true;
    existing.startedAt = Math.min(existing.startedAt, input.startedAt);
    existing.targetCats.add(input.catId);
    return existing;
  }
  const created: OwnerCandidate = {
    executionId: input.executionId,
    threadId: input.threadId,
    userId: input.userId,
    startedAt: input.startedAt,
    targetCats: new Set([input.catId]),
    trackerSlots: [],
    scopeCollision: false,
  };
  candidates.set(input.executionId, created);
  return created;
}
