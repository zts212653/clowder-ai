import { isMessageFrom } from '@cat-cafe/shared';
import type { QueueLedgerEntry, QueueLedgerExecution, QueueLedgerPayload, QueueOwner } from './QueueLedger.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function assertOptionalTimestamp(value: unknown, field: string): void {
  if (value !== undefined && !isFiniteTimestamp(value)) throw new Error(`queue ledger ${field} is invalid`);
}

function assertQueueLedgerState(entry: QueueLedgerEntry): void {
  if (
    entry.status === 'queued' &&
    (entry.claimId !== undefined ||
      entry.claimedAt !== undefined ||
      entry.claimedTargetIds !== undefined ||
      entry.claimedFromTargetless !== undefined)
  ) {
    throw new Error('queued ledger entry cannot carry a claim');
  }
  if (
    entry.status === 'claimed' &&
    (!entry.claimId ||
      entry.claimedAt === undefined ||
      !Array.isArray(entry.claimedTargetIds) ||
      entry.claimedTargetIds.some((targetId) => !entry.targets.includes(targetId)))
  ) {
    throw new Error('claimed ledger entry requires claim identity and timestamp');
  }
  if (entry.status === 'processing' && entry.processingStartedAt === undefined) {
    throw new Error('processing ledger entry requires processingStartedAt');
  }
  if (entry.status === 'terminal' && entry.terminalAt === undefined) {
    throw new Error('terminal ledger entry requires terminalAt');
  }
  if (entry.status === 'terminal' && (entry.claimId !== undefined || entry.claimedAt !== undefined)) {
    throw new Error('terminal ledger entry cannot carry a claim');
  }
}

function assertQueueOwner(value: unknown): asserts value is QueueOwner {
  if (!isRecord(value)) throw new Error('queue ledger owner is invalid');
  const owner = value as Partial<QueueOwner>;
  if (owner.kind === 'user' && typeof owner.userId === 'string' && owner.userId) return;
  if (owner.kind === 'system' && typeof owner.service === 'string' && owner.service) return;
  throw new Error('queue ledger owner is incomplete');
}

function assertQueueTargets(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    !value.every((targetId) => typeof targetId === 'string' && targetId.length > 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error('queue ledger targets are invalid');
  }
}

function assertQueuePayload(value: unknown): asserts value is QueueLedgerPayload {
  if (!isRecord(value) || typeof value.sourceRecordId !== 'string' || !value.sourceRecordId) {
    throw new Error('queue ledger payload identity is incomplete');
  }
  if (typeof value.content !== 'string') throw new Error('queue ledger payload content is invalid');
  if (value.messageId !== undefined && typeof value.messageId !== 'string') {
    throw new Error('queue ledger payload messageId is invalid');
  }
}

function assertQueueExecution(value: unknown): asserts value is QueueLedgerExecution {
  if (!isRecord(value)) throw new Error('queue ledger execution is invalid');
  if (typeof value.intent !== 'string' || !value.intent) throw new Error('queue ledger execution intent is invalid');
  if (!['strict', 'compatibility_fallback', 'unknown'].includes(String(value.ownerAuthProvenance))) {
    throw new Error('queue ledger owner auth provenance is invalid');
  }
  if (typeof value.autoExecute !== 'boolean') throw new Error('queue ledger autoExecute is invalid');
  if (
    value.requiresExactCloudDispatchProvenance !== undefined &&
    typeof value.requiresExactCloudDispatchProvenance !== 'boolean'
  ) {
    throw new Error('queue ledger exact cloud provenance requirement is invalid');
  }
  if (value.cloudDispatchProvenance !== undefined) {
    if (
      !isRecord(value.cloudDispatchProvenance) ||
      typeof value.cloudDispatchProvenance.sourceMessageId !== 'string' ||
      !value.cloudDispatchProvenance.sourceMessageId ||
      typeof value.cloudDispatchProvenance.calledByCatId !== 'string' ||
      !value.cloudDispatchProvenance.calledByCatId ||
      typeof value.cloudDispatchProvenance.intent !== 'string' ||
      !isRecord(value.cloudDispatchProvenance.sourceSender)
    ) {
      throw new Error('queue ledger cloud dispatch provenance is invalid');
    }
  }
}

function assertQueueClassification(entry: Partial<QueueLedgerEntry>): void {
  if (entry.kind !== 'conversation_input' && entry.kind !== 'message_wake' && entry.kind !== 'private_input') {
    throw new Error('queue ledger kind is invalid');
  }
  if (!['queued', 'claimed', 'processing', 'terminal'].includes(entry.status ?? '')) {
    throw new Error('queue ledger status is invalid');
  }
  if (entry.priority !== 'urgent' && entry.priority !== 'normal') throw new Error('queue ledger priority is invalid');
  const sourceCategories = [
    'ci',
    'review',
    'conflict',
    'scheduled',
    'a2a',
    'a2a_failure',
    'continuation',
    'issue',
    'freshness',
  ];
  if (entry.sourceCategory !== undefined && !sourceCategories.includes(entry.sourceCategory)) {
    throw new Error('queue ledger source category is invalid');
  }
}

export function assertQueueLedgerEntry(value: unknown): asserts value is QueueLedgerEntry {
  if (!isRecord(value)) throw new Error('queue ledger row is invalid');
  const entry = value as Partial<QueueLedgerEntry>;
  if (entry.version !== 2) throw new Error('unsupported queue ledger entry version');
  if (typeof entry.id !== 'string' || !entry.id || typeof entry.threadId !== 'string' || !entry.threadId) {
    throw new Error('queue ledger identity is incomplete');
  }
  assertQueueOwner(entry.owner);
  assertQueueClassification(entry);
  assertQueueTargets(entry.targets);
  if (!isMessageFrom(entry.from)) throw new Error('queue ledger sender is invalid');
  assertQueuePayload(entry.payload);
  assertQueueExecution(entry.execution);
  if (!isRecord(entry.delivery)) throw new Error('queue ledger delivery is invalid');
  if (!isFiniteTimestamp(entry.enqueuedAt)) throw new Error('queue ledger enqueuedAt is invalid');
  assertOptionalTimestamp(entry.claimedAt, 'claimedAt');
  assertOptionalTimestamp(entry.processingStartedAt, 'processingStartedAt');
  assertOptionalTimestamp(entry.terminalAt, 'terminalAt');
  assertQueueLedgerState(entry as QueueLedgerEntry);
}
