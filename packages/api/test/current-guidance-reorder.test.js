import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendRecoveryFixture } from './helpers/append-recovery-fixture.js';
import { waitFor } from './helpers/stop-private-fixture.js';

function send(state, content, disposition = 'continue_current', from = { kind: 'agent', catId: 'codex' }) {
  return state.queue.send(
    state.messageStore,
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

async function fixture(t, publicFuture = false) {
  const calls = [];
  let future;
  const f = await appendRecoveryFixture(
    async (input) => {
      calls.push(input.messageIds);
      return { accepted: true, handle: {} };
    },
    {
      from: { kind: 'agent', catId: 'codex' },
      messageDisposition: 'continue_current',
      beforeAdmission: async (state) => {
        future = publicFuture
          ? await send(state, 'future work', 'next_work', { kind: 'user', userId: 'owner' })
          : await state.queue.enqueueDurable({
              kind: 'private_input',
              threadId: 'thread',
              userId: 'owner',
              sourceId: 'older-private',
              from: { kind: 'system', service: 'test-future-work' },
              ownerAuthProvenance: 'strict',
              content: 'future work',
              targetCats: ['opus'],
              intent: 'execute',
              autoExecute: true,
            });
      },
    },
  );
  t.after(() => f.invocationTracker.cancelAll('thread', 'owner', 'test_cleanup'));
  return { ...f, calls, future };
}

// A real Queue mutation occurs while the production scan awaits routing, not
// by replacing its candidate list or asserting a particular implementation.
function duringFirstResolution(f, mutation) {
  // Both fixtures already have bound recipients. Their current production
  // path resolves these exact targets, including public conversation inputs.
  const original = f.processor.deps.router.resolveExplicitTargets;
  let changed = false;
  let completedMutations = 0;
  f.processor.deps.router.resolveExplicitTargets = async (...args) => {
    if (!changed) {
      changed = true;
      assert.equal(f.calls.length, 0, 'the mutation must precede the first guidance exposure');
      await mutation();
      completedMutations++;
    }
    return original(...args);
  };
  return () => assert.equal(completedMutations, 1, 'the production resolution must execute the mutation exactly once');
}

test('automatic guidance respects a reorder committed while an earlier future input resolves', async (t) => {
  const f = await fixture(t);
  const later = await send(f, 'move this guide first');
  const assertMutation = duringFirstResolution(f, async () => {
    assert.equal(await f.queue.setPositionDurable('thread', 'owner', later.entry.id, 0), true);
  });
  await f.processor.requestDrain('thread');
  assertMutation();
  await waitFor(() => f.calls.length === 2);
  assert.deepEqual(f.calls, [[later.message.id], [f.admission.message.id]]);
  assert.ok(await f.queue.getDurableEntry('thread', f.future.entry.id));
});

test('a newly preceding claim blocks automatic guidance until its exact restoration', async (t) => {
  const f = await fixture(t);
  const later = await send(f, 'claimed first guide');
  const assertMutation = duringFirstResolution(f, async () => {
    assert.equal(await f.queue.setPositionDurable('thread', 'owner', later.entry.id, 0), true);
    assert.ok(await f.queue.markProcessingByIdDurable('thread', later.entry.id, 'opus'));
  });
  await f.processor.requestDrain('thread');
  assertMutation();
  assert.deepEqual(f.calls, [], 'a claim added during resolution must be observed before another input is exposed');
  assert.equal(await f.queue.restoreClaimedEntries('thread', [later.entry.id]), true);
  await f.processor.requestDrain('thread');
  await waitFor(() => f.calls.length === 2);
  assert.deepEqual(f.calls, [[later.message.id], [f.admission.message.id]]);
});

test('a passed future input newly bound to this turn keeps its place before later guidance', async (t) => {
  const f = await fixture(t, true);
  const assertMutation = duringFirstResolution(f, async () => {
    assert.ok(
      await f.queue.bindContinueCurrentIntentDurable('thread', 'owner', f.future.entry.id, 'opus', {
        requested: 'continue_current',
        boundParentInvocationId: 'parent',
      }),
    );
  });
  await f.processor.requestDrain('thread');
  assertMutation();
  await waitFor(() => f.calls.length === 2);
  assert.deepEqual(f.calls, [[f.future.message.id], [f.admission.message.id]]);
});

test('a stale append claim rescan preserves guidance intent rather than falling back to next-work', async (t) => {
  const f = await fixture(t);
  const later = await send(f, 'guide moved at claim');
  const claim = f.queue.claimExactAppend.bind(f.queue);
  let changed = false;
  f.queue.claimExactAppend = async (...args) => {
    if (!changed) {
      changed = true;
      assert.equal(await f.queue.setPositionDurable('thread', 'owner', later.entry.id, 0), true);
    }
    return claim(...args);
  };
  await f.processor.requestDrain('thread');
  const original = await f.queue.getDurableEntry('thread', f.admission.entry.id);
  assert.equal(
    original?.delivery.authorIntentByTarget.opus.fallbackAt,
    undefined,
    'a changed Queue is not an ended parent',
  );
  await waitFor(() => f.calls.length === 2);
  assert.deepEqual(f.calls, [[later.message.id], [f.admission.message.id]]);
  assert.ok(await f.queue.getDurableEntry('thread', f.future.entry.id));
});

test('a stable claim refusal cannot cause an unbounded automatic rescan', async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  f.queue.claimExactAppend = async () => {
    assert.equal(++attempts, 1, 'only a changed Queue justifies another automatic attempt');
    return null;
  };
  await f.processor.requestDrain('thread');
  assert.equal(attempts, 1);
  assert.deepEqual(f.calls, []);
  assert.ok(await f.queue.getDurableEntry('thread', f.admission.entry.id));
});

test('an uncertain input stays in History without replaying or blocking later guidance', async (t) => {
  const f = await fixture(t);
  const dispatcher = f.invocationTracker.getAgentClientActiveRunDispatcher('thread', 'opus');
  const dispatch = dispatcher.dispatch;
  let first = true;
  dispatcher.dispatch = async (...args) => {
    const accepted = await dispatch(...args);
    if (!first) return accepted;
    first = false;
    return { accepted: false, reason: 'provider_rejected' };
  };
  assert.equal((await f.append()).reason, 'provider_rejected');
  const uncertain = await f.queue.getDurableEntry('thread', f.admission.entry.id);
  assert.equal(uncertain, null);
  assert.equal(
    (await f.messageStore.getById(f.admission.message.id)).lifecycle.appendFailures[0].acceptance,
    'unknown',
  );
  const later = await send(f, 'new input to the same still-running turn');
  await f.processor.requestDrain('thread');
  await waitFor(async () => !(await f.queue.getDurableEntry('thread', later.entry.id)));
  assert.deepEqual(f.calls, [[f.admission.message.id], [later.message.id]]);
  assert.deepEqual(await f.queue.getDurableEntry('thread', f.admission.entry.id), uncertain);
});
