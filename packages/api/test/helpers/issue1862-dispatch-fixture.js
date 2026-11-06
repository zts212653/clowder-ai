import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { ExecutionAdmissionConflict } from '../../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { queueHttpFixture } from './1398-queue-http-fixture.js';

export async function waitFor(predicate) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail('Queue did not reach its expected state');
}

export async function runDispatch(
  t,
  {
    f,
    agent = true,
    parallel = false,
    failSibling = false,
    retryable = false,
    cancel = false,
    unavailable = false,
    busyCaller = true,
    drainError,
  } = {},
) {
  f ??= await queueHttpFixture(t);
  const userId = 'owner';
  const threadId = f.thread.id;
  const caller = 'codex';
  const target = 'gemini';
  const sibling = 'opus';
  const targets = parallel ? [target, sibling] : [target];
  let captures = 0;
  let launches = 0;
  let siblingLaunches = 0;
  const invocationTracker = new InvocationTracker();
  Object.assign(f.agents.get(target), {
    captureInvocationOptions() {
      captures++;
      if (cancel) invocationTracker.cancel(threadId, target, userId, 'user_cancel');
      throw new ExecutionAdmissionConflict('fixture: stale execution identity', retryable);
    },
    async *invoke() {
      launches++;
      yield { type: 'error', catId: target, error: 'unexpected provider launch', timestamp: Date.now() };
    },
  });
  if (parallel)
    f.agents.get(sibling).invoke = async function* () {
      siblingLaunches++;
      yield { type: 'text', catId: sibling, content: 'Healthy sibling answer', timestamp: Date.now() };
      yield { type: 'done', catId: sibling, timestamp: Date.now() };
    };
  if (failSibling)
    f.agents.get(sibling).captureInvocationOptions = () => {
      throw new ExecutionAdmissionConflict('fixture: stale sibling execution identity');
    };
  f.router.refreshFromRegistry(f.agents);
  let source;
  let entry;
  if (agent) {
    source = await f.messages.append({
      from: { kind: 'agent', catId: caller },
      userId,
      threadId,
      content: 'Exact review dispatch',
      mentions: targets,
      timestamp: Date.now(),
    });
    const admission = await f.queue.enqueueExistingMessageDurable(f.messages, source.id, {
      from: source.from,
      userId,
      threadId,
      kind: 'message_wake',
      sourceCategory: 'a2a',
      sourceId: source.id,
      messageId: source.id,
      content: source.content,
      targetCats: targets,
      a2aTriggerMessageId: source.id,
      a2aParentInvocationId: 'caller-invocation',
      intent: 'execute',
      autoExecute: true,
      ownerAuthProvenance: 'strict',
    });
    entry = admission.entry;
  } else {
    const sent = await f.app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': userId },
      payload: { threadId, content: 'Human task', mentions: targets },
    });
    assert.equal(sent.statusCode, 202, sent.body);
    entry = f.queue.list(threadId, userId)[0];
    source = await f.messages.getById(entry.payload.messageId);
  }
  assert.ok(entry);
  if (unavailable) {
    const code = unavailable === true ? 'AGY_IDE_EXECUTION_RETIRED' : unavailable;
    f.agents.markUnavailable(target, { code, message: 'fixture: member unavailable' });
    f.router.refreshFromRegistry(f.agents);
  }
  if (busyCaller) invocationTracker.start(threadId, caller, userId, [caller], 'busy-caller');
  const records = new InvocationRecordStore();
  const frames = [];
  const processor = new QueueProcessor(
    {
      queue: f.queue,
      invocationTracker,
      invocationRecordStore: records,
      messageStore: f.messages,
      router: f.router,
      socketManager: { emitToUser() {}, broadcastAgentMessage: (frame) => frames.push(frame), broadcastToRoom() {} },
      log: { info() {}, warn() {}, error() {} },
    },
    { retryDeferral: { baseDelayMs: 60_000 } },
  );
  const drain = processor.requestDrain(threadId);
  if (drainError) await assert.rejects(drain, drainError);
  else await drain;
  await waitFor(() => !invocationTracker.getActiveSlots(threadId).some((slot) => targets.includes(slot.catId)));
  if (!unavailable)
    assert.ok(records.listLatestTerminalByThreadIds([threadId], userId).has(threadId), JSON.stringify(frames));
  assert.equal(captures, unavailable ? 0 : cancel ? 1 : 2, JSON.stringify(frames));
  assert.equal(launches, 0);
  return {
    ...f,
    source,
    entry,
    caller,
    target,
    sibling,
    threadId,
    userId,
    processor,
    frames,
    siblingLaunches,
    invocationRecordStore: records,
    invocationTracker,
  };
}
