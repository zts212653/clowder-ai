import {
  assertQueueLedgerEntry,
  cloneQueueLedgerEntry,
  type QueueLedgerCommitMode,
  type QueueLedgerEntry,
  type QueueLedgerTransitionResult,
} from './QueueLedger.js';

export function commitInMemoryQueueLedgerEntry(input: {
  rows: Map<string, QueueLedgerEntry[]>;
  unindexEntries(threadId: string, entries: readonly QueueLedgerEntry[]): void;
  threadId: string;
  entryId: string;
  claimId: string;
  mode: QueueLedgerCommitMode;
  at: number;
  replacement?: QueueLedgerEntry;
}): QueueLedgerTransitionResult {
  const current = input.rows.get(input.threadId);
  const index = current?.findIndex((entry) => entry.id === input.entryId) ?? -1;
  if (!current || index < 0) return { outcome: 'not_found' };
  const entry = current[index];
  if (!entry) return { outcome: 'not_found' };
  if (input.mode === 'processing_evidence' || input.mode === 'terminal') return { outcome: 'state_changed' };
  if (input.mode === 'processing') return commitClaimedTarget(input, current, index, entry);
  if (input.mode === 'queued') return commitClaimedState(input, current, index, entry);
  return commitWithdrawn(input, current, index, entry);
}

function replacementFor(entry: QueueLedgerEntry, replacement: QueueLedgerEntry | undefined): QueueLedgerEntry {
  const next = replacement ? cloneQueueLedgerEntry(replacement) : cloneQueueLedgerEntry(entry);
  if (next.id !== entry.id || next.threadId !== entry.threadId) {
    throw new Error('Queue commit identity mismatch');
  }
  return next;
}

function commitClaimedState(
  input: Parameters<typeof commitInMemoryQueueLedgerEntry>[0],
  current: QueueLedgerEntry[],
  index: number,
  entry: QueueLedgerEntry,
): QueueLedgerTransitionResult {
  if (entry.status !== 'claimed' || entry.claimId !== input.claimId) return { outcome: 'state_changed' };
  const next = replacementFor(entry, input.replacement);
  next.status = 'queued';
  delete next.claimId;
  delete next.claimedAt;
  delete next.claimedTargetIds;
  delete next.claimedFromTargetless;
  delete next.processingStartedAt;
  assertQueueLedgerEntry(next);
  current[index] = next;
  return { outcome: 'updated', entry: cloneQueueLedgerEntry(next) };
}

function commitClaimedTarget(
  input: Parameters<typeof commitInMemoryQueueLedgerEntry>[0],
  current: QueueLedgerEntry[],
  index: number,
  entry: QueueLedgerEntry,
): QueueLedgerTransitionResult {
  if (entry.status !== 'claimed' || entry.claimId !== input.claimId || !entry.claimedTargetIds?.length) {
    return { outcome: 'state_changed' };
  }
  const claimedTargets = [...entry.claimedTargetIds];
  const source = replacementFor(entry, input.replacement);
  const attempted = cloneQueueLedgerEntry(source);
  attempted.targets = claimedTargets;
  attempted.status = 'processing';
  attempted.processingStartedAt = input.at;
  delete attempted.claimId;
  delete attempted.claimedAt;
  delete attempted.claimedTargetIds;
  delete attempted.claimedFromTargetless;
  delete attempted.terminalAt;

  const claimedSet = new Set(claimedTargets);
  const remainingTargets = entry.targets.filter((targetId) => !claimedSet.has(targetId));
  if (remainingTargets.length === 0) {
    current.splice(index, 1);
    input.unindexEntries(input.threadId, [entry]);
    if (current.length === 0) input.rows.delete(input.threadId);
  } else {
    const remaining = cloneQueueLedgerEntry(entry);
    remaining.targets = remainingTargets;
    remaining.status = 'queued';
    delete remaining.claimId;
    delete remaining.claimedAt;
    delete remaining.claimedTargetIds;
    delete remaining.claimedFromTargetless;
    delete remaining.processingStartedAt;
    delete remaining.terminalAt;
    delete remaining.delivery.steerRequestedAt;
    if (remaining.delivery.authorIntentByTarget) {
      remaining.delivery.authorIntentByTarget = Object.fromEntries(
        Object.entries(remaining.delivery.authorIntentByTarget).filter(([targetId]) =>
          remainingTargets.includes(targetId),
        ),
      );
    }
    assertQueueLedgerEntry(remaining);
    current[index] = remaining;
  }
  return { outcome: 'updated', entry: attempted };
}

function commitWithdrawn(
  input: Parameters<typeof commitInMemoryQueueLedgerEntry>[0],
  current: QueueLedgerEntry[],
  index: number,
  entry: QueueLedgerEntry,
): QueueLedgerTransitionResult {
  if (entry.status !== 'claimed' || entry.claimId !== input.claimId) return { outcome: 'state_changed' };
  const terminal = replacementFor(entry, input.replacement);
  terminal.status = 'terminal';
  terminal.terminalAt = input.at;
  delete terminal.claimId;
  delete terminal.claimedAt;
  delete terminal.claimedTargetIds;
  delete terminal.claimedFromTargetless;
  current.splice(index, 1);
  input.unindexEntries(input.threadId, [entry]);
  if (current.length === 0) input.rows.delete(input.threadId);
  return { outcome: 'updated', entry: cloneQueueLedgerEntry(terminal) };
}
