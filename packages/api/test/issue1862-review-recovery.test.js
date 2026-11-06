import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { queueHttpFixture } from './helpers/1398-queue-http-fixture.js';
import { waitFor } from './helpers/issue1862-dispatch-fixture.js';

async function setup(t) {
  const f = await queueHttpFixture(t);
  const threadId = f.thread.id;
  const source = await f.messages.append({
    from: { kind: 'agent', catId: 'codex' },
    userId: 'owner',
    threadId,
    content: 'Review request',
    mentions: ['gemini'],
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
    targetCats: ['gemini'],
    a2aTriggerMessageId: source.id,
    a2aParentInvocationId: 'caller-invocation',
    intent: 'execute',
    autoExecute: true,
    ownerAuthProvenance: 'strict',
  });
  const tracker = new InvocationTracker();
  tracker.start(threadId, 'codex', 'owner', ['codex'], 'busy-caller');
  const processor = new QueueProcessor(
    {
      queue: f.queue,
      invocationTracker: tracker,
      invocationRecordStore: new InvocationRecordStore(),
      messageStore: f.messages,
      router: f.router,
      socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
      log: { info() {}, warn() {}, error() {} },
    },
    { retryDeferral: { baseDelayMs: 60_000 } },
  );
  return { ...f, threadId, source, entry, tracker, processor };
}

function reply(catId, launches) {
  return async function* () {
    launches.push(catId);
    yield { type: 'text', catId, content: 'Exact queued task delivered', timestamp: Date.now() };
    yield { type: 'done', catId, timestamp: Date.now() };
  };
}

async function assertOriginalDeliveredOnce(f, launches) {
  await f.processor.processNext(f.threadId, 'owner');
  await waitFor(async () => !f.tracker.has(f.threadId, 'gemini') && !(await f.queue.listAllDurable(f.threadId)).length);
  await f.processor.requestDrain(f.threadId);
  assert.deepEqual(launches, ['gemini']);
  const history = await f.messages.getByThread(f.threadId);
  assert.equal(history.filter((row) => row.lifecycle?.kind === 'delivery_failure').length, 0);
  const [response, ...duplicates] = history.filter((row) => row.lifecycle?.kind === 'response');
  assert.deepEqual(duplicates, []);
  assert.equal(response.lifecycle.status, 'completed');
  assert.ok(response.lifecycle.inputMessageIds.includes(f.source.id));
  const [ref] = (await f.messages.getById(f.source.id)).lifecycle.dispatchRefs;
  assert.deepEqual([ref.targetId, ref.phase, ref.statusMessageId], ['gemini', 'settled', response.id]);
}

test('same-compatible registered session changes across both captures, then delivers the original claim once', async (t) => {
  const f = await setup(t);
  const registry = new SessionImplementationRegistry();
  const ref = { builtin: 'review1871-generation' };
  const launches = [];
  let captures = 0;
  const host = {
    captureInvocationOptions() {
      if (++captures <= 2) {
        unregister();
        unregister = registry.register(ref, () => provider, 'same-package-config');
      }
      return {};
    },
  };
  const provider = { hostService: () => host, bindHostService: () => provider };
  let unregister = registry.register(ref, () => provider, 'same-package-config');
  t.after(() => unregister());
  const registered = new RegisteredSessionAgentService({ catId: 'gemini', ref, registry });
  // Keep the real pinned capture/snapshot path. Stub only the downstream provider stream.
  f.agents.get('gemini').forInvocation = () => ({
    ...registered.forInvocation(),
    invoke: reply('gemini', launches),
    invokeWithContinuityPreflight: undefined,
  });
  f.router.refreshFromRegistry(f.agents);
  await f.processor.requestDrain(f.threadId);
  await waitFor(
    async () =>
      !f.tracker.has(f.threadId, 'gemini') && (await f.queue.listAllDurable(f.threadId))[0]?.status !== 'claimed',
  );
  assert.equal(captures, 2);
  assert.deepEqual(launches, []);
  const rows = await f.queue.listAllDurable(f.threadId);
  assert.deepEqual(
    rows.map((row) => [row.id, row.status]),
    [[f.entry.id, 'queued']],
  );
  await assertOriginalDeliveredOnce(f, launches);
  assert.equal(captures, 3);
});

test('configured target absent without a registry diagnostic retains the original claim until recovery', async (t) => {
  const f = await setup(t);
  const registry = new AgentRegistry();
  registry.register('codex', f.agents.get('codex'));
  f.router.refreshFromRegistry(registry);
  await f.processor.requestDrain(f.threadId);
  assert.deepEqual(
    (await f.queue.listAllDurable(f.threadId)).map((row) => [row.id, row.status]),
    [[f.entry.id, 'queued']],
  );
  const launches = [];
  registry.register('gemini', { invoke: reply('gemini', launches) });
  f.router.refreshFromRegistry(registry);
  await assertOriginalDeliveredOnce(f, launches);
});

test('an incompatible execution client settles once and its caller wake survives a silent registry gap', async (t) => {
  const f = await setup(t);
  const launches = [];
  const target = f.agents.get('gemini');
  target.implementationSnapshot = () => ({ key: 'fixture:wrong-client', generation: 'fixture', clientId: 'kimi' });
  target.invoke = reply('gemini', launches);
  const caller = f.agents.get('codex');
  caller.invoke = reply('codex', launches);
  f.router.refreshFromRegistry(f.agents);
  await f.processor.requestDrain(f.threadId);
  await waitFor(
    async () => !f.tracker.has(f.threadId, 'gemini') && !(await f.queue.getDurableEntry(f.threadId, f.entry.id)),
  );
  assert.deepEqual(launches, []);
  const history = await f.messages.getByThread(f.threadId);
  const failures = history.filter((row) => row.lifecycle?.kind === 'delivery_failure');
  assert.equal(failures.length, 1);
  const [failure] = failures;
  assert.equal(failure.lifecycle.reason, 'execution_binding_conflict');
  const [ref] = (await f.messages.getById(f.source.id)).lifecycle.dispatchRefs;
  assert.deepEqual([ref.targetId, ref.phase, ref.statusMessageId], ['gemini', 'settled', failure.id]);
  const [wake] = await f.queue.listAllDurable(f.threadId);
  assert.equal(wake.sourceCategory, 'a2a_failure');
  assert.deepEqual(wake.targets, ['codex']);
  assert.equal(wake.payload.sourceRecordId, failure.id);

  const registry = new AgentRegistry();
  registry.register('gemini', target);
  f.router.refreshFromRegistry(registry);
  f.tracker.complete(f.threadId, 'codex');
  await f.processor.requestDrain(f.threadId);
  assert.deepEqual(
    (await f.queue.listAllDurable(f.threadId)).map((row) => [row.id, row.status]),
    [[wake.id, 'queued']],
  );
  registry.register('codex', caller);
  f.router.refreshFromRegistry(registry);
  await f.processor.processNext(f.threadId, 'owner');
  await waitFor(async () => !f.tracker.has(f.threadId, 'codex') && !(await f.queue.listAllDurable(f.threadId)).length);
  await f.processor.requestDrain(f.threadId);
  assert.deepEqual(launches, ['codex']);
  assert.deepEqual(
    (await f.messages.getByThread(f.threadId))
      .filter((row) => row.lifecycle?.kind === 'delivery_failure')
      .map((row) => row.id),
    [failure.id],
  );
});
