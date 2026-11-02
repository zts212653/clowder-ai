import assert from 'node:assert/strict';
import { it } from 'node:test';
import { getRoster } from '../dist/config/cat-config-loader.js';
import { generateScriptViaThread } from '../dist/domains/signals/services/podcast-generator.js';
import { privateInput, successorFixture } from './helpers/successor-routing-fixture.js';

it('system pre-resolved private admission persists only the successor and replays its winner', async (t) => {
  const h = successorFixture(t);
  const input = privateInput(h.threadId);
  const result = await h.queue.enqueueDurable(input);
  assert.deepEqual(result.entry.targets, ['opus-5']);
  assert.deepEqual((await h.ledger.list(h.threadId))[0].targets, ['opus-5']);
  getRoster().opus = { ...getRoster().opus, successor: 'codex' };
  const replay = await h.queue.enqueueDurable(input);
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.entry.targets, ['opus-5']);
  await assert.rejects(h.queue.enqueueDurable({ ...input, targetCats: ['codex'] }), /identity conflict/);
});

it('notice admission and synchronous admission share the same first-write target policy', async (t) => {
  const h = successorFixture(t);
  const input = privateInput(h.threadId);
  const notice = {
    from: input.from,
    userId: 'owner',
    threadId: h.threadId,
    content: 'notice',
    mentions: [],
    timestamp: 1,
    idempotencyKey: 'notice',
  };
  const result = await h.queue.enqueueDurableWithVisibleNotice(input, notice, h.messages);
  assert.deepEqual(result.entry.targets, ['opus-5']);
  getRoster().opus = { ...getRoster().opus, successor: 'codex' };
  const replay = await h.queue.enqueueDurableWithVisibleNotice(input, notice, h.messages);
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.entry.targets, ['opus-5']);
  const sync = h.queue.enqueueDurableNow({ ...input, idempotencyKey: 'sync' });
  assert.deepEqual(sync.entry.targets, ['codex']);
  assert.throws(
    () => h.queue.enqueueDurableNow({ ...input, idempotencyKey: 'sentinel-sync', targetCats: ['__none__'] }),
    /target/,
  );
});

it('private admission fails before any ledger or visible notice write with no valid successor', async (t) => {
  const h = successorFixture(t, { opus: { successor: 'ghost' } });
  await assert.rejects(h.queue.enqueueDurable(privateInput(h.threadId)), /target/i);
  const notice = {
    from: { kind: 'system', service: 'test' },
    userId: 'owner',
    threadId: h.threadId,
    content: 'notice',
    mentions: [],
    timestamp: 1,
  };
  await assert.rejects(
    h.queue.enqueueDurableWithVisibleNotice(privateInput(h.threadId), notice, h.messages),
    /target/i,
  );
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  assert.deepEqual(await h.messages.getByThread(h.threadId), []);
  await assert.rejects(
    generateScriptViaThread(
      {
        articleId: 'no-target',
        articleTitle: 'Article',
        articleContent: 'Body',
        requestedBy: 'owner',
        mode: 'essence',
      },
      h.threadId,
      { invocationQueue: h.queue, queueProcessor: h.processor },
    ),
    /target/i,
  );
  assert.deepEqual(await h.ledger.list(h.threadId), []);
});

for (const target of ['__none__', 'ghost']) {
  it(`${target} cannot be admitted as a system identity`, async (t) => {
    const h = successorFixture(t);
    await assert.rejects(h.queue.enqueueDurable(privateInput(h.threadId, { targetCats: [target] })), /target/i);
    assert.deepEqual(await h.ledger.list(h.threadId), []);
  });
}

for (const exact of [
  { exactTargets: true },
  {
    executionScope: 'collective-work',
    from: { kind: 'system', service: 'collective-work' },
    ownerAuthProvenance: 'unknown',
  },
  { a2aParentInvocationId: 'parent-1' },
]) {
  it(`authority-bound ${Object.keys(exact)[0]} never retargets a disabled member`, async (t) => {
    const h = successorFixture(t);
    await assert.rejects(h.queue.enqueueDurable(privateInput(h.threadId, exact)), /target/i);
    assert.deepEqual(await h.ledger.list(h.threadId), []);
  });
}

it('current podcast producer runs through real QueueProcessor and successor service', { timeout: 15000 }, async (t) => {
  const h = successorFixture(t);
  const script = await generateScriptViaThread(
    { articleId: 'article', articleTitle: 'Article', articleContent: 'Body', requestedBy: 'owner', mode: 'essence' },
    h.threadId,
    { invocationQueue: h.queue, queueProcessor: h.processor },
  );
  assert.equal(script.totalDuration, 3);
  assert.deepEqual(h.calls, ['opus-5']);
  assert.ok((await h.ledger.list(h.threadId)).every((entry) => !entry.targets.includes('opus')));
  const history = await h.messages.getByThread(h.threadId);
  assert.ok(history.length > 0);
  assert.ok(history.every((message) => message.from.kind === 'agent' && message.from.catId === 'opus-5'));
});

it(
  'a queued recipient disabled after admission fails against its bound identity without invoking a replacement',
  { timeout: 15000 },
  async (t) => {
    const h = successorFixture(t);
    const admitted = await h.queue.enqueueDurable(privateInput(h.threadId, { targetCats: ['codex'] }));
    getRoster().codex = { ...getRoster().codex, available: false, successor: 'opus-5' };
    const statuses = [];
    const completed = new Promise((resolve) =>
      h.processor.registerEntryCompleteHook(admitted.entry.id, (_id, status) => {
        statuses.push(status);
        resolve(status);
      }),
    );
    await h.processor.requestDrain(h.threadId);
    assert.equal(await completed, 'failed');
    await h.processor.requestDrain(h.threadId);
    assert.deepEqual(statuses, ['failed']);
    assert.deepEqual(h.calls, []);
  },
);

it('direct routeExecution refuses disabled, sentinel and unknown targets before calling services', async (t) => {
  const h = successorFixture(t);
  for (const target of ['opus', '__none__', 'ghost']) {
    const events = [];
    for await (const event of h.router.routeExecution(
      'owner',
      'work',
      h.threadId,
      '',
      [target],
      { intent: 'execute', explicit: false, promptTags: [] },
      {},
    ))
      events.push(event);
    assert.ok(
      events.some((event) => event.type === 'error'),
      target,
    );
  }
  assert.deepEqual(h.calls, []);
});
