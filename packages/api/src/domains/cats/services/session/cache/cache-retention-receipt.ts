import { isDeepStrictEqual } from 'node:util';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import type { TranscriptReader } from '../TranscriptReader.js';
import type { CacheRetentionProbeReceipt } from './CacheRetentionProbeService.js';

export interface RetentionReceiptScope {
  userId: string;
  catId: string;
  threadId: string;
  sessionId: string;
  nativeSessionId: string;
  sourceInvocationId: string;
  attemptId: string;
}

export function retentionProbeAttemptRef(
  input: Pick<RetentionReceiptScope, 'sessionId' | 'sourceInvocationId' | 'attemptId'>,
): string {
  return `cache-retention-probe:${input.sessionId}:${input.sourceInvocationId}:${input.attemptId}`;
}

/** The execution parent identifies the attempt; only its durable transcript can recover its result. */
export async function readRetentionReceipt(
  deps: {
    executions: Pick<ITurnExecutionStore, 'listByParent'>;
    reader: Pick<TranscriptReader, 'readInvocationEvents'>;
  },
  input: RetentionReceiptScope,
): Promise<CacheRetentionProbeReceipt | null> {
  const executions = await deps.executions.listByParent(retentionProbeAttemptRef(input));
  if (executions.length !== 1) return null;
  const execution = executions[0]!;
  if (
    execution.executionKind !== 'cache_retention' ||
    execution.userId !== input.userId ||
    execution.catId !== input.catId ||
    execution.threadId !== input.threadId
  )
    return null;
  const events = await deps.reader.readInvocationEvents(
    input.sessionId,
    input.threadId,
    input.catId,
    execution.invocationId,
  );
  const receipts: CacheRetentionProbeReceipt[] = [];
  for (const entry of events ?? []) {
    if (entry.event.type !== 'cache_retention_result') continue;
    const value = entry.event.receipt as Partial<CacheRetentionProbeReceipt> | null;
    if (
      !value ||
      value.v !== 1 ||
      value.invocationId !== execution.invocationId ||
      value.sessionId !== input.sessionId ||
      value.parentNativeSessionId !== input.nativeSessionId ||
      value.sourceInvocationId !== input.sourceInvocationId ||
      !['sample_pass', 'skipped', 'failed'].includes(value.outcome ?? '') ||
      !Number.isFinite(value.startedAt) ||
      !Number.isFinite(value.endedAt)
    )
      return null;
    receipts.push(value as CacheRetentionProbeReceipt);
  }
  const first = receipts[0];
  return first && receipts.every((receipt) => isDeepStrictEqual(receipt, first)) ? first : null;
}
