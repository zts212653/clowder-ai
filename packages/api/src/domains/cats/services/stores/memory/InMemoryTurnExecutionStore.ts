import { watcherUsageSchema } from '@cat-cafe/shared';
import {
  assertResponseSettlement,
  responseSettlementIdentity,
  responseSettlementReady,
  type SettledTurnPage,
  type SettledTurnQuery,
  type SettleTurnResponseResult,
  settledTurnPageLimit,
  type TurnResponseSettlement,
} from '../ports/TurnExecutionSettlement.js';
import {
  advanceTurnOutputFence,
  assertCoveredMessageIds,
  assertCreatableOutputFence,
  assertCreateTurnExecutionInput,
  assertRecentSettledLimit,
  assertTurnExecutionTerminalInput,
  type BindCoveredMessageIdsResult,
  type CreateTurnExecutionInput,
  type CreateTurnExecutionResult,
  cloneTurnExecutionRecord,
  createdOutputFence,
  HOST_SLEEP_TERMINAL_REASON,
  hasUnconfirmedProviderTeardown,
  type InterruptRunningTurnExecutionsInput,
  type ITurnExecutionStore,
  type MemberTurnStartedAfterQuery,
  matchesTurnExecutionSource,
  type RecentSettledTurnQuery,
  serializeTurnExecutionIdentity,
  type TransitionTurnExecutionResult,
  type TurnExecutionRecord,
  type TurnExecutionSourceQuery,
  type TurnExecutionTerminalInput,
  type TurnOutputFenceVerdict,
} from '../ports/TurnExecutionStore.js';

function sortRecords(records: TurnExecutionRecord[]): TurnExecutionRecord[] {
  return records.sort(
    (left, right) => left.startedAt - right.startedAt || left.invocationId.localeCompare(right.invocationId),
  );
}

export class InMemoryTurnExecutionStore implements ITurnExecutionStore {
  settledHead(userId: string, threadId?: string): number {
    let head = 0;
    for (const record of this.records.values())
      if (record.userId === userId && (!threadId || record.threadId === threadId))
        head = Math.max(head, record.settledSequence ?? 0);
    return head;
  }
  recordWatcherModelAttempt(
    invocationId: string,
    turnId: string,
    startedAt: number,
    usage?: import('@cat-cafe/shared').WatcherUsage,
  ): boolean {
    const record = this.records.get(invocationId);
    if (!record || record.executionKind !== 'watcher' || !turnId || !Number.isSafeInteger(startedAt)) return false;
    record.watcherModelAttempts ??= {};
    const previous = record.watcherModelAttempts[turnId];
    if (previous?.usage) return !usage || JSON.stringify(previous.usage) === JSON.stringify(usage);
    record.watcherModelAttempts[turnId] = {
      startedAt: previous?.startedAt ?? startedAt,
      ...(usage ? { usage: watcherUsageSchema.parse(usage) } : {}),
    };
    return true;
  }
  recordWatcherUsage(invocationId: string, usage: import('@cat-cafe/shared').WatcherUsage): boolean {
    usage = watcherUsageSchema.parse(usage);
    const record = this.records.get(invocationId);
    if (!record || record.executionKind !== 'watcher') return false;
    if (record.watcherUsage) return JSON.stringify(record.watcherUsage) === JSON.stringify(usage);
    record.watcherUsage = structuredClone(usage);
    return true;
  }

  private readonly records = new Map<string, TurnExecutionRecord>();
  private readonly owedSleepContinuations = new Set<string>();
  private readonly immutableIdentities = new Map<string, string>();
  private readonly parentIndex = new Map<string, Set<string>>();
  private readonly responsePending = new Set<string>();
  private settledSequence = 0;

  createRunning(input: CreateTurnExecutionInput): CreateTurnExecutionResult {
    assertCreateTurnExecutionInput(input);
    assertCreatableOutputFence(input);
    const existing = this.records.get(input.invocationId);
    if (existing) {
      return {
        outcome:
          this.immutableIdentities.get(input.invocationId) === serializeTurnExecutionIdentity(input)
            ? 'replayed'
            : 'conflict',
        record: cloneTurnExecutionRecord(existing),
      };
    }

    const record = cloneTurnExecutionRecord({
      ...input,
      ...(input.executionKind === 'watcher' ? { watcherModelAttempts: {} } : {}),
      outputFence: createdOutputFence(input),
      status: 'running',
    });
    this.records.set(input.invocationId, record);
    this.immutableIdentities.set(input.invocationId, serializeTurnExecutionIdentity(input));
    const childIds = this.parentIndex.get(input.parentInvocationId) ?? new Set<string>();
    childIds.add(input.invocationId);
    this.parentIndex.set(input.parentInvocationId, childIds);
    return { outcome: 'created', record: cloneTurnExecutionRecord(record) };
  }

