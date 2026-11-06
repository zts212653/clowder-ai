import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendRecoveryFixture } from './helpers/append-recovery-fixture.js';
import { waitFor } from './helpers/stop-private-fixture.js';

function send(f, content, disposition = 'continue_current', from = { kind: 'agent', catId: 'codex' }) {
  return f.queue.send(
    f.messageStore,
    {
      from,
      userId: 'owner',
      threadId: 'thread',
      content,
      mentions: ['opus'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    },
    {
      from,
      userId: 'owner',
      threadId: 'thread',
      content,
      targetCats: ['opus'],
      kind: from.kind === 'agent' ? 'message_wake' : 'conversation_input',
      ownerAuthProvenance: 'strict',
      intent: 'execute',
      autoExecute: true,
      messageDisposition: disposition,
    },
  );
}

async function futureWork(f, kind, id = 'older-work') {
  if (kind === 'conversation_input') return send(f, id, 'next_work', { kind: 'user', userId: 'owner' });
  return f.queue.enqueueDurable({
    kind: 'private_input',
    threadId: 'thread',
    userId: 'owner',
    sourceId: id,
    from: { kind: 'system', service: 'test-future-work' },
    ownerAuthProvenance: 'strict',
    content: id,
    targetCats: ['opus'],
    intent: 'execute',
    autoExecute: true,
  });
}

async function fixture(t, options = {}) {
  const calls = [];
  const f = await appendRecoveryFixture(
    options.dispatch ??
      (async (input) => {
        calls.push(input.messageIds);
        return { accepted: true, handle: {} };
      }),
    { from: { kind: 'agent', catId: 'codex' }, messageDisposition: 'continue_current', ...options },
  );
  t.after(() => f.invocationTracker.cancelAll('thread', 'owner', 'test_cleanup'));
  return { ...f, calls };
}

// The screenshot's public A2A is already bound to a live turn. An older future
// input must keep its own place without holding that turn's guidance hostage.
for (const kind of ['private_input', 'conversation_input']) {
  for (const from of [
    { kind: 'agent', catId: 'codex' },
    { kind: 'user', userId: 'owner' },
  ]) {
    test(`${kind} waiting for a new turn does not block current ${from.kind} guidance`, async (t) => {
      let older;
      const f = await fixture(t, {
        from,
        beforeAdmission: async (state) => {
          older = await futureWork(state, kind);
        },
      });
      const original = await f.queue.getDurableEntry('thread', older.entry.id);
      await f.processor.requestDrain('thread');
      assert.deepEqual(f.calls, [[f.admission.message.id]], 'guide must reach the existing provider turn');
      await waitFor(async () => !(await f.queue.getDurableEntry('thread', f.admission.entry.id)));
      assert.deepEqual(await f.queue.getDurableEntry('thread', older.entry.id), original, 'future work stays intact');
      const response = await f.messageStore.getById(f.response.id);
      const source = await f.messageStore.getById(f.admission.message.id);
      assert.deepEqual(response.lifecycle.inputMessageIds, [source.id]);
      assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, response.id);
      assert.equal(source.lifecycle.dispatchRefs[0].appendAcceptance, 'accepted');
      assert.equal(f.invocationTracker.getExecutionId('thread', 'opus'), 'parent');
      await f.processor.requestDrain('thread');
      assert.equal(f.calls.length, 1, 'another drain cannot append the source twice');
    });
  }
}

test('a next-work message still waits behind earlier work and never enters the active turn', async (t) => {
  let older;
  const f = await fixture(t, {
    messageDisposition: 'next_work',
    beforeAdmission: async (state) => {
      older = await futureWork(state, 'private_input');
    },
  });
  await f.processor.requestDrain('thread');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(
    f.queue.list('thread', 'owner').map((entry) => entry.id),
    [older.entry.id, f.admission.entry.id],
  );
});

test('guidance cannot cross an explicit Stop suppression fence', async (t) => {
  const f = await fixture(t, { beforeAdmission: (state) => futureWork(state, 'private_input') });
  f.processor.suppressAutoResume('thread', 'opus');
  await f.processor.requestDrain('thread');
  assert.deepEqual(f.calls, []);
  assert.ok(await f.queue.getDurableEntry('thread', f.admission.entry.id));
});

