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

export async function assertPrestartWithdrawalRace(t, fixture, withdrawal = 'group', phase = 'read') {
  const f = await runPrestartFailure(t, {
    f: fixture,
    reason: 'prestart_timeout',
    processing: true,
    prepareOnly: true,
  });
  let raced = false;
  const withdraw = async () => {
    raced = true;
    const expected = phase === 'read' ? 'retired' : 'state_changed';
    if (withdrawal === 'thread') {
      assert.equal((await f.processor.retireThreadPrestartProcessingGroups(f.threadId, 'owner')).outcome, expected);
    } else if (withdrawal === 'replacement') {
      const controller = await f.processor.acquireExternalExecution(f.threadId, ['gemini'], 'owner', {
        mode: 'replacement',
        executionId: 'replacement',
      });
      assert.equal(controller !== null, phase === 'read');
      assert.equal(f.processor.deps.invocationTracker.has(f.threadId, 'gemini'), phase === 'read');
    } else {
      assert.equal(await f.processor.retirePrestartProcessingGroup(f.threadId, 'gemini', 'owner'), expected);
    }
    if (phase === 'read') assert.equal(await f.queue.getDurableEntry(f.threadId, f.entry.id), null);
  };
  f.processor.deps.messageStore = new Proxy(f.messages, {
    get(target, property) {
      if (property === 'getById')
        return async (id) => {
          const result = await target.getById(id);
          if (phase === 'read' && id === f.source.id && !raced) await withdraw();
          return result;
        };
      if (property === 'commitLifecyclePreAdmissionFailure')
        return async (input) => {
          if (phase === 'commit' && !raced) await withdraw();
          return target.commitLifecyclePreAdmissionFailure(input);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  assert.equal(
    await f.processor.failPrestartProcessingGroup(f.threadId, 'gemini', 'owner', 'prestart_timeout'),
    phase === 'read' ? 'state_changed' : 'retired',
  );
  assert.equal(raced, true);
  assert.equal(
    (await f.queue.listAllDurable(f.threadId)).filter((row) => row.sourceCategory === 'a2a_failure').length,
    phase === 'read' ? 0 : 1,
    'completed withdrawal must not acquire a later caller wake',
  );
  assert.equal(
    (await f.messages.getByThread(f.threadId)).filter((row) => row.lifecycle?.kind === 'delivery_failure').length,
    phase === 'read' ? 0 : 1,
  );
}
