import {
  assertCreateTurnExecutionInput,
  assertTurnExecutionTerminalInput,
  type CreateTurnExecutionInput,
  type CreateTurnExecutionResult,
  cloneTurnExecutionRecord,
  type InterruptRunningTurnExecutionsInput,
  type ITurnExecutionStore,
  sameTurnExecutionIdentity,
  type TransitionTurnExecutionResult,
  type TurnExecutionRecord,
  type TurnExecutionTerminalInput,
} from '../ports/TurnExecutionStore.js';

function sortRecords(records: TurnExecutionRecord[]): TurnExecutionRecord[] {
  return records.sort(
    (left, right) => left.startedAt - right.startedAt || left.invocationId.localeCompare(right.invocationId),
  );
}

export class InMemoryTurnExecutionStore implements ITurnExecutionStore {
  private readonly records = new Map<string, TurnExecutionRecord>();
  private readonly parentIndex = new Map<string, Set<string>>();

  createRunning(input: CreateTurnExecutionInput): CreateTurnExecutionResult {
    assertCreateTurnExecutionInput(input);
    const existing = this.records.get(input.invocationId);
    if (existing) {
      return {
        outcome: sameTurnExecutionIdentity(existing, input) ? 'replayed' : 'conflict',
        record: cloneTurnExecutionRecord(existing),
      };
    }

    const record = cloneTurnExecutionRecord({ ...input, status: 'running' });
    this.records.set(input.invocationId, record);
    const childIds = this.parentIndex.get(input.parentInvocationId) ?? new Set<string>();
    childIds.add(input.invocationId);
    this.parentIndex.set(input.parentInvocationId, childIds);
    return { outcome: 'created', record: cloneTurnExecutionRecord(record) };
  }

  get(invocationId: string): TurnExecutionRecord | null {
    const record = this.records.get(invocationId);
    return record ? cloneTurnExecutionRecord(record) : null;
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

  transitionTerminal(invocationId: string, input: TurnExecutionTerminalInput): TransitionTurnExecutionResult {
    const record = this.records.get(invocationId);
    if (!record) return { outcome: 'not_found', record: null };
    assertTurnExecutionTerminalInput(record, input);
    if (record.status !== 'running') {
      return { outcome: 'already_terminal', record: cloneTurnExecutionRecord(record) };
    }
    record.status = input.status;
    record.endedAt = input.endedAt;
    if (input.terminalReason !== undefined) record.terminalReason = input.terminalReason;
    return { outcome: 'transitioned', record: cloneTurnExecutionRecord(record) };
  }

  interruptRunningBefore(cutoffStartedAt: number, input: InterruptRunningTurnExecutionsInput): TurnExecutionRecord[] {
    if (!Number.isFinite(cutoffStartedAt) || cutoffStartedAt < 0) {
      throw new Error('cutoffStartedAt must be a finite non-negative number');
    }
    const interrupted: TurnExecutionRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status !== 'running' || record.startedAt >= cutoffStartedAt) continue;
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
