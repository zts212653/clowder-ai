import assert from 'node:assert/strict';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { lifecycleInputIdentityForStoredMessage } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { queueHttpFixture } from './1398-queue-http-fixture.js';

export async function settlePrestartSibling(f, source, entry) {
  const identity = lifecycleInputIdentityForStoredMessage(await f.messages.getById(source.id));
  const patch = {
    ...identity,
    from: source.from,
    targetId: 'opus',
    statusMessageId: 'successful-opus-response',
    dispatchedAt: Date.now(),
  };
  assert.equal(
    (await f.messages.advanceLifecycleInputDispatch(source.id, { ...patch, phase: 'dispatched' })).kind,
    'applied',
  );
  assert.equal(
    (await f.messages.advanceLifecycleInputDispatch(source.id, { ...patch, phase: 'settled' })).kind,
    'applied',
  );
  assert.equal((await f.queue.retireClaimedLifecycleTarget(source.threadId, entry.id, 'opus')).outcome, 'retired');
}

export async function runPrestartFailure(t, { f, reason, processing, sibling = false, prepareOnly = false }) {
  f ??= await queueHttpFixture(t);
  const threadId = f.thread.id;
  const source = await f.messages.append({
    from: { kind: 'agent', catId: 'codex' },
    userId: 'owner',
    threadId,
    content: 'Review before provider startup',
    mentions: sibling ? ['gemini', 'opus'] : ['gemini'],
    timestamp: Date.now(),
  });
  const { entry } = await f.queue.enqueueExistingMessageDurable(f.messages, source.id, {
    from: source.from,
    userId: source.userId,
    threadId,
    kind: 'message_wake',
    sourceCategory: 'a2a',
    sourceId: source.id,
    messageId: source.id,
    content: source.content,
    targetCats: source.mentions,
    a2aTriggerMessageId: source.id,
    a2aParentInvocationId: 'caller-invocation',
    intent: 'execute',
    autoExecute: true,
    ownerAuthProvenance: 'strict',
  });
  if (sibling === 'failed' || sibling === 'settled')
    assert.ok(
      await f.queue.markProcessingGroupAcrossUsersDurable(
        threadId,
        { entryId: entry.id, targetCats: source.mentions },
        [entry.id],
      ),
    );
  else assert.ok(await f.queue.markProcessingByIdDurable(threadId, entry.id, 'gemini'));
  if (processing) assert.equal(await f.queue.commitClaimedProcessing(threadId, [entry.id]), true);
  if (sibling === 'settled') {
    await settlePrestartSibling(f, source, entry);
  }
  const tracker = new InvocationTracker();
  tracker.start(threadId, 'codex', 'owner', ['codex'], 'busy-caller');
  if (sibling && sibling !== 'failed') tracker.start(threadId, 'opus', 'owner', ['opus'], 'busy-sibling');
  const processor = new QueueProcessor({
    queue: f.queue,
    invocationTracker: tracker,
    invocationRecordStore: new InvocationRecordStore(),
    messageStore: f.messages,
    router: f.router,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  processor.processingSlots.set(JSON.stringify([threadId, 'gemini']), {
    startedAt: Date.now(),
    entryId: entry.id,
    userId: 'owner',
  });
  const outcome = prepareOnly
    ? undefined
    : await processor.failPrestartProcessingGroup(threadId, 'gemini', 'owner', reason);
  return { ...f, source, entry, threadId, processor, outcome };
}
