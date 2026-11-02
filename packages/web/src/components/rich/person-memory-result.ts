import type { DecisionResultStatus } from './ApprovalResultRow';
import type { decisionResultCopy } from './decision-result.shell-copy';
import type { personMemoryCopy } from './person-memory.shell-copy';
import type { PersonMemorySnapshot } from './person-memory-proposal-source';

type ResultState =
  | 'materialized'
  | 'partially_materialized'
  | 'rejected'
  | 'withdrawn'
  | 'undone'
  | 'not_now'
  | 'approved_unknown'
  | 'closed';

/** A historical Undo can be an epoch marker without describing the current terminal. */
export function personMemorySnapshotResult(snapshot: PersonMemorySnapshot): {
  status: DecisionResultStatus;
  outcome: ResultState;
  undoApplied: boolean;
} {
  if (snapshot.replacedByProposalId) return { status: 'closed', outcome: 'closed', undoApplied: false };
  const undoApplied =
    snapshot.status === 'withdrawn' &&
    snapshot.undoApplied === true &&
    snapshot.undoReceipt?.candidateId === snapshot.proposalId &&
    snapshot.undoReceipt.candidateState === 'withdrawn';
  if (snapshot.status === 'withdrawn')
    return { status: 'withdrawn', outcome: undoApplied ? 'undone' : 'withdrawn', undoApplied };
  if (snapshot.status === 'rejected')
    return { status: snapshot.hasRetainedWrites ? 'approved' : 'rejected', outcome: 'rejected', undoApplied: false };
  if (snapshot.status === 'materialized' || snapshot.status === 'partially_materialized')
    return { status: 'approved', outcome: snapshot.status, undoApplied: false };
  return { status: 'closed', outcome: snapshot.status === 'not_now' ? 'not_now' : 'closed', undoApplied: false };
}

/** The same truthful sentence is used before and after lazy producer disclosure. */
export function personMemoryOutcomeText(
  state: ResultState,
  t: typeof personMemoryCopy.zh,
  resultCopy: typeof decisionResultCopy.zh,
  hasRetainedWrites = false,
  writtenCount: number | null = null,
): string {
  let outcome: string;
  switch (state) {
    case 'materialized':
      outcome = `${resultCopy.approved} · ${t.written}`;
      break;
    case 'partially_materialized':
      outcome = t.partial;
      break;
    case 'rejected':
      outcome = hasRetainedWrites ? t.rejectedAfterWrite(writtenCount) : resultCopy.declined;
      break;
    case 'withdrawn':
      outcome = t.withdrawn;
      break;
    case 'undone':
      outcome = t.undone;
      break;
    case 'not_now':
      outcome = t.deferred;
      break;
    case 'approved_unknown':
      outcome = `${resultCopy.approved} · ${resultCopy.unknown}`;
      break;
    case 'closed':
      outcome = resultCopy.closed;
      break;
  }
  if (hasRetainedWrites && ['undone', 'withdrawn', 'closed', 'not_now'].includes(state))
    outcome = `${outcome} · ${t.writesRemain}`;
  return outcome;
}

export function personMemoryResultLabel(
  state: ResultState,
  name: string | null,
  t: typeof personMemoryCopy.zh,
  resultCopy: typeof decisionResultCopy.zh,
  hasRetainedWrites = false,
  writtenCount: number | null = null,
): string {
  return [
    personMemoryOutcomeText(state, t, resultCopy, hasRetainedWrites, writtenCount),
    t.kind,
    name ? t.person(name) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Only canonical materialized counts/ids support a quantity; absence is not zero. */
export function personMemoryWriteCount(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const counts = ['claims', 'relationships', 'events'].map((key) => data[key]);
  if (counts.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0))
    return (counts as number[]).reduce((a, b) => a + b, 0);
  const ids = ['materializedClaimIds', 'materializedRelationshipIds', 'materializedEventIds'].map((key) => data[key]);
  return ids.every((v) => Array.isArray(v) && v.every((id) => typeof id === 'string'))
    ? ids.reduce<number>((n, v) => n + (v as string[]).length, 0)
    : null;
}
