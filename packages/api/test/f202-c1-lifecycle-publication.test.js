import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { projectEnvelope } from '../dist/domains/messaging/envelope.js';
import { createPublishingMessageStore } from '../dist/domains/messaging/publishing-message-store.js';
import { createMessagingStores } from '../dist/domains/messaging/stores/factory.js';

const lifecycle = {
  kind: 'response',
  orderKey: '0000000000100:response',
  invocationId: 'inv-1',
  targetId: 'opus',
  inputEntryIds: ['entry-1'],
  inputMessageIds: ['input-1'],
  status: 'processing',
  startedAt: 100,
};
const input = (overrides = {}) => ({
  from: { kind: 'agent', catId: 'opus' },
  userId: 'owner-1',
  threadId: 'thread-1',
  content: '',
  mentions: [],
  timestamp: 100,
  lifecycle,
  ...overrides,
});
const patch = (status = 'completed') => ({
  invocationId: 'inv-1',
  status,
  completedAt: 200,
  content: status === 'failed' ? 'Request failed' : 'Hello from CLI',
  mentions: [],
  origin: 'stream',
});
function fixture() {
  const events = createMessagingStores().events;
  const failures = [];
  const store = createPublishingMessageStore(new MessageStore(), {
    events,
    onPublishFailure: (error) => failures.push(error),
  });
  return { store, failures, read: () => events.readAfter('thread-1', 0, 50) };
}

for (const status of ['completed', 'failed', 'canceled', 'interrupted']) {
  test(`CLI ${status} publishes its terminal body once, never the processing placeholder`, async () => {
    const { store, read, failures } = fixture();
    const processing = await store.append(input());
    assert.deepEqual(await read(), []);
    assert.equal(projectEnvelope(processing), null, 'snapshot also excludes unfinished responses');
    const result = await store.commitLifecycleResponseTerminal(processing.id, patch(status));
    assert.equal(result.kind, 'applied');
    const published = await read();
    assert.equal(published.length, 1);
    assert.equal(published[0].envelope.messageId, processing.id);
    assert.equal(published[0].envelope.payload.elements[0].payload.text, patch(status).content);
    assert.equal((await store.commitLifecycleResponseTerminal(processing.id, patch(status))).kind, 'replayed');
    assert.equal((await read()).length, 1);
    assert.deepEqual(failures, []);
  });
}

test('atomic response and Queue admission publishes only the committed terminal response', async () => {
  const { store, read } = fixture();
  const processing = await store.append(input());
  const queue = new InvocationQueue();
  const terminal = { ...patch(), content: '@codex review', mentions: ['codex'] };
  const admission = {
    threadId: 'thread-1',
    userId: 'owner-1',
    kind: 'message_wake',
    from: { kind: 'agent', catId: 'opus' },
    ownerAuthProvenance: 'strict',
    content: terminal.content,
    intent: 'execute',
    targetCats: ['codex'],
    messageId: processing.id,
    sourceId: processing.id,
    sourceCategory: 'a2a',
    a2aTriggerMessageId: processing.id,
    autoExecute: true,
    priority: 'normal',
  };
  assert.deepEqual(await read(), []);
  const result = await queue.terminalizeResponseAndEnqueueDurable(store, processing.id, terminal, admission);
  assert.equal(result.outcome, 'enqueued');
  assert.equal((await read())[0].envelope.payload.elements[0].payload.text, terminal.content);
  await queue.terminalizeResponseAndEnqueueDurable(store, processing.id, terminal, admission);
  assert.equal((await read()).length, 1);
});

test('conflicted terminals and completed whispers never reach subscribers', async () => {
  const { store, read } = fixture();
  const processing = await store.append(input({ visibility: 'whisper', whisperTo: ['codex'] }));
  const conflict = await store.commitLifecycleResponseTerminal(processing.id, { ...patch(), invocationId: 'other' });
  assert.equal(conflict.kind, 'conflict');
  assert.deepEqual(await read(), []);
  assert.equal((await store.commitLifecycleResponseTerminal(processing.id, patch())).kind, 'applied');
  assert.deepEqual(await read(), []);
});

test('terminal replay repairs failed publication without changing the committed response', async () => {
  const events = createMessagingStores().events;
  const failures = [];
  let unavailable = true;
  let publishing = false;
  const store = createPublishingMessageStore(new MessageStore(), {
    events: {
      async append(...args) {
        assert.equal(publishing, true, 'snapshot exclusion covers terminal publication');
        if (unavailable) throw new Error('event store unavailable');
        return events.append(...args);
      },
    },
    publications: {
      begin() {
        publishing = true;
        return () => {
          publishing = false;
        };
      },
    },
    onPublishFailure: (error) => failures.push(error),
  });
  const processing = await store.append(input());
  assert.equal((await store.commitLifecycleResponseTerminal(processing.id, patch())).kind, 'applied');
  assert.equal((await store.getById(processing.id)).content, patch().content);
  assert.equal(failures.length, 1);
  assert.equal(publishing, false);
  unavailable = false;
  assert.equal((await store.commitLifecycleResponseTerminal(processing.id, patch())).kind, 'replayed');
  assert.equal((await events.readAfter('thread-1', 0, 50)).length, 1);
  assert.equal(publishing, false);
});

test('terminal attachments use the existing deferred media job after the final body is stored', async () => {
  const events = createMessagingStores().events;
  const registered = [];
  const scheduled = [];
  const store = createPublishingMessageStore(new MessageStore(), {
    events,
    outboundMedia: () => ({
      register: async (message) => registered.push(message),
      schedule: (id) => scheduled.push(id),
    }),
    onPublishFailure: (error) => {
      throw error;
    },
  });
  const processing = await store.append(input());
  assert.equal(registered.length, 0);
  const result = await store.commitLifecycleResponseTerminal(processing.id, {
    ...patch(),
    extra: {
      rich: {
        v: 1,
        blocks: [{ id: 'file-1', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: 'report.pdf' }],
      },
    },
  });
  assert.equal(result.kind, 'applied');
  assert.equal((await store.getById(processing.id)).extra.mediaPublication, 'deferred');
  assert.equal(registered[0].content, patch().content);
  assert.equal(registered[0].lifecycle.status, 'completed');
  assert.deepEqual(scheduled, [processing.id]);
  assert.deepEqual(await events.readAfter('thread-1', 0, 50), []);
});
