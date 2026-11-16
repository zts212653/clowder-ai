import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEligibleReplyParent } from '../dist/domains/cats/services/stores/visibility.js';
import { createPresentLoopTemplate } from '../dist/infrastructure/scheduler/templates/present-loop.js';
import { CAT, OWNER, schedulerReadFixture } from './helpers/scheduler-read-fixture.js';

const context = (f, message) =>
  f.app.inject({
    url: `/api/callbacks/thread-context?threadId=${f.thread.id}&messageId=${message.id}&before=0&after=0&responseMode=full`,
    headers: f.readHeaders,
  });

test('the real ordinary reminder is identical in exact/full and thread context without reply or execution authority', async (t) => {
  const f = await schedulerReadFixture(t),
    notice = await f.publish('reminder');
  assert.equal(notice.extra.scheduler.hiddenTrigger, true, 'the actual producer keeps its UI display marker');
  const tasksBefore = structuredClone(f.tasks.listByThread(f.thread.id));
  const queueBefore = structuredClone(f.queue.list(f.thread.id, OWNER));
  const headers = await f.auth(notice);
  const invocation = await f.registry.getRecord(headers['x-invocation-id']);
  assert.equal(invocation.ownerAuthProvenance, 'unknown');
  const window = await context(f, notice);
  assert.equal(window.statusCode, 200, window.body);
  const item = window.json().messages.find((m) => m.id === notice.id);
  assert.equal(item.content, notice.content);
  for (const mode of ['preview', 'full']) {
    const res = await f.read(notice, mode);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().message.content, notice.content);
    assert.deepEqual(res.json().message.from, item.from);
  }
  assert.equal(
    isEligibleReplyParent(notice, { threadId: notice.threadId, viewer: { type: 'cat', catId: CAT } }),
    false,
  );
  const res = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers,
    payload: { content: 'ordinary reply', mentions: [], replyTo: notice.id },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(f.messages.getById(res.json().messageId).replyTo, undefined);
  assert.equal((await f.registry.getRecord(headers['x-invocation-id'])).ownerAuthProvenance, 'unknown');
  assert.deepEqual(f.tasks.listByThread(f.thread.id), tasksBefore);
  assert.deepEqual(f.queue.list(f.thread.id, OWNER), queueBefore);
  assert.equal(f.stats.adoptions, 0);
  assert.equal(f.stats.reads, 0);
});

test('a hidden ordinary reminder must be published and actually dispatched before reads or search', async (t) => {
  const f = await schedulerReadFixture(t),
    notice = await f.publish('reminder', false);
  assert.equal(notice.deliveryStatus, 'queued');
  assert.equal((await f.read(notice)).statusCode, 404);
  assert.equal((await f.search(await f.auth(notice))).statusCode, 403);
  f.dispatch(notice);
  assert.equal((await f.read(notice)).statusCode, 200);
  assert.equal((await f.search(await f.auth(notice))).statusCode, 200);
  assert.equal(f.stats.adoptions, 0);
});

test('published content readability does not let a different current cat borrow reminder source authority', async (t) => {
  const f = await schedulerReadFixture(t),
    notice = await f.publish('reminder');
  assert.equal((await f.read(notice)).statusCode, 200);
  assert.equal((await f.search(await f.auth(notice, OWNER, 'codex61-sol'))).statusCode, 403);
  assert.equal(f.stats.reads, 0);
});

test('the real private present-loop envelope remains outside Message reads and search source admission', async (t) => {
  const f = await schedulerReadFixture(t),
    secret = 'synthetic private continuity must remain private';
  const service = {
    acceptsOwner: (owner) => owner === OWNER,
    beginScheduledRun: async () => ({
      created: true,
      run: { runId: 'synthetic-private-run' },
      proactiveContext: { ownedSeeds: [] },
    }),
    renderPersistedWakeTrigger: () => 'synthetic private wake notice',
    renderWakePrompt: () => secret,
    failWake: async () => assert.fail('the private Queue admission should succeed'),
  };
  const spec = createPresentLoopTemplate({ service }).createSpec('synthetic-private-loop', {
    trigger: { type: 'once', fireAt: Date.now() },
    params: { triggerUserId: OWNER, targetCatId: CAT },
    deliveryThreadId: f.thread.id,
  });
  const admitted = await spec.admission.gate();
  assert.equal(admitted.run, true);
  await spec.run.execute(null, admitted.workItems[0].subjectKey, { deliver: f.deliver, assignedCatId: CAT });
  const entry = f.queue.list(f.thread.id, OWNER).at(-1);
  assert.equal(entry.kind, 'private_input');
  assert.ok(entry.payload.content.includes(secret));
  assert.equal(entry.payload.messageId, undefined);
  assert.equal(f.messages.getById(entry.id), null);
  const notice = f.messages.getByThread(f.thread.id).find((m) => m.extra?.scheduler?.hiddenTrigger);
  assert.ok(notice);
  assert.equal((await f.read(notice)).statusCode, 404);
  assert.equal((await f.search(await f.auth(notice))).statusCode, 403);
  assert.equal((await f.read({ id: entry.id })).statusCode, 404);
  assert.equal((await f.search(await f.auth({ id: entry.id, threadId: f.thread.id }))).statusCode, 403);
  const window = await context(f, notice);
  assert.equal(window.statusCode, 200, window.body);
  assert.ok(!window.body.includes(secret));
  assert.equal(f.stats.reads, 0);
  assert.equal(f.stats.adoptions, 0);
});
