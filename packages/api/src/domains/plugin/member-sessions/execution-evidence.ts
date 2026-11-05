import type {
  MemberCanonicalExecutionSources,
  MemberExecutionClaim,
  MemberSessionExecution,
  MemberSessionRecord,
} from './types.js';
import { coordinate } from './validation.js';

export function executionClaim(value: MemberExecutionClaim): MemberExecutionClaim {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some(
      (key) => !['sessionId', 'generation', 'executionId', 'invocationId', 'responseMessageId'].includes(key),
    )
  )
    throw new Error('invalid_member_execution_claim');
  for (const field of ['sessionId', 'executionId', 'invocationId', 'responseMessageId'] as const)
    coordinate(value[field]);
  if (!Number.isSafeInteger(value.generation) || value.generation < 1)
    throw new Error('invalid_member_execution_claim');
  return {
    sessionId: value.sessionId,
    generation: value.generation,
    executionId: value.executionId,
    invocationId: value.invocationId,
    responseMessageId: value.responseMessageId,
  };
}

export function boundExecution(
  row: Pick<MemberSessionRecord, 'generation'> & Partial<Pick<MemberSessionRecord, 'executions'>>,
  input: MemberExecutionClaim,
  archived?: MemberSessionExecution | null,
): MemberSessionExecution {
  if (row.generation !== input.generation) throw new Error('member_session_generation_changed');
  const run =
    row.executions && Object.hasOwn(row.executions, input.executionId) ? row.executions[input.executionId] : archived;
  if (!run || run.executionId !== input.executionId) throw new Error('member_execution_not_found');
  if (
    (run.invocationId && run.invocationId !== input.invocationId) ||
    (run.responseMessageId && run.responseMessageId !== input.responseMessageId)
  )
    throw new Error('member_execution_claim_conflict');
  return run;
}

/** Both sources are existing Host ledgers. No body text or package receipt is an outcome. */
export async function readExecutionEvidence(
  sources: MemberCanonicalExecutionSources,
  row: Pick<MemberSessionRecord, 'ownerUserId' | 'threadId' | 'catId'>,
  run: MemberSessionExecution,
  input: MemberExecutionClaim,
) {
  const [turn, response] = await Promise.all([
    sources.turns.get(input.invocationId),
    sources.messages.getById(input.responseMessageId),
  ]);
  const lifecycle = response?.lifecycle;
  const author = response?.from;
  if (
    !run.messageId ||
    !turn ||
    turn.invocationId !== input.invocationId ||
    turn.parentInvocationId === turn.invocationId ||
    !turn.parentInvocationId ||
    turn.userId !== row.ownerUserId ||
    turn.threadId !== row.threadId ||
    turn.catId !== row.catId ||
    turn.executionKind !== 'ordinary' ||
    turn.providerLifecycleTracked !== true ||
    turn.causal?.triggerMessageId !== run.messageId ||
    (turn.causal.coveredMessageIds !== undefined &&
      (turn.causal.coveredMessageIds.length !== 1 || turn.causal.coveredMessageIds[0] !== run.messageId)) ||
    !response ||
    response.id !== input.responseMessageId ||
    response.deletedAt ||
    response._tombstone ||
    response.recall ||
    response.sourceParseFailure ||
    response.userId !== row.ownerUserId ||
    response.threadId !== row.threadId ||
    author?.kind !== 'agent' ||
    author.catId !== row.catId ||
    lifecycle?.kind !== 'response' ||
    lifecycle.invocationId !== input.invocationId ||
    lifecycle.targetId !== row.catId ||
    lifecycle.inputMessageIds.length !== 1 ||
    lifecycle.inputMessageIds[0] !== run.messageId
  )
    throw new Error('member_execution_evidence_mismatch');
  return { turn, lifecycle };
}

export function requireRunning(evidence: Awaited<ReturnType<typeof readExecutionEvidence>>): void {
  if (
    evidence.turn.status !== 'running' ||
    evidence.lifecycle.status !== 'processing' ||
    !['open', 'allowed'].includes(evidence.turn.outputFence ?? 'open')
  )
    throw new Error('member_execution_not_running');
}

export function terminalPhase(
  evidence: Awaited<ReturnType<typeof readExecutionEvidence>>,
): MemberSessionExecution['phase'] {
  const { turn, lifecycle } = evidence;
  const expectedResponse = turn.status === 'succeeded' ? 'completed' : turn.status;
  if (
    turn.status === 'running' ||
    lifecycle.status !== expectedResponse ||
    (turn.providerStartedAt !== undefined && turn.providerTeardownAt === undefined) ||
    (turn.status === 'succeeded' && turn.providerStartedAt === undefined) ||
    !['open', 'allowed'].includes(turn.outputFence ?? 'open')
  )
    throw new Error('member_execution_settlement_pending');
  return turn.status;
}