test('guidance bound to a finished parent cannot enter a replacement execution', async (t) => {
  const f = await fixture(t, { beforeAdmission: (state) => futureWork(state, 'private_input') });
  f.invocationTracker.complete('thread', 'opus');
  f.invocationTracker.start('thread', 'opus', 'owner', ['opus'], 'replacement-parent');
  await f.processor.requestDrain('thread');
  assert.deepEqual(f.calls, []);
  const pending = await f.queue.getDurableEntry('thread', f.admission.entry.id);
  assert.equal(pending.delivery.authorIntentByTarget.opus.boundParentInvocationId, 'parent');
  assert.equal(f.invocationTracker.getExecutionId('thread', 'opus'), 'replacement-parent');
});

test('a delayed current-guidance ACK holds later guidance, but neither consumes future work', async (t) => {
  let releaseAck;
  const gate = new Promise((resolve) => {
    releaseAck = resolve;
  });
  t.after(() => releaseAck());
  const calls = [];
  let older;
  const f = await fixture(t, {
    beforeAdmission: async (state) => {
      older = await futureWork(state, 'private_input');
    },
    dispatch: async (input) => {
      calls.push(input.messageIds);
      if (calls.length === 1) await gate;
      return { accepted: true, handle: {} };
    },
  });
  const later = await send(f, 'second guide');
  await f.processor.requestDrain('thread');
  assert.deepEqual(calls, [[f.admission.message.id]]);
  await f.processor.requestDrain('thread');
  assert.equal(calls.length, 1, 'later guidance cannot overtake an unacknowledged append');
  releaseAck();
  await waitFor(async () => !(await f.queue.getDurableEntry('thread', later.entry.id)));
  assert.deepEqual(calls, [[f.admission.message.id], [later.message.id]]);
  assert.ok(await f.queue.getDurableEntry('thread', older.entry.id));
});

test('an earlier current guide waiting for Native full read retains its place before later guidance', async (t) => {
  const f = await fixture(t, {
    inputCompletionReceipt: true,
    beforeAdmission: (state) => futureWork(state, 'private_input'),
  });
  await f.messageStore.markDelivered(f.admission.message.id, Date.now());
  const later = await send(f, 'later user guide', 'continue_current', { kind: 'user', userId: 'owner' });
  await f.processor.requestDrain('thread');
  assert.deepEqual(f.calls, [], 'a later Native input cannot bypass the earlier current-turn full-read handoff');
  for (const entry of [f.admission.entry, later.entry]) {
    const pending = await f.queue.getDurableEntry('thread', entry.id);
    assert.equal(pending.delivery.authorIntentByTarget.opus.fallbackAt, undefined);
    assert.equal(pending.delivery.appendPendingByTarget, undefined);
  }
});

test('a short claim retains its recipient until restored, then future work no longer blocks guidance', async (t) => {
  let older;
  const f = await fixture(t, {
    beforeAdmission: async (state) => {
      older = await futureWork(state, 'private_input');
    },
  });
  assert.ok(await f.queue.markProcessingByIdDurable('thread', older.entry.id, 'opus'));
  await f.processor.requestDrain('thread');
  assert.deepEqual(f.calls, []);
  assert.ok(await f.queue.getDurableEntry('thread', f.admission.entry.id));
  assert.equal(await f.queue.restoreClaimedEntries('thread', [older.entry.id]), true);
  await f.processor.requestDrain('thread');
  assert.deepEqual(f.calls, [[f.admission.message.id]]);
  await waitFor(async () => !(await f.queue.getDurableEntry('thread', f.admission.entry.id)));
});

test('after current guidance, future work starts once in its original order when the parent finishes', async (t) => {
  const starts = [];
  const f = await fixture(t, {
    beforeAdmission: async (state) => {
      await futureWork(state, 'private_input', 'future one');
      await futureWork(state, 'conversation_input', 'future two');
    },
    routeExecution: async function* (userId, content, threadId, _messageId, targets, _intent, options) {
      starts.push(content);
      for (const catId of targets) {
        await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId,
          invocationId: `future-${starts.length}`,
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        });
        yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
      }
    },
  });
  await f.processor.requestDrain('thread');
  assert.deepEqual(f.calls, [[f.admission.message.id]]);
  await waitFor(async () => !(await f.queue.getDurableEntry('thread', f.admission.entry.id)));
  assert.deepEqual(starts, [], 'guidance must not create a new invocation');
  f.invocationTracker.complete('thread', 'opus');
  await f.processor.requestDrain('thread');
  await waitFor(() => starts.length === 2 && f.queue.list('thread', 'owner').length === 0);
  assert.deepEqual(starts, ['future one', 'future two']);
  await f.processor.requestDrain('thread');
  assert.deepEqual(starts, ['future one', 'future two']);
});
