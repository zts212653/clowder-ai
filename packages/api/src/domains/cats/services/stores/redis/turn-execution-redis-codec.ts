import type { CatId } from '@cat-cafe/shared';
import {
  assertCoveredMessageIds,
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
  /** Late-bound coverage stays outside legacy causal so old readers remain valid. */
  coveredMessageIds?: string;
  coveredMessageIdsIdentity?: string;
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

function parseCoveredMessageIds(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value): value is string => typeof value === 'string')) {
    throw new Error('coveredMessageIds must be a string array');
  }
  assertCoveredMessageIds(parsed);
  return [...parsed];
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
    const legacyCausal = parseCausal(data.causal);
    const legacyRecord: TurnExecutionRecord = {
      invocationId: data.invocationId,
      parentInvocationId: data.parentInvocationId,
      threadId: data.threadId,
      userId: data.userId,
      catId: data.catId as CatId,
      executionKind: data.executionKind as TurnExecutionKind,
      startedAt: Number(data.startedAt),
      ...(legacyCausal ? { causal: legacyCausal } : {}),
      status: data.status as TurnExecutionStatus,
      ...(data.endedAt ? { endedAt: Number(data.endedAt) } : {}),
      ...(data.terminalReason ? { terminalReason: data.terminalReason } : {}),
    };
    assertCreateTurnExecutionInput(legacyRecord);
    if (data.immutableIdentity !== serializeTurnExecutionIdentity(legacyRecord)) return null;
    const hasCoverage = data.coveredMessageIds !== undefined;
    const hasCoverageIdentity = data.coveredMessageIdsIdentity !== undefined;
    if (hasCoverage !== hasCoverageIdentity) return null;
    const record = hasCoverage
      ? {
          ...legacyRecord,
          causal: {
            ...(legacyRecord.causal ?? {}),
            coveredMessageIds: parseCoveredMessageIds(data.coveredMessageIds!),
          },
        }
      : legacyRecord;
    assertCreateTurnExecutionInput(record);
    if (!hasValidLifecycle(record)) return null;
    if (hasCoverageIdentity && data.coveredMessageIdsIdentity !== serializeTurnExecutionIdentity(record)) return null;
    return record;
  } catch {
    return null;
  }
}

export function sortTurnExecutions(records: TurnExecutionRecord[]): TurnExecutionRecord[] {
  return records.sort(
    (left, right) => left.startedAt - right.startedAt || left.invocationId.localeCompare(right.invocationId),
  );
}
