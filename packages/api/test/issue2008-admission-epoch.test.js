import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

async function epochFixture(t, baseDelayMs = 20) {
  const h = await stopFixture(t, {
    idle: true,
    retryDeferral: { baseDelayMs },
    routes: {
      threadStore: {
        get: async (id) => ({ id, createdBy: 'owner', participants: ['opus', 'codex', 'gemini', 'sonnet'] }),
      },
    },
  });
  h.completed = [];
  const complete = h.processor.onInvocationComplete.bind(h.processor);
  h.processor.onInvocationComplete = async (...args) => {
    await complete(...args);
    if (args[2] === 'succeeded') h.completed.push(args[1]);
  };
  t.after(() => {
    for (const entry of h.queue.listPendingAcrossUsers('thread')) h.processor.retryDeferrals.forget(entry.id);
  });
  return h;
}

async function orderedSend(h, content, targets) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return h.send(content, targets);
}

function failReceiverOnce(h, source, beforeFailure = () => {}) {
  const inspect = h.processor.firstTargetWithExistingReceiver.bind(h.processor);
  let inspecting = false;
  h.processor.firstTargetWithExistingReceiver = async (...args) => {
    inspecting = args[0].some((entry) => entry.id === source.entry.id);
    try {
      return await inspect(...args);
    } finally {
      inspecting = false;
    }
  };
  const read = h.messages.getById.bind(h.messages);
  const failure = new Error('receiver read aborted this scan');
  let failed = false;
  h.messages.getById = (id) => {
    if (!failed && inspecting && id === source.message.id) {
      failed = true;
      beforeFailure();
      throw failure;
    }
    return read(id);
  };
  return failure;
}

for (const middleCount of [1, 2]) {
  for (const newerFence of [false, true]) {
    test(`#2008 exact epoch survives ${middleCount} intermediate starts, newer fence=${newerFence}`, async (t) => {
      const h = await epochFixture(t, 5000);
      const blocked = await h.send('failed multi-target', ['opus', 'codex']);
      for (let index = 0; index < middleCount; index++) await orderedSend(h, `middle ${index}`, ['gemini']);
      await orderedSend(h, 'completion target', ['sonnet']);
      h.processor.suppressAutoResume('thread', 'sonnet', ['old-sonnet']);
      const failure = failReceiverOnce(h, blocked, () => {
        // Arm before the first handoff can wake a scan of B, rather than after C's provider finishes.
        if (newerFence) h.processor.suppressAutoResume('thread', 'sonnet', ['new-stop']);
      });
      await assert.rejects(
        h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-sonnet', []),
        (error) => error === failure,
      );
      await waitFor(() => h.completed.filter((cat) => cat === 'gemini').length === middleCount);
      assert.equal(h.starts.includes('failed multi-target'), false);
      assert.equal(h.starts.includes('completion target'), !newerFence);
      assert.equal(h.processor.isAutoResumeSuppressed('thread', 'sonnet'), true, 'the original tombstone remains');
    });
  }
}

test("#2008 ordinary successful work cannot consume another target's completion epoch", async (t) => {
  const h = await epochFixture(t);
  await h.send('middle', ['gemini']);
  await orderedSend(h, 'completion target', ['sonnet']);
  h.processor.suppressAutoResume('thread', 'sonnet', ['old-sonnet']);
  await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-sonnet', []);
  await waitFor(() => h.completed.includes('gemini'));
  assert.ok(h.starts.includes('completion target'));
});

test('#2008 targetless retry preserves both its barrier and the later completion epoch', async (t) => {
  const h = await epochFixture(t);
  h.processor.deps.router.resolveConversationTargetsAtAdmission = async () => ['opus'];
  const first = await h.send('unknown recipient', []);
  await orderedSend(h, 'completion target', ['sonnet']);
  h.processor.suppressAutoResume('thread', 'sonnet', ['old-sonnet']);
  const read = h.messages.getByIdempotencyKey.bind(h.messages);
  const failure = new Error('targetless history unavailable');
  let failed = false;
  h.messages.getByIdempotencyKey = (...args) => {
    if (!failed && args[2].includes(first.entry.id)) {
      failed = true;
      throw failure;
    }
    return read(...args);
  };
  await assert.rejects(
    h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-sonnet', []),
    (error) => error === failure,
  );
  assert.deepEqual(h.starts, [], 'an unknown head still holds every later source');
  await waitFor(() => h.completed.includes('opus'));
  assert.deepEqual(h.starts, ['unknown recipient', 'completion target']);
});

test("#2008 a source's own claim retry keeps its completion epoch without replaying completion", async (t) => {
  const h = await epochFixture(t);
  const source = await h.send('completion target', ['sonnet']);
  h.processor.suppressAutoResume('thread', 'sonnet', ['old-sonnet']);
  const claim = h.ledger.claimPrefix.bind(h.ledger);
  const failure = new Error('claim failed before writing');
  let attempts = 0;
  h.ledger.claimPrefix = async (...args) => {
    if (args[1].includes(source.entry.id) && ++attempts === 1) throw failure;
    return claim(...args);
  };
  const drain = h.processor.requestDrain.bind(h.processor);
  let completedDrains = 0;
  h.processor.requestDrain = (...args) => drain(...args).finally(() => completedDrains++);
  await assert.rejects(
    h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-sonnet', []),
    (error) => error === failure,
  );
  await waitFor(() => completedDrains >= 3 && !h.processor.isThreadBusy('thread'));
  assert.ok(attempts >= 2, 'the real retry timer reaches the claim again');
  assert.deepEqual(h.starts, ['completion target']);
});

test('#2008 a late original canceled terminal still consumes its tombstone without draining', async (t) => {
  const h = await epochFixture(t);
  await h.send('first', ['sonnet']);
  h.processor.suppressAutoResume('thread', 'sonnet', ['old-sonnet']);
  await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-sonnet', []);
  await waitFor(() => h.completed.includes('sonnet'));
  assert.equal(h.processor.isAutoResumeSuppressed('thread', 'sonnet'), true);
  await h.send('later', ['sonnet']);
  await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'old-sonnet', []);
  assert.equal(h.processor.isAutoResumeSuppressed('thread', 'sonnet'), false);
  assert.deepEqual(h.starts, ['first'], 'the old canceled terminal cannot start newly queued work');
});
