import { commitInMemoryQueueLedgerEntry } from './InMemoryQueueLedgerCommit.js';
import {
  assertQueueLedgerEntry,
  cloneQueueLedgerEntry,
  type QueueLedgerClaimResult,
  type QueueLedgerCommitMode,
  type QueueLedgerEnqueueResult,
  type QueueLedgerEntry,
  type QueueLedgerStore,
  type QueueLedgerTargetExpansionResult,
  type QueueLedgerTargetReconcileResult,
  type QueueLedgerTransitionResult,
  queueLedgerAdmissionsMatch,
} from './QueueLedger.js';

export class InMemoryQueueLedgerStore implements QueueLedgerStore {
  private readonly rows = new Map<string, QueueLedgerEntry[]>();
  private readonly messageRows = new Map<string, Map<string, Set<string>>>();

  private indexEntries(threadId: string, entries: readonly QueueLedgerEntry[]): void {
    const threadIndex = this.messageRows.get(threadId) ?? new Map<string, Set<string>>();
    for (const entry of entries) {
      const messageId = entry.payload.messageId;
      if (!messageId) continue;
      const entryIds = threadIndex.get(messageId) ?? new Set<string>();
      entryIds.add(entry.id);
      threadIndex.set(messageId, entryIds);
    }
    if (threadIndex.size > 0) this.messageRows.set(threadId, threadIndex);
  }

  private unindexEntries(threadId: string, entries: readonly QueueLedgerEntry[]): void {
    const threadIndex = this.messageRows.get(threadId);
    if (!threadIndex) return;
    for (const entry of entries) {
      const messageId = entry.payload.messageId;
      if (!messageId) continue;
      const entryIds = threadIndex.get(messageId);
      entryIds?.delete(entry.id);
      if (entryIds?.size === 0) threadIndex.delete(messageId);
    }
    if (threadIndex.size === 0) this.messageRows.delete(threadId);
  }

