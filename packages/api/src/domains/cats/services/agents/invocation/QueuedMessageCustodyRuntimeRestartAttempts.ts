import type { QueueTargetAttempt } from '@cat-cafe/shared';
import type { QueuedMessageCustody } from '../../stores/ports/MessageStore.js';

export function projectRuntimeRestartAttempts(
  current: QueuedMessageCustody,
  interruptedTargetCats: ReadonlySet<string>,
  now: number,
): QueueTargetAttempt[] | undefined {
  if (interruptedTargetCats.size === 0) {
    return current.targetAttempts?.map((attempt) => ({ ...attempt }));
  }
  const attempts = (current.targetAttempts ?? []).map((attempt) => ({ ...attempt }));
  for (const catId of interruptedTargetCats) {
    const candidates = attempts
      .map((attempt, index) => ({ attempt, index }))
      .filter(({ attempt }) => attempt.targetCatId === catId)
      .sort((left, right) => left.attempt.sequence - right.attempt.sequence);
    const latest = candidates.at(-1);
    const invocationId =
      latest?.attempt.invocationId ??
      current.seenInvocationIdByCatId[catId] ??
      current.awakenedInvocationIdByCatId?.[catId];
    if (latest) {
      if (latest.attempt.state === 'interrupted') continue;
      if (['failed', 'cancelled', 'handled'].includes(latest.attempt.state)) {
        const sequence = latest.attempt.sequence + 1;
        const entryId = current.carrierByTargetCatId?.[catId]?.entryId ?? current.entryId;
        attempts.push({
          id: `${entryId}:${catId}:${sequence}`,
          targetCatId: catId,
          sequence,
          state: 'interrupted',
          terminalReason: 'runtime_restart',
          createdAt: now,
          updatedAt: now,
          ...(invocationId ? { invocationId } : {}),
        });
        continue;
      }
      attempts[latest.index] = {
        ...latest.attempt,
        state: 'interrupted',
        terminalReason: 'runtime_restart',
        updatedAt: Math.max(latest.attempt.updatedAt, now),
        ...(invocationId ? { invocationId } : {}),
      };
      continue;
    }
    const entryId = current.carrierByTargetCatId?.[catId]?.entryId ?? current.entryId;
    attempts.push({
      id: `${entryId}:${catId}:1`,
      targetCatId: catId,
      sequence: 1,
      state: 'interrupted',
      terminalReason: 'runtime_restart',
      createdAt: current.processingStartedAt ?? current.createdAt,
      updatedAt: now,
      ...(invocationId ? { invocationId } : {}),
    });
  }
  return attempts;
}
