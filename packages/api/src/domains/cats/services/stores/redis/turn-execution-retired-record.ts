import type { CatId } from '@cat-cafe/shared';
import {
  assertTurnExecutionIdentityFields,
  assertTurnExecutionTerminalInput,
  type TurnExecutionCausalRefs,
  type TurnExecutionSourceQuery,
  type TurnExecutionTerminalStatus,
  type TurnOutputFence,
} from '../ports/TurnExecutionStore.js';
import { hasTurnExecutionIdentityFields, type RedisTurnExecutionHash } from './turn-execution-redis-codec.js';

type RetiredCausal = TurnExecutionCausalRefs & { freshnessSupplementId?: string };

function causalRefs(raw: string | undefined): RetiredCausal {
  const value: unknown = raw === undefined ? {} : JSON.parse(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid retired causal');
  return value as RetiredCausal;
}

/** Pre-ae257e2507 wire identity, including the since-retired causal field. Never used by a writer. */
function identity(data: RedisTurnExecutionHash, causal: RetiredCausal): string {
  return JSON.stringify({
    invocationId: data.invocationId,
    parentInvocationId: data.parentInvocationId,
    threadId: data.threadId,
    userId: data.userId,
    catId: data.catId,
    executionKind: data.executionKind,
    ...(data.queueCompletionPolicy ? { queueCompletionPolicy: data.queueCompletionPolicy } : {}),
    startedAt: Number(data.startedAt),
    causal: {
      ...(causal.triggerMessageId !== undefined ? { triggerMessageId: causal.triggerMessageId } : {}),
      ...(causal.freshnessSupplementId !== undefined ? { freshnessSupplementId: causal.freshnessSupplementId } : {}),
      ...(causal.routingGuardReason !== undefined ? { routingGuardReason: causal.routingGuardReason } : {}),
      ...(causal.coveredMessageIds !== undefined ? { coveredMessageIds: [...causal.coveredMessageIds].sort() } : {}),
    },
  });
}

/**
 * A global historical scan may pass a valid, provably unrelated retired execution. It must not
 * turn a matching/unknown execution into absence, recreate the retired kind, or mutate its hash.
 */
function readRetiredCausal(data: RedisTurnExecutionHash): RetiredCausal | null {
  if (!hasTurnExecutionIdentityFields(data)) return null;
  try {
    const original = causalRefs(data.causal);
    if (
      original.freshnessSupplementId !== undefined &&
      (typeof original.freshnessSupplementId !== 'string' || original.freshnessSupplementId.length === 0)
    )
      return null;
    const hasCoverage = data.coveredMessageIds !== undefined;
    if (hasCoverage !== (data.coveredMessageIdsIdentity !== undefined)) return null;
    const causal =
      data.coveredMessageIds !== undefined
        ? { ...original, coveredMessageIds: JSON.parse(data.coveredMessageIds) as string[] }
        : original;
    const fields = {
      invocationId: data.invocationId,
      parentInvocationId: data.parentInvocationId,
      threadId: data.threadId,
      userId: data.userId,
      catId: data.catId as CatId,
      startedAt: Number(data.startedAt),
      ...(data.queueCompletionPolicy ? { queueCompletionPolicy: data.queueCompletionPolicy as 'explicit_source' } : {}),
      ...(data.outputFence !== undefined ? { outputFence: data.outputFence as TurnOutputFence } : {}),
    };
    assertTurnExecutionIdentityFields({ ...fields, causal: original });
    assertTurnExecutionIdentityFields({ ...fields, causal });
    if (data.immutableIdentity !== identity(data, original)) return null;
    if (hasCoverage && data.coveredMessageIdsIdentity !== identity(data, causal)) return null;
    // Both historical and current Lua writers persist absent lifecycle values as empty strings.
    // Match the normal codec before validating; a terminal row still requires an actual end time.
    const endedAt = data.endedAt ? Number(data.endedAt) : undefined;
    const terminalReason = data.terminalReason || undefined;
    if (data.status === 'running') {
      if (endedAt !== undefined || terminalReason !== undefined) return null;
    } else {
      if (endedAt === undefined) return null;
      assertTurnExecutionTerminalInput(fields, {
        status: data.status as TurnExecutionTerminalStatus,
        endedAt,
        ...(terminalReason !== undefined ? { terminalReason } : {}),
      });
    }
    return causal;
  } catch {
    return null;
  }
}

export function isUnrelatedRetiredTurnExecution(
  data: RedisTurnExecutionHash,
  query: TurnExecutionSourceQuery,
): boolean {
  if (data.executionKind !== 'freshness_supplement') return false;
  const causal = readRetiredCausal(data);
  if (!causal) return false;
  if (data.userId !== query.userId || data.threadId !== query.threadId || data.catId !== query.catId) return true;
  // Absent causality cannot prove that this same-scope execution is unrelated.
  return (
    (causal.triggerMessageId !== undefined || causal.coveredMessageIds !== undefined) &&
    causal.triggerMessageId !== query.messageId &&
    !causal.coveredMessageIds?.includes(query.messageId)
  );
}
