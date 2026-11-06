import assert from 'node:assert/strict';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { queueHttpFixture } from './1398-queue-http-fixture.js';

export async function runPrestartFailure(t, { f, reason, processing, sibling = false }) {
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
  assert.ok(await f.queue.markProcessingByIdDurable(threadId, entry.id, 'gemini'));
  if (processing) assert.equal(await f.queue.commitClaimedProcessing(threadId, [entry.id]), true);
  const tracker = new InvocationTracker();
  tracker.start(threadId, 'codex', 'owner', ['codex'], 'busy-caller');
  if (sibling) tracker.start(threadId, 'opus', 'owner', ['opus'], 'busy-sibling');
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
  const outcome = await processor.failPrestartProcessingGroup(threadId, 'gemini', 'owner', reason);
  return { ...f, source, entry, threadId, processor, outcome };
}
