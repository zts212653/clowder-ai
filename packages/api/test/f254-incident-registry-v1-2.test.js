import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);
const { FreshnessOutputCommitCoordinator } = await import(
  '../dist/domains/cats/services/freshness/glass-box/FreshnessOutputCommitCoordinator.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

function fresh(frontier) {
  return {
    stale: false,
    unseenCount: 0,
    unseenSenders: [],
    unseenMessageIds: [],
    seenCursor: frontier,
    observedRawFrontierMessageId: frontier,
    scanComplete: true,
    reason: 'no_unseen',
  };
}

describe('F254 incident registry v1.2', () => {
  it('IR-13: a fresh Fable final bypasses an old poison lineage and enters the next peer context', async () => {
    const messageStore = new MessageStore();
    const closureStore = new InMemoryFreshnessClosureStore();
    const old = await closureStore.openOrAdvance({
      closureId: 'old-fable-poison',
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'fable5',
      invocationId: 'old-parent',
      turnInvocationId: 'old-turn',
      originTriggerMessageId: 'old-trigger',
      draftContent: 'old canceled draft',
      requiredMessageIds: ['old-frontier'],
      requiredFrontierMessageId: 'old-frontier',
      observedRawFrontierMessageId: 'old-frontier',
      now: 100,
    });
    await closureStore.claimAttempt(old.id, {
      invocationId: 'old-successor',
      inputFrontierMessageId: 'old-frontier',
      observedRawFrontierMessageId: 'old-frontier',
      now: 110,
    });
    await closureStore.blockAttempt(old.id, {
      invocationId: 'old-successor',
      reason: 'user_cancel',
      evidenceRefs: ['ws:legacy-phantom'],
      draftContent: 'old canceled replacement',
      now: 120,
    });

    const trigger = await messageStore.append({
      userId: 'user-1',
      threadId: 'thread-1',
      catId: null,
      content: 'new independent question',
      mentions: ['fable5'],
      timestamp: 200,
    });
    const coordinator = new FreshnessOutputCommitCoordinator({ messageStore, closureStore });
    const decision = await coordinator.commit({
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'fable5',
      invocationId: 'new-parent',
      turnInvocationId: 'new-fable-turn',
      originTriggerMessageId: trigger.id,
      message: {
        userId: 'user-1',
        threadId: 'thread-1',
        catId: 'fable5',
        content: 'Fable durable answer visible to Sol',
        mentions: [],
        timestamp: 210,
        origin: 'stream',
        extra: { stream: { invocationId: 'new-parent', turnInvocationId: 'new-fable-turn' } },
      },
      evaluateFreshness: async () => ({ freshness: fresh(trigger.id), rawFrontierMessageId: trigger.id }),
    });

    assert.equal(decision.kind, 'committed_fresh');
    assert.equal((await closureStore.get(old.id)).status, 'blocked');
    const history = await messageStore.getByThread('thread-1');
    const nextPeerContext = assembleContext(history, { maxTotalTokens: 4000 });
    assert.match(nextPeerContext.contextText, /Fable durable answer visible to Sol/);
    assert.equal(
      history.find((message) => message.id === decision.messageId)?.extra?.stream?.turnInvocationId,
      'new-fable-turn',
    );
  });
});
