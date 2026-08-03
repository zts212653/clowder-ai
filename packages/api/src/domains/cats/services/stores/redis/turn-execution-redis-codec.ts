import type { CatId } from '@cat-cafe/shared';
import {
  assertCreateTurnExecutionInput,
  assertTurnExecutionTerminalInput,
  serializeTurnExecutionIdentity,
  type TurnExecutionCausalRefs,
  type TurnExecutionKind,
  type TurnExecutionRecord,
  type TurnExecutionStatus,
} from '../ports/TurnExecutionStore.js';

export interface RedisTurnExecutionHash {
  immutableIdentity?: string;
  invocationId?: string;
  parentInvocationId?: string;
  threadId?: string;
  userId?: string;
  catId?: string;
  executionKind?: string;
  startedAt?: string;
  causal?: string;
  status?: string;
  endedAt?: string;
  terminalReason?: string;
}

type RedisTurnExecutionIdentityHash = RedisTurnExecutionHash &
  Required<
    Pick<
      RedisTurnExecutionHash,
      'invocationId' | 'parentInvocationId' | 'threadId' | 'userId' | 'catId' | 'executionKind' | 'startedAt' | 'status'
    >
  >;

function hasIdentityFields(data: RedisTurnExecutionHash): data is RedisTurnExecutionIdentityHash {
  return Boolean(
    data.invocationId &&
      data.parentInvocationId &&
      data.threadId &&
      data.userId &&
      data.catId &&
      data.executionKind &&
      data.status &&
      data.startedAt !== undefined,
  );
}

function parseCausal(raw: string | undefined): TurnExecutionCausalRefs | undefined {
  if (!raw || raw === '{}') return undefined;
  return { ...(JSON.parse(raw) as TurnExecutionCausalRefs) };
}

function hasValidLifecycle(record: TurnExecutionRecord): boolean {
  if (record.status === 'running') {
    return record.endedAt === undefined && record.terminalReason === undefined;
  }
  if (record.endedAt === undefined) return false;
  assertTurnExecutionTerminalInput(record, {
    status: record.status,
    endedAt: record.endedAt,
    ...(record.terminalReason !== undefined ? { terminalReason: record.terminalReason } : {}),
  });
  return true;
}

export function hydrateTurnExecution(data: RedisTurnExecutionHash): TurnExecutionRecord | null {
  if (!hasIdentityFields(data)) return null;
  try {
    if (!['ordinary', 'routing_guard', 'freshness_supplement'].includes(data.executionKind)) return null;
    if (!['running', 'succeeded', 'failed', 'canceled', 'interrupted'].includes(data.status)) return null;
    const causal = parseCausal(data.causal);
    const record: TurnExecutionRecord = {
      invocationId: data.invocationId,
      parentInvocationId: data.parentInvocationId,
      threadId: data.threadId,
      userId: data.userId,
      catId: data.catId as CatId,
      executionKind: data.executionKind as TurnExecutionKind,
      startedAt: Number(data.startedAt),
      ...(causal ? { causal } : {}),
      status: data.status as TurnExecutionStatus,
      ...(data.endedAt ? { endedAt: Number(data.endedAt) } : {}),
      ...(data.terminalReason ? { terminalReason: data.terminalReason } : {}),
    };
    assertCreateTurnExecutionInput(record);
    if (!hasValidLifecycle(record)) return null;
    return data.immutableIdentity === serializeTurnExecutionIdentity(record) ? record : null;
  } catch {
    return null;
  }
}

export function sortTurnExecutions(records: TurnExecutionRecord[]): TurnExecutionRecord[] {
  return records.sort(
    (left, right) => left.startedAt - right.startedAt || left.invocationId.localeCompare(right.invocationId),
  );
}
