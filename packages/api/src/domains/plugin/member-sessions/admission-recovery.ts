import { pluginSentMessageStorageKey } from '../host-surface/plugin-sent-message-read.js';
import type { MemberGrantHistory } from './journal.js';
import type { MemberCanonicalExecutionSources, MemberSessionExecution } from './types.js';
import { memberExecutionKey } from './validation.js';

/** Only a fenced historical reserve with a durable no-dispatch marker and no
 * original canonical source can be retired. A missing ACK, unavailable index,
 * legacy marker or in-flight append remains uncertain and retains its identity. */
export async function readHistoricalMemberAdmission(
  sources: MemberCanonicalExecutionSources,
  original: MemberGrantHistory,
  currentGeneration: number,
  run: MemberSessionExecution,
): Promise<MemberSessionExecution> {
  if (
    original.generation >= currentGeneration ||
    run.phase !== 'admitting' ||
    run.dispatchStarted !== false ||
    run.messageId ||
    run.invocationId ||
    run.responseMessageId ||
    !sources.messages.getByIdempotencyKey
  )
    return run;
  const source = await sources.messages.getByIdempotencyKey(
    original.ownerUserId,
    original.threadId,
    pluginSentMessageStorageKey(
      original.pluginInstanceId,
      memberExecutionKey({ ...original, executionId: run.executionId }),
    ),
  );
  // Inspect the raw permanent index, so even a tombstone blocks absence proof.
  if (source) return run;
  return { ...run, admissionState: 'not_dispatched' };
}
