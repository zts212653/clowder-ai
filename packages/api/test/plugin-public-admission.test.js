import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { queueEntryId } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { withPluginTransportPurpose } from '../dist/domains/plugin/carrier/plugin-transport-context.js';
import { neutralFixture } from './helpers/neutral-host-fixture.js';

async function fixture(t, capabilities = ['thread.readContent', 'messaging.send'], realVerifier = false) {
  const queue = new InvocationQueue();
  const resumed = [];
  const f = await neutralFixture(t, {
    capabilities,
    publicVerifier: realVerifier,
    publicInvocations: { queue, resume: async (...scope) => resumed.push(scope) },
  });
  assert.equal(typeof f.host().publicInvocations?.enqueue, 'function', 'missing neutral public admission entry');
  await f.threads.addParticipants(f.thread.id, ['cat']);
  const message = f.messages.append({
    threadId: f.thread.id,
    userId: f.owner,
    from: { kind: 'plugin', instanceId: f.installed.pluginInstanceId },
    content: 'external source',
    mentions: [],
    timestamp: 1000,
    extra: {
      pluginMessage: {
        instanceId: f.installed.pluginInstanceId,
        revision: 1,
        presentation: { connector: 'neutral', label: 'Neutral', icon: 'message', meta: { eventId: 'event-1' } },
        provenance: { origin: { kind: 'plugin', instanceId: f.installed.pluginInstanceId } },
        elements: [],
        appendOps: [],
      },
    },
  });
  const input = {
    messageRef: `message:${message.id}`,
    targetCatId: 'cat',
    native: { contributionId: 'native', methods: ['neutral.call'] },
    authority: { ref: 'package-event:event-1', revision: 'route:1' },
  };
  const verified = [];
  // Runtime verifier transport has its own tests. This probe proves admission calls
  // that existing private port with the exact Host-derived carrier before effects.
  if (!realVerifier)
    f.runtime.supervisor.invokePublicInvocationVerifier = async (instance, carrier, context) => {
      await context.assertCurrent();
      verified.push({ instance, carrier });
      return { current: true };
    };
  return {
    ...f,
    queue,
    resumed,
    message,
    input,
    verified,
    enqueue: (value) => f.host().publicInvocations.enqueue(value ?? input),
  };
}

test('admission fixture control: existing module exposes messaging and source ports', async (t) => {
  const f = await neutralFixture(t, { capabilities: ['thread.readContent', 'messaging.send'] });
  assert.equal(typeof f.host().messaging.send, 'function');
  assert.equal(typeof f.host().sourceFacts.read, 'function');
});

test('public admission binds the persisted source to neutral single-target custody', async (t) => {
  const f = await fixture(t);
  const receipt = await f.enqueue();
  const source = f.messages.getById(f.message.id);
  assert.equal(receipt.messageRef, f.input.messageRef);
  const row = await f.queue.getDurableEntry(f.thread.id, receipt.entryId);
  assert.equal(receipt.entryId, queueEntryId(source.id));
  assert.equal(receipt.status, 'queued');
  assert.equal(row.execution.ownerAuthProvenance, 'unknown');
  assert.deepEqual(row.targets, ['cat']);
  assert.equal(row.execution.pluginPublicInvocation.sourceMessageId, source.id);
  assert.equal(row.execution.pluginPublicInvocation.pluginInstanceId, f.installed.pluginInstanceId);
  assert.equal(f.verified.length, 1);
  assert.equal(f.queue.list(f.thread.id, f.owner).length, 1);
  assert.deepEqual(f.resumed, [[f.thread.id, f.owner]]);
});

test('public admission replay returns existing custody and never rebinds a child', async (t) => {
  const f = await fixture(t);
  const first = await f.enqueue();
  const again = await f.enqueue();
  assert.equal(again.entryId, first.entryId);
  await bindChild(f, first.entryId, 'child-1');
  const resumeCount = f.resumed.length;
  const last = await f.enqueue();
  assert.equal(last.entryId, first.entryId);
  assert.equal(last.status, 'processing');
  assert.equal(f.resumed.length, resumeCount);
  assert.equal(f.messages.getById(f.message.id).lifecycle.dispatchRefs.length, 1);
});

test('public admission rejects widened methods, target and caller-owned Host coordinates before writes', async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.messages.getById(f.message.id));
  for (const patch of [
    { targetCatId: 'foreign' },
    { pluginInstanceId: 'foreign' },
    { threadId: 'foreign' },
    { native: { contributionId: 'native', methods: ['owner.write'] } },
    { native: { contributionId: 'native', methods: ['neutral.call', 'neutral.call'] } },
    { authority: { ref: '', revision: 'route:1' } },
  ])
    await assert.rejects(() => f.enqueue({ ...f.input, ...patch }));
  assert.deepEqual(f.messages.getById(f.message.id), before);
  assert.equal(f.queue.list(f.thread.id, f.owner).length, 0);
});

