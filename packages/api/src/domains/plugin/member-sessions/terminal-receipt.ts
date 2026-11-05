import { lifecycleResponseIdempotencyKey } from '../../cats/services/agents/invocation/response-draft-settlement.js';
import { pluginSentMessageStorageKey } from '../host-surface/plugin-sent-message-read.js';
import { readExecutionEvidence, terminalPhase } from './execution-evidence.js';
import type { MemberGrantHistory } from './journal.js';
import type { MemberCanonicalExecutionSources, MemberExecutionClaim, MemberSessionExecution } from './types.js';
import { memberExecutionKey } from './validation.js';

export type MemberTerminalReceipt = MemberSessionExecution &
  Required<Pick<MemberSessionExecution, 'invocationId' | 'responseMessageId'>>;

/** A projection of the original canonical sources. It never creates a child,
 * grants a tool, advances a cursor or accepts a package-supplied outcome. */
export async function readMemberTerminalReceipt(
  sources: MemberCanonicalExecutionSources,
  row: MemberGrantHistory,
  original: MemberSessionExecution,
  suppliedClaim?: MemberExecutionClaim,
): Promise<MemberTerminalReceipt> {
  let run = original;
  const unclaimed = !run.invocationId || !run.responseMessageId;
  const key = memberExecutionKey({ ...row, executionId: run.executionId });
  if (!run.messageId && unclaimed) {
    const source = await sources.messages.getByIdempotencyKey?.(
      row.ownerUserId,
      row.threadId,
      pluginSentMessageStorageKey(row.pluginInstanceId, key),
    );
    if (!source) throw new Error('member_execution_evidence_unavailable');
    if (
      source.userId !== row.ownerUserId ||
      source.threadId !== row.threadId ||
      source.from?.kind !== 'plugin' ||
      source.from.instanceId !== row.pluginInstanceId ||
      source.content !== run.content
    )
      throw new Error('member_execution_evidence_mismatch');
    run = { ...run, messageId: source.id };
  }
  let claim = suppliedClaim;
  if (!claim && run.invocationId && run.responseMessageId) {
    claim = {
      sessionId: row.sessionId,
      generation: row.generation,
      executionId: run.executionId,
      invocationId: run.invocationId,
      responseMessageId: run.responseMessageId,
    };
  }
  if (!claim) {
    if (!run.messageId || !sources.turns.listBySource || !sources.messages.getByIdempotencyKey)
      throw new Error('member_execution_evidence_unavailable');
    const children = await sources.turns.listBySource({
      userId: row.ownerUserId,
      threadId: row.threadId,
      catId: row.catId,
      messageId: run.messageId,
    });
    if (children.length === 0) throw new Error('member_execution_evidence_unavailable');
    if (children.length !== 1) throw new Error('member_execution_ambiguous_source');
    const invocationId = children[0].invocationId;
    const response = await sources.messages.getByIdempotencyKey(
      row.ownerUserId,
      row.threadId,
      lifecycleResponseIdempotencyKey(invocationId),
    );
    if (!response) throw new Error('member_execution_evidence_unavailable');
    claim = {
      sessionId: row.sessionId,
      generation: row.generation,
      executionId: run.executionId,
      invocationId,
      responseMessageId: response.id,
    };
  }
  const evidence = await readExecutionEvidence(sources, row, run, claim);
  const phase = terminalPhase(evidence);
  if (
    unclaimed &&
    (!['admitting', 'queued'].includes(run.phase) ||
      evidence.turn.providerStartedAt !== undefined ||
      phase === 'succeeded')
  )
    throw new Error('member_execution_unclaimed_provider_started');
  if (!unclaimed && run.phase !== 'running' && run.phase !== phase)
    throw new Error('member_execution_terminal_conflict');
  return { ...run, invocationId: claim.invocationId, responseMessageId: claim.responseMessageId, phase };
}
