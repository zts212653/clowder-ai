import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  lifecycleResponseIdempotencyKey,
  responseOutcomeForEndedTurn,
  settleResponseFromDraft,
} from '../../dist/domains/cats/services/agents/invocation/response-draft-settlement.js';
import { TurnExecutionStartupReconciler } from '../../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js';
import { commitRecoveredFailedResponse } from '../../dist/routes/callback-a2a-trigger.js';

/** Exact admitted source/response, production recovery and atomic failed-result ingress. */
export async function failedResponseFixture(
  { messages, turns, ledger },
  { status = 'failed', rejected = false, isFailureReport = false } = {},
) {
  const queue = new InvocationQueue(ledger);
  const drains = [];
  const preflightCalls = [];
  const input = await messages.append({
    from: { kind: 'agent', catId: 'codex' },
    userId: 'owner',
    threadId: 'thread',
    content: '@opus work',
    mentions: ['opus'],
    timestamp: 100,
    lifecycle: { kind: 'input', orderKey: '100' },
  });
  const response = await messages.append({
    from: { kind: 'agent', catId: 'opus' },
    userId: 'owner',
    threadId: 'thread',
    content: '',
    mentions: [],
    timestamp: 110,
    replyTo: input.id,
    idempotencyKey: lifecycleResponseIdempotencyKey('child'),
    extra: {
      a2aFailureReturn: {
        triggerMessageId: input.id,
        callerCatId: 'codex',
        ownerAuthProvenance: 'strict',
        parentInvocationId: 'parent',
        isFailureReport,
      },
    },
    lifecycle: {
      kind: 'response',
      orderKey: '110',
      invocationId: 'child',
      targetId: 'opus',
      inputEntryIds: ['source-entry'],
      inputMessageIds: [input.id],
      status: 'processing',
      startedAt: 110,
    },
  });
  await messages.advanceLifecycleInputDispatch(input.id, {
    kind: 'input',
    orderKey: '100',
    targetId: 'opus',
    phase: 'dispatched',
    statusMessageId: response.id,
    dispatchedAt: 110,
  });
  await turns.createRunning({
    invocationId: 'child',
    parentInvocationId: 'parent',
    userId: 'owner',
    threadId: 'thread',
    catId: 'opus',
    executionKind: 'ordinary',
    startedAt: 110,
    causal: { triggerMessageId: input.id },
    outputFence: 'open',
  });
  await turns.transitionTerminal('child', {
    status,
    endedAt: 120,
    ...(status === 'succeeded' ? {} : { terminalReason: 'provider_error' }),
  });
  const deps = {
    messageStore: messages,
    invocationQueue: queue,
    queueProcessor: { requestDrain: async (threadId) => drains.push(threadId) },
    socketManager: { emitToUser() {}, broadcastAgentMessage() {} },
    log: { info() {}, warn() {}, error() {} },
    routingDispatchPreflight: {
      preflight: async (request) => {
        preflightCalls.push(request);
        return {
          v: 1,
          ownerId: request.ownerId,
          observedAt: 120,
          resolverState: 'ready',
          targets: request.targetCatIds.map((targetCatId) => ({
            targetCatId,
            disposition: rejected ? 'rejected' : 'accepted',
            reasons: [],
            alternatives: [],
          })),
        };
      },
    },
  };
  function recovery({ messageStore = messages, queueOwner = queue, afterCommit } = {}) {
    return new TurnExecutionStartupReconciler({
      store: turns,
      settleEndedTurnResponse: (turn) =>
        settleResponseFromDraft(
          {
            messageStore,
            turnStore: turns,
            commitFailedResponse: async (message, patch) => {
              const result = await commitRecoveredFailedResponse(
                { ...deps, messageStore, invocationQueue: queueOwner },
                message,
                patch,
              );
              await afterCommit?.();
              return result;
            },
          },
          {
            userId: turn.userId,
            threadId: turn.threadId,
            invocationId: turn.invocationId,
            ...responseOutcomeForEndedTurn(turn),
          },
        ),
    });
  }
  return { messages, turns, ledger, queue, input, response, deps, drains, recovery, preflightCalls };
}