  enqueueNow(entries: readonly QueueLedgerEntry[], maxQueuedUserEntries?: number): QueueLedgerEnqueueResult {
    if (entries.length === 0) throw new Error('queue ledger enqueue requires at least one row');
    for (const entry of entries) assertQueueLedgerEntry(entry);
    const threadId = entries[0]?.threadId;
    if (entries.some((entry) => entry.threadId !== threadId))
      throw new Error('queue ledger enqueue must be one thread');
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new Error('queue ledger enqueue ids must be unique');
    }
    const current = this.rows.get(threadId) ?? [];
    const existing = entries.map((entry) => current.find((candidate) => candidate.id === entry.id));
    const existingEntries = existing.filter((entry): entry is QueueLedgerEntry => entry !== undefined);
    if (existingEntries.length === entries.length) {
      return existingEntries.every((entry, index) => {
        const input = entries[index];
        return input !== undefined && queueLedgerAdmissionsMatch(entry, input);
      })
        ? { outcome: 'replayed', entries: existingEntries.map(cloneQueueLedgerEntry) }
        : { outcome: 'conflict', entries: [] };
    }
    if (existing.some(Boolean)) return { outcome: 'conflict', entries: [] };
    if (maxQueuedUserEntries !== undefined) {
      const queuedUserSources = new Set(
        current
          .filter((entry) => entry.from.kind === 'user' && entry.status === 'queued')
          .map((entry) => entry.payload.sourceRecordId),
      );
      const incomingUserSources = new Set(
        entries.filter((entry) => entry.from.kind === 'user').map((entry) => entry.payload.sourceRecordId),
      );
      if (new Set([...queuedUserSources, ...incomingUserSources]).size > maxQueuedUserEntries) {
        return { outcome: 'full', entries: [] };
      }
    }
    const inserted = entries.map(cloneQueueLedgerEntry);
    current.push(...inserted);
    this.rows.set(threadId, current);
    this.indexEntries(threadId, inserted);
    return { outcome: 'enqueued', entries: inserted.map(cloneQueueLedgerEntry) };
  }

  async enqueue(
    entries: readonly QueueLedgerEntry[],
    maxQueuedUserEntries?: number,
  ): Promise<QueueLedgerEnqueueResult> {
    return this.enqueueNow(entries, maxQueuedUserEntries);
  }

  async expandTargets(
    threadId: string,
    entryId: string,
    bindTargetCatId: string,
    expectedQueuedEntryIds: readonly string[],
    siblingEntries: readonly QueueLedgerEntry[],
  ): Promise<QueueLedgerTargetExpansionResult> {
    if (!bindTargetCatId) throw new Error('queue target expansion requires a target');
    for (const entry of siblingEntries) assertQueueLedgerEntry(entry);
    const current = this.rows.get(threadId);
    if (!current) return { outcome: 'not_found', entries: [] };
    const anchor = current.find((entry) => entry.id === entryId);
    if (!anchor) return { outcome: 'not_found', entries: [] };
    if (anchor.status !== 'queued') {
      return { outcome: 'state_changed', entries: [] };
    }
    if (
      expectedQueuedEntryIds.some((expectedId) => expectedId !== entryId) ||
      siblingEntries.some(
        (entry) =>
          entry.id !== entryId ||
          entry.threadId !== threadId ||
          entry.payload.sourceRecordId !== anchor.payload.sourceRecordId ||
          entry.status !== 'queued',
      )
    ) {
      throw new Error('invalid queue target expansion rows');
    }
    const requestedTargets = [bindTargetCatId, ...siblingEntries.flatMap((entry) => entry.targets)];
    const nextTargets = [...new Set([...anchor.targets, ...requestedTargets])];
    if (nextTargets.length === anchor.targets.length) {
      return { outcome: 'replayed', entries: [cloneQueueLedgerEntry(anchor)] };
    }
    anchor.targets = nextTargets;
    return {
      outcome: 'expanded',
      entries: [cloneQueueLedgerEntry(anchor)],
    };
  }

  async reconcileTargets(
    threadId: string,
    entryId: string,
    addTargetIds: readonly string[],
    removeTargetIds: readonly string[],
    authorIntentByTarget: Readonly<NonNullable<QueueLedgerEntry['delivery']['authorIntentByTarget']>> = {},
  ): Promise<QueueLedgerTargetReconcileResult> {
    const additions = [...new Set(addTargetIds)];
    const removals = new Set(removeTargetIds);
    if (
      additions.some((targetId) => !targetId || removals.has(targetId)) ||
      removals.has('') ||
      additions.length !== addTargetIds.length ||
      removals.size !== removeTargetIds.length
    ) {
      throw new Error('invalid Queue target reconciliation');
    }
    const current = this.rows.get(threadId);
    const index = current?.findIndex((entry) => entry.id === entryId) ?? -1;
    if (!current || index < 0) return { outcome: 'not_found' };
    const row = current[index]!;
    if (row.status !== 'queued') return { outcome: 'state_changed' };

    const nextTargets = row.targets.filter((targetId) => !removals.has(targetId));
    const present = new Set(nextTargets);
    for (const targetId of additions) {
      if (!present.has(targetId)) {
        nextTargets.push(targetId);
        present.add(targetId);
      }
    }
    const nextIntent = Object.fromEntries(
      nextTargets.flatMap((targetId) => {
        const intent = authorIntentByTarget?.[targetId] ?? row.delivery.authorIntentByTarget?.[targetId];
        return intent ? [[targetId, structuredClone(intent)] as const] : [];
      }),
    );
    const unchanged =
      nextTargets.length === row.targets.length &&
      nextTargets.every((targetId, index) => row.targets[index] === targetId) &&
      JSON.stringify(nextIntent) === JSON.stringify(row.delivery.authorIntentByTarget ?? {});
    if (unchanged) return { outcome: 'replayed', entry: cloneQueueLedgerEntry(row) };

    if (nextTargets.length === 0) {
      current.splice(index, 1);
      this.unindexEntries(threadId, [row]);
      if (current.length === 0) this.rows.delete(threadId);
      return { outcome: 'updated', entry: null };
    }
    row.targets = nextTargets;
    row.delivery.authorIntentByTarget = nextIntent;
    assertQueueLedgerEntry(row);
    return { outcome: 'updated', entry: cloneQueueLedgerEntry(row) };
  }

  /** Roll back only rows created by the same synchronous memory admission. */
  removeEnqueuedNow(entries: readonly QueueLedgerEntry[]): void {
    if (entries.length === 0) return;
    const threadId = entries[0]?.threadId;
    const current = threadId ? this.rows.get(threadId) : undefined;
    if (!current) return;
    const ids = new Set(entries.map((entry) => entry.id));
    const remaining = current.filter((entry) => !ids.has(entry.id));
    const removed = current.filter((entry) => ids.has(entry.id));
    if (remaining.length === 0) this.rows.delete(threadId);
    else this.rows.set(threadId, remaining);
    this.unindexEntries(threadId, removed);
  }

  async list(threadId: string): Promise<QueueLedgerEntry[]> {
    return (this.rows.get(threadId) ?? []).map(cloneQueueLedgerEntry);
  }

  async listAll(threadId: string): Promise<QueueLedgerEntry[]> {
    return this.list(threadId);
  }

  async getByMessageIds(threadId: string, messageIds: readonly string[]): Promise<Map<string, QueueLedgerEntry[]>> {
    const grouped = new Map<string, QueueLedgerEntry[]>();
    const threadIndex = this.messageRows.get(threadId);
    if (!threadIndex) return grouped;
    for (const messageId of new Set(messageIds)) {
      const entryIds = threadIndex.get(messageId);
      if (!entryIds) continue;
      const entries: QueueLedgerEntry[] = [];
      for (const entryId of entryIds) {
        const entry = this.getNow(threadId, entryId);
        if (!entry) throw new Error(`queue message index references missing row: ${entryId}`);
        if (entry.payload.messageId !== messageId) {
          throw new Error(`queue message index identity mismatch: ${messageId}:${entryId}`);
        }
        entries.push(entry);
      }
      grouped.set(messageId, entries);
    }
    return grouped;
  }

  async listThreadIds(): Promise<string[]> {
    return [...this.rows.keys()].sort();
  }

  async get(threadId: string, entryId: string): Promise<QueueLedgerEntry | null> {
    return this.getNow(threadId, entryId);
  }

  getNow(threadId: string, entryId: string): QueueLedgerEntry | null {
    const entry = this.rows.get(threadId)?.find((candidate) => candidate.id === entryId);
    return entry ? cloneQueueLedgerEntry(entry) : null;
  }

  async claim(
    threadId: string,
    entryId: string,
    claimId: string,
    claimedAt: number,
    bindTargetCatId?: string,
    steerRequestedAt?: number,
  ): Promise<QueueLedgerClaimResult> {
    return this.claimPrefix(threadId, [entryId], claimId, claimedAt, bindTargetCatId, steerRequestedAt);
  }

  async claimPrefix(
    threadId: string,
    entryIds: readonly string[],
    claimId: string,
    claimedAt: number,
    bindTargetCatId?: string,
    steerRequestedAt?: number,
  ): Promise<QueueLedgerClaimResult> {
    if (entryIds.length === 0 || !claimId || !Number.isFinite(claimedAt)) throw new Error('invalid queue claim');
    const current = this.rows.get(threadId);
    if (!current) return { outcome: 'not_found' };
    const selected = entryIds.map((id) => current.find((entry) => entry.id === id));
    const selectedEntries = selected.filter((entry): entry is QueueLedgerEntry => entry !== undefined);
    if (selectedEntries.length !== selected.length) return { outcome: 'not_found' };
    if (selectedEntries.some((entry) => entry.status !== 'queued')) return { outcome: 'state_changed' };
    if (
      bindTargetCatId &&
      selectedEntries.some((entry) => entry.targets.length > 0 && !entry.targets.includes(bindTargetCatId))
    ) {
      return { outcome: 'state_changed' };
    }
    for (const entry of selectedEntries) {
      entry.status = 'claimed';
      entry.claimId = claimId;
      entry.claimedAt = claimedAt;
      const wasTargetless = entry.targets.length === 0;
      if (bindTargetCatId && wasTargetless) entry.targets = [bindTargetCatId];
      entry.claimedTargetIds = bindTargetCatId ? [bindTargetCatId] : [...entry.targets];
      if (bindTargetCatId && wasTargetless) entry.claimedFromTargetless = true;
      if (steerRequestedAt !== undefined) entry.delivery.steerRequestedAt = steerRequestedAt;
    }
    return { outcome: 'claimed', claimId, entries: selectedEntries.map(cloneQueueLedgerEntry) };
  }

  async commit(
    threadId: string,
    entryId: string,
    claimId: string,
    mode: QueueLedgerCommitMode,
    at: number,
    replacement?: QueueLedgerEntry,
  ): Promise<QueueLedgerTransitionResult> {
    return commitInMemoryQueueLedgerEntry({
      rows: this.rows,
      unindexEntries: (currentThreadId, entries) => this.unindexEntries(currentThreadId, entries),
      threadId,
      entryId,
      claimId,
      mode,
      at,
      ...(replacement ? { replacement } : {}),
    });
  }

  async restore(
    threadId: string,
    entryId: string,
    claimId: string,
    restoreUnassignedTarget = false,
  ): Promise<QueueLedgerTransitionResult> {
    const entry = this.rows.get(threadId)?.find((candidate) => candidate.id === entryId);
    if (!entry) return { outcome: 'not_found' };
    if (entry.status !== 'claimed' || entry.claimId !== claimId) return { outcome: 'state_changed' };
    entry.status = 'queued';
    delete entry.claimId;
    delete entry.claimedAt;
    delete entry.delivery.steerRequestedAt;
    if (restoreUnassignedTarget || entry.claimedFromTargetless) entry.targets = [];
    delete entry.claimedTargetIds;
    delete entry.claimedFromTargetless;
    return { outcome: 'updated', entry: cloneQueueLedgerEntry(entry) };
  }
}