test('public admission honors package verifier refusal without preparing Queue custody', async (t) => {
  const f = await fixture(t);
  f.runtime.supervisor.invokePublicInvocationVerifier = async () => {
    throw Error('business source expired');
  };
  await assert.rejects(() => f.enqueue(), /business source expired/);
  assert.equal(f.messages.getById(f.message.id).queueCustody, undefined);
  assert.equal(f.messages.getById(f.message.id).deliveryStatus, undefined);
  assert.equal(f.resumed.length, 0);
});

test('public admission refuses source changes during verification', async (t) => {
  const f = await fixture(t);
  f.runtime.supervisor.invokePublicInvocationVerifier = async () => {
    f.messages.softDelete(f.message.id, f.owner);
    return { current: true };
  };
  await assert.rejects(() => f.enqueue());
  assert.equal(f.messages.getById(f.message.id).queueCustody, undefined);
  assert.equal(f.resumed.length, 0);
});

test('public admission requires send grant and cannot run inside isolated verification', async (t) => {
  const denied = await fixture(t, ['thread.readContent']);
  await assert.rejects(() => denied.enqueue());
  assert.equal(denied.verified.length, 0);
  const f = await fixture(t);
  await assert.rejects(() => withPluginTransportPurpose('verifier', () => f.enqueue()));
  assert.equal(f.verified.length, 0);
  assert.equal(f.messages.getById(f.message.id).queueCustody, undefined);
});

test('public admission concurrent retries share the durable custody winner', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.enqueue(), f.enqueue(), f.enqueue()]);
  assert.equal(new Set(results.map((result) => result.entryId)).size, 1);
  assert.equal(f.queue.list(f.thread.id, f.owner).length, 1);
  assert.equal((await f.queue.getDurableEntry(f.thread.id, results[0].entryId)).targets.length, 1);
  const before = structuredClone(f.messages.getById(f.message.id));
  await assert.rejects(() => f.enqueue({ ...f.input, authority: { ref: 'other', revision: 'route:1' } }));
  assert.deepEqual(f.messages.getById(f.message.id), before);
});

test('public admission uses the real isolated module verifier before Queue admission', async (t) => {
  const f = await fixture(t, ['thread.readContent', 'messaging.send'], true);
  const receipt = await f.enqueue();
  assert.equal(receipt.status, 'queued');
  assert.equal(f.queue.list(f.thread.id, f.owner).length, 1);
});

async function bindChild(f, entryId, child) {
  const response = f.messages.append({
    userId: f.owner,
    threadId: f.thread.id,
    from: { kind: 'agent', catId: 'cat' },
    content: '',
    mentions: [],
    timestamp: 2000,
    lifecycle: {
      kind: 'response',
      orderKey: '2000:child',
      invocationId: child,
      targetId: 'cat',
      inputEntryIds: [entryId],
      inputMessageIds: [f.message.id],
      status: 'processing',
      startedAt: 2000,
    },
  });
  const source = f.messages.getById(f.message.id);
  assert.equal(
    f.messages.advanceLifecycleInputDispatch(source.id, {
      orderKey: source.lifecycle.orderKey,
      targetId: 'cat',
      phase: 'dispatched',
      statusMessageId: response.id,
      dispatchedAt: 2000,
    }).kind,
    'applied',
  );
  await f.queue.retireClaimedLifecycleTarget(f.thread.id, entryId, 'cat');
  return response;
}
test('terminal History replay returns a receipt without recreating retired Queue work', async (t) => {
  const f = await fixture(t);
  const first = await f.enqueue();
  const response = await bindChild(f, first.entryId, 'finished-child');
  assert.equal(
    f.messages.commitLifecycleResponseTerminal(response.id, {
      invocationId: 'finished-child',
      status: 'completed',
      completedAt: 3000,
      content: '',
      mentions: [],
    }).kind,
    'applied',
  );
  const source = f.messages.getById(f.message.id);
  assert.equal(
    f.messages.advanceLifecycleInputDispatch(source.id, {
      orderKey: source.lifecycle.orderKey,
      targetId: 'cat',
      phase: 'settled',
      statusMessageId: response.id,
      dispatchedAt: 2000,
    }).kind,
    'applied',
  );
  const snapshot = structuredClone(source),
    resumes = f.resumed.length;
  assert.deepEqual(await f.enqueue(), { ...first, status: 'terminal' });
  assert.equal(f.resumed.length, resumes);
  assert.equal(f.queue.list(f.thread.id, f.owner).length, 0);
  assert.deepEqual(f.messages.getById(source.id), snapshot);
});