  bindCoveredMessageIds(invocationId: string, messageIds: readonly string[]): BindCoveredMessageIdsResult {
    assertCoveredMessageIds(messageIds);
    const record = this.records.get(invocationId);
    if (!record) return { outcome: 'not_found', record: null };
    const existing = record.causal?.coveredMessageIds;
    if (existing) {
      const requested = [...messageIds].sort();
      const same =
        existing.length === requested.length &&
        [...existing].sort().every((messageId, index) => messageId === requested[index]);
      return { outcome: same ? 'replayed' : 'conflict', record: cloneTurnExecutionRecord(record) };
    }
    record.causal = { ...(record.causal ?? {}), coveredMessageIds: [...messageIds] };
    return { outcome: 'bound', record: cloneTurnExecutionRecord(record) };
  }

  get(invocationId: string): TurnExecutionRecord | null {
    const record = this.records.get(invocationId);
    return record ? cloneTurnExecutionRecord(record) : null;
  }

  listBySource(query: TurnExecutionSourceQuery): TurnExecutionRecord[] {
    return sortRecords(
      [...this.records.values()]
        .filter((record) => matchesTurnExecutionSource(record, query))
        .map(cloneTurnExecutionRecord),
    );
  }

  listByParent(parentInvocationId: string): TurnExecutionRecord[] {
    const childIds = this.parentIndex.get(parentInvocationId) ?? new Set<string>();
    return sortRecords(
      [...childIds]
        .map((invocationId) => this.records.get(invocationId))
        .filter((record): record is TurnExecutionRecord => record !== undefined)
        .map(cloneTurnExecutionRecord),
    );
  }

  listRunningByUser(userId: string): TurnExecutionRecord[] {
    return sortRecords(
      [...this.records.values()]
        .filter((record) => record.status === 'running' && record.userId === userId)
        .map(cloneTurnExecutionRecord),
    );
  }

  markProviderStarted(invocationId: string, at: number): boolean {
    const record = this.records.get(invocationId);
    if (
      !record ||
      record.status !== 'running' ||
      !record.providerLifecycleTracked ||
      !Number.isFinite(at) ||
      at < record.startedAt
    )
      return false;
    record.providerStartedAt ??= at;
    return true;
  }

  recordProviderTeardown(invocationId: string, at: number): void {
    const record = this.records.get(invocationId);
    if (!record || !Number.isFinite(at) || at < record.startedAt) throw new Error('invalid exact provider teardown');
    record.providerTeardownAt ??= at;
    this.publishPending(record);
  }

  transitionTerminal(invocationId: string, input: TurnExecutionTerminalInput): TransitionTurnExecutionResult {
    const record = this.records.get(invocationId);
    if (!record) return { outcome: 'not_found', record: null };
    assertTurnExecutionTerminalInput(record, input);
    if (record.status !== 'running') {
      return { outcome: 'already_terminal', record: cloneTurnExecutionRecord(record) };
    }
    if (
      input.status === 'succeeded' &&
      hasUnconfirmedProviderTeardown(record) &&
      input.providerTeardownAt === undefined
    )
      throw new Error('provider_teardown_unconfirmed');
    record.status = input.status;
    record.endedAt = input.endedAt;
    if (input.terminalReason !== undefined) record.terminalReason = input.terminalReason;
    if (input.providerTeardownAt !== undefined) record.providerTeardownAt = input.providerTeardownAt;
    this.responsePending.add(invocationId);
    if (input.status === 'failed' && input.terminalReason === HOST_SLEEP_TERMINAL_REASON) {
      this.owedSleepContinuations.add(invocationId);
    }
    this.publishPending(record);
    return { outcome: 'transitioned', record: cloneTurnExecutionRecord(record) };
  }

  listResponsePending(): TurnExecutionRecord[] {
    return sortRecords(
      [...this.responsePending]
        .map((invocationId) => this.records.get(invocationId))
        .filter((record): record is TurnExecutionRecord => record !== undefined)
        .map(cloneTurnExecutionRecord),
    );
  }

  clearResponsePending(invocationId: string): void {
    if (!this.records.has(invocationId) || this.records.get(invocationId)?.responseSettlement)
      this.responsePending.delete(invocationId);
  }

  markResponseSettled(invocationId: string, settlement: TurnResponseSettlement): SettleTurnResponseResult {
    assertResponseSettlement(settlement);
    const record = this.records.get(invocationId);
    if (!record) return { outcome: 'not_found', record: null };
    if (record.responseSettlement)
      return {
        outcome:
          responseSettlementIdentity(record.responseSettlement) === responseSettlementIdentity(settlement)
            ? 'replayed'
            : 'conflict',
        record: cloneTurnExecutionRecord(record),
      };
    if (
      record.pendingResponseSettlement &&
      responseSettlementIdentity(record.pendingResponseSettlement) !== responseSettlementIdentity(settlement)
    )
      return { outcome: 'conflict', record: cloneTurnExecutionRecord(record) };
    record.pendingResponseSettlement ??= { ...settlement };
    const candidate = {
      ...record.pendingResponseSettlement,
      settledAt: Math.max(settlement.settledAt, record.endedAt ?? 0, record.providerTeardownAt ?? 0),
    };
    if (!responseSettlementReady(record, candidate.settledAt))
      return { outcome: 'not_ready', record: cloneTurnExecutionRecord(record) };
    record.responseSettlement = candidate;
    delete record.pendingResponseSettlement;
    record.settledSequence = ++this.settledSequence;
    this.responsePending.delete(invocationId);
    return { outcome: 'settled', record: cloneTurnExecutionRecord(record) };
  }

