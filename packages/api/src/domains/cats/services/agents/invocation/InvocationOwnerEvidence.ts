import type { TurnExecutionRecord } from '@cat-cafe/shared';
import type { InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';
import type { CodexAppServerLifecycleSnapshot } from '../providers/CodexAppServerLifecycle.js';
import type { OwnerCandidate } from './InvocationOwnerLeaseCandidates.js';
export type IndependentOwnerVerdict = 'active' | 'terminal' | 'absent' | 'unknown';

export const PROVIDER_TERMINAL_STAGES = new Set<CodexAppServerLifecycleSnapshot['stage']>([
  'completed',
  'interrupted',
  'failed',
  'closed',
]);

export function classifyIndependentInvocationOwner(
  candidate: OwnerCandidate,
  record: InvocationRecord | null,
  children: TurnExecutionRecord[],
  providerSnapshots: CodexAppServerLifecycleSnapshot[],
): IndependentOwnerVerdict {
  if (
    record &&
    (record.id !== candidate.executionId ||
      record.threadId !== candidate.threadId ||
      record.userId !== candidate.userId)
  ) {
    return 'unknown';
  }
  if (
    children.some(
      (child) =>
        child.parentInvocationId !== candidate.executionId ||
        child.threadId !== candidate.threadId ||
        child.userId !== candidate.userId,
    )
  ) {
    return 'unknown';
  }

  const childRunning = children.some((child) => child.status === 'running');
  const providerActive = providerSnapshots.some((snapshot) => !PROVIDER_TERMINAL_STAGES.has(snapshot.stage));
  if (childRunning || providerActive) return 'active';

  if (record && (record.status === 'succeeded' || record.status === 'failed' || record.status === 'canceled')) {
    return 'terminal';
  }
  if (record?.status === 'queued') return 'unknown';
  if (children.length > 0 || providerSnapshots.length > 0) return 'terminal';
  if (record === null || record.status === 'running') return 'absent';
  return 'unknown';
}
