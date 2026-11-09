import assert from 'node:assert/strict';
import { it } from 'node:test';
import { getRoster } from '../dist/config/cat-config-loader.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { createPluginConversationDelivery } from '../dist/domains/plugin/host-surface/plugin-conversation-delivery.js';
import { successorFixture } from './helpers/successor-routing-fixture.js';

async function fixture(t, content = 'work') {
  const h = successorFixture(t);
  const source = await h.messages.append({
    from: { kind: 'plugin', instanceId: 'issue1292-replay' },
    userId: 'owner',
    threadId: h.threadId,
    content,
    mentions: [],
    timestamp: 1,
    extra: {
      pluginMessage: {
        instanceId: 'issue1292-replay',
        revision: 1,
        provenance: { epistemicStatus: 'observation' },
        elements: [{ elementId: 'text', kind: 'text', payload: { text: content } }],
        appendOps: [],
      },
    },
  });
  const consumer = (queue = h.queue) =>
    createPluginConversationDelivery({ messageStore: h.messages, queue, router: h.router });
  const send = (options = {}) =>
    consumer(options.queue).trigger(
      options.threadId ?? h.threadId,
      Object.hasOwn(options, 'hint') ? options.hint : 'opus',
      options.userId ?? 'owner',
      options.content ?? content,
      source.id,
      undefined,
      options.policy,
    );
  return { ...h, source, send };
}

it('plugin wake retry reuses the pending winner after successor changes and Queue reopens', async (t) => {
  const h = await fixture(t);
  await h.send();
  getRoster().opus = { ...getRoster().opus, successor: 'codex' };
  const queue = new InvocationQueue(h.ledger);
  await h.send({ queue });
  await h.send({ hint: 'codex', queue });
  assert.deepEqual(
    (await h.ledger.list(h.threadId)).map((row) => row.targets),
    [['opus-5']],
  );
  assert.deepEqual(
    queue.list(h.threadId, 'owner').map((row) => row.targets),
    [['opus-5']],
  );
  assert.deepEqual(h.calls, []);
});

it('plugin retry preserves remaining siblings without re-admitting a consumed member', async (t) => {
  const h = await fixture(t, '#ideate work');
  h.threads.updatePreferredCats(h.threadId, ['opus', 'codex']);
  await h.send({ hint: undefined });
  const [entry] = await h.ledger.list(h.threadId);
  assert.deepEqual(entry.targets, ['opus-5', 'codex']);
  await h.ledger.claim(h.threadId, entry.id, 'partial', Date.now(), 'opus-5');
  await h.ledger.commit(h.threadId, entry.id, 'partial', 'processing', Date.now());
  await h.send({ hint: 'opus-5', policy: { exactTarget: true } });
  assert.deepEqual((await h.ledger.list(h.threadId))[0].targets, ['codex']);
});

it('a delivered plugin source replays its acknowledgement after full retirement', { timeout: 15000 }, async (t) => {
  const h = await fixture(t);
  await h.send();
  const [entry] = await h.ledger.list(h.threadId);
  const completed = new Promise((resolve) =>
    h.processor.registerEntryCompleteHook(entry.id, (_id, status) => resolve(status)),
  );
  await h.processor.requestDrain(h.threadId);
  assert.equal(await completed, 'succeeded');
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  getRoster().opus = { ...getRoster().opus, successor: 'ghost' };
  await h.send({ queue: new InvocationQueue(h.ledger) });
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  assert.deepEqual(h.calls, ['opus-5']);
  await assert.rejects(h.send({ hint: 'codex', policy: { exactTarget: true } }), /explicit plugin recipient/);
});

it('a canceled plugin input without delivery refs acknowledges its source without recreating work', async (t) => {
  const h = await fixture(t);
  await h.send();
  const [entry] = await h.ledger.list(h.threadId);
  await h.ledger.claim(h.threadId, entry.id, 'cancel', Date.now(), 'opus-5');
  await h.ledger.commit(h.threadId, entry.id, 'cancel', 'withdrawn', Date.now());
  await h.messages.markCanceled(h.source.id);
  assert.deepEqual((await h.messages.getById(h.source.id)).lifecycle.dispatchRefs, []);
  getRoster().opus = { ...getRoster().opus, successor: 'codex' };
  await h.send({ hint: 'opus', policy: { exactTarget: true }, queue: new InvocationQueue(h.ledger) });
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  assert.deepEqual(h.calls, []);
});

it('plugin replay still validates source owner, thread, content and a known exact recipient', async (t) => {
  const h = await fixture(t);
  await h.send();
  for (const changed of [{ userId: 'other' }, { threadId: 'other' }, { content: 'different' }]) {
    await assert.rejects(h.send(changed), /source|identity/);
  }
  await assert.rejects(h.send({ hint: 'codex', policy: { exactTarget: true } }), /identity|explicit plugin recipient/);
  assert.deepEqual((await h.ledger.list(h.threadId))[0].targets, ['opus-5']);
});

it('a published plugin message without admission facts still creates its first Queue entry', async (t) => {
  const h = await fixture(t);
  assert.equal(h.source.lifecycle, undefined);
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  await h.send();
  assert.deepEqual((await h.ledger.list(h.threadId))[0].targets, ['opus-5']);
});

it('a settled no-target plugin input cannot acquire a new recipient on retry', async (t) => {
  const h = await fixture(t);
  getRoster().opus = { ...getRoster().opus, successor: 'ghost' };
  await h.send();
  assert.deepEqual((await h.ledger.list(h.threadId))[0].targets, []);
  await h.processor.requestDrain(h.threadId);
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  const history = await h.messages.getByThread(h.threadId);
  getRoster().opus = { ...getRoster().opus, successor: 'opus-5' };
  await h.send({ queue: new InvocationQueue(h.ledger) });
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  assert.equal((await h.messages.getByThread(h.threadId)).length, history.length);
  assert.deepEqual(h.calls, []);
});