  private publishPending(record: TurnExecutionRecord): void {
    if (record.pendingResponseSettlement && record.status !== 'running')
      this.markResponseSettled(record.invocationId, record.pendingResponseSettlement);
  }

  hasMemberTurnStartedAfter(query: MemberTurnStartedAfterQuery): boolean {
    for (const record of this.records.values()) {
      if (
        record.userId === query.userId &&
        record.threadId === query.threadId &&
        record.catId === query.catId &&
        record.executionKind !== 'watcher' &&
        record.startedAt > query.startedAfter
      )
        return true;
    }
    return false;
  }

  listOwedSleepContinuations(): TurnExecutionRecord[] {
    return [...this.owedSleepContinuations]
      .map((invocationId) => this.records.get(invocationId))
      .filter((record): record is TurnExecutionRecord => record !== undefined)
      .map(cloneTurnExecutionRecord);
  }

  settleOwedSleepContinuations(invocationIds: readonly string[]): void {
    for (const invocationId of invocationIds) this.owedSleepContinuations.delete(invocationId);
  }

  listRecentSettled(query: RecentSettledTurnQuery): TurnExecutionRecord[] {
    assertRecentSettledLimit(query.limit);
    return [...this.records.values()]
      .filter(
        (record) =>
          record.userId === query.userId &&
          (!query.threadId || record.threadId === query.threadId) &&
          record.responseSettlement &&
          record.settledSequence,
      )
      .sort((a, b) => b.settledSequence! - a.settledSequence!)
      .slice(0, query.limit)
      .map(cloneTurnExecutionRecord);
  }

  listSettled(query: SettledTurnQuery): SettledTurnPage {
    const limit = settledTurnPageLimit(query);
    const candidates = [...this.records.values()]
      .filter(
        (record) =>
          record.userId === query.userId &&
          (!query.threadId || record.threadId === query.threadId) &&
          (!query.watcherDays ||
            (record.executionKind === 'watcher' &&
              query.watcherDays.some((day) => watcherRecordOnUtcDay(record, day)))) &&
          (query.watcherDay === undefined ||
            (record.executionKind === 'watcher' &&
              record.responseSettlement &&
              watcherRecordOnUtcDay(record, query.watcherDay))) &&
          record.responseSettlement &&
          (record.settledSequence ?? 0) > (query.afterSequence ?? 0),
      )
      .sort((a, b) => a.settledSequence! - b.settledSequence!);
    const records = candidates.slice(0, limit).map(cloneTurnExecutionRecord);
    return {
      records,
      nextCursor: records.at(-1)?.settledSequence ?? query.afterSequence ?? 0,
      hasMore: candidates.length > limit,
    };
  }

  settleOutputFence(invocationId: string, verdict: TurnOutputFenceVerdict): TurnExecutionRecord | null {
    if (verdict !== 'allowed' && verdict !== 'rejected') throw new Error(`invalid output fence verdict: ${verdict}`);
    const record = this.records.get(invocationId);
    if (!record) return null;
    const next = advanceTurnOutputFence(record.outputFence, verdict);
    if (next !== undefined) record.outputFence = next;
    return cloneTurnExecutionRecord(record);
  }

  interruptRunningBefore(cutoffStartedAt: number, input: InterruptRunningTurnExecutionsInput): TurnExecutionRecord[] {
    if (!Number.isFinite(cutoffStartedAt) || cutoffStartedAt < 0) {
      throw new Error('cutoffStartedAt must be a finite non-negative number');
    }
    const interrupted: TurnExecutionRecord[] = [];
    const excluded = new Set(input.excludedInvocationIds ?? []);
    for (const record of this.records.values()) {
      if (
        record.status !== 'running' ||
        record.startedAt >= cutoffStartedAt ||
        input.excludedExecutionKinds?.includes(record.executionKind) ||
        excluded.has(record.invocationId)
      ) {
        continue;
      }
      const result = this.transitionTerminal(record.invocationId, {
        status: 'interrupted',
        endedAt: input.endedAt,
        terminalReason: input.terminalReason,
      });
      if (result.outcome === 'transitioned' && result.record) interrupted.push(result.record);
    }
    return sortRecords(interrupted);
  }
}

function watcherRecordOnUtcDay(record: TurnExecutionRecord, day: number): boolean {
  return (
    Math.floor(record.startedAt / 86400000) === day ||
    Object.values(record.watcherModelAttempts ?? {}).some((attempt) => Math.floor(attempt.startedAt / 86400000) === day)
  );
}
