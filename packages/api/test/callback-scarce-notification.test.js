import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createScarceNotificationFixture } from './helpers/scarce-notification-fixture.js';

describe('F293 Phase O: scarce notification delivery', () => {
  let app;
  let registry;
  let messages;
  let threads;
  let cursors;
  let source;
  let target;
  let records;
  let executions;
  let queue;
  let agentKeys;

  let fixture;
  beforeEach(async () => {
    fixture = await createScarceNotificationFixture();
    ({ registry, messages, threads, cursors, source, target, records, executions, queue, agentKeys } = fixture);
  });
  afterEach(() => fixture.close());

  async function setup(options) {
    const auth = await fixture.setup(options);
    app = fixture.app;
    return auth;
  }
  function post(auth, payload) {
    return fixture.post(auth, payload);
  }

  for (const queued of [false, true]) {
    for (const crossThread of [false, true]) {
      for (const metadata of [
        { effectClass: 'fyi' },
        { coordination: { phase: 'terminal', subjectRef: 'feature:F293:O' } },
      ]) {
        test(`${queued ? 'canonical queue' : 'canonical send'} ${crossThread ? 'cross_post' : 'post_message'} ${JSON.stringify(metadata)} delivers without waking scarce cat`, async () => {
          const auth = await setup({ queued });
          const threadId = crossThread ? target.id : source.id;
          const response = await post(auth, { threadId, ...metadata });
          assert.equal(response.statusCode, 200, response.body);
          assert.deepEqual(records, [], 'notification must not create invocation');
          assert.deepEqual(executions, [], 'notification must not execute provider');
          assert.equal(queue.list(threadId, 'user-1').length, 0, 'notification must not enqueue a wake');
          const body = response.json();
          assert.deepEqual(body.deliveredWithoutWake, ['fable-5']);
          assert.deepEqual(body.routed, []);
          assert.match(body.message, /已送达，未叫醒/);
          const stored = messages.getById(body.messageId);
          assert.deepEqual(stored.mentions, ['fable-5']);
          assert.notEqual(stored.deliveryStatus, 'queued', 'notification is visible now');
          assert.equal(await cursors.getSeenCursor('user-1', 'fable-5', threadId), undefined);
          assert.equal(await cursors.getCursor('user-1', 'fable-5', threadId), undefined);
          const reader = await registry.create('user-1', 'fable-5', threadId);
          const unread = await app.inject({
            method: 'GET',
            url: '/api/callbacks/thread-context?readIntent=unread&responseMode=full',
            headers: { 'x-invocation-id': reader.invocationId, 'x-callback-token': reader.callbackToken },
          });
          assert.equal(unread.statusCode, 200, unread.body);
          assert.ok(unread.json().messages.some((message) => message.id === stored.id));
        });
      }
    }
  }

  for (const metadata of [{ effectClass: 'fyi' }, { coordination: { phase: 'terminal' } }]) {
    test(`non-scarce cat keeps its wake for ${JSON.stringify(metadata)}`, async () => {
      const auth = await setup();
      const response = await post(auth, { threadId: target.id, targetCats: ['codex'], ...metadata });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(records.length, 1);
      assert.deepEqual(records[0].targetCats, ['codex']);
      assert.deepEqual(response.json().routed, ['codex']);
    });
  }

  test('active coordination overrides fyi and wakes the scarce cat', async () => {
    const auth = await setup();
    const response = await post(auth, {
      threadId: target.id,
      effectClass: 'fyi',
      coordination: { phase: 'active', subjectRef: 'feature:F293:O' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].targetCats, ['fable-5']);
  });

  test('ordinary actionable mention wakes the scarce cat', async () => {
    const auth = await setup();
    const response = await post(auth, { threadId: target.id });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(records.length, 1);
  });

  test('identical notification retry preserves delivery receipt and does not wake; later substantive send does wake', async () => {
    const auth = await setup();
    const first = await post(auth, { threadId: target.id, effectClass: 'fyi', clientMessageId: 'quiet-retry' });
    const retry = await post(auth, { threadId: target.id, effectClass: 'fyi', clientMessageId: 'quiet-retry' });
    assert.equal(retry.json().status, 'duplicate');
    assert.equal(retry.json().messageId, first.json().messageId);
    assert.deepEqual(retry.json().deliveredWithoutWake, ['fable-5']);
    assert.deepEqual(records, []);
    const actionable = await post(auth, { threadId: target.id });
    assert.equal(actionable.statusCode, 200, actionable.body);
    assert.notEqual(actionable.json().status, 'duplicate');
    assert.equal(records.length, 1, 'an earlier notification cannot swallow subsequent work');
  });

  test('clientMessageId notification retry still reports delivered without wake', async () => {
    const auth = await setup();
    const payload = { threadId: target.id, effectClass: 'fyi', clientMessageId: 'notification-key' };
    const first = await post(auth, payload);
    const retry = await post(auth, payload);
    assert.equal(retry.json().status, 'duplicate');
    assert.equal(retry.json().messageId, first.json().messageId);
    assert.deepEqual(retry.json().deliveredWithoutWake, ['fable-5']);
    assert.match(retry.json().message, /已送达，未叫醒/);
    assert.deepEqual(records, []);
  });

  for (const principal of ['invocation-token', 'agent-key']) {
    test(`${principal} notification retry preserves its exact receipt beyond the recent-message window`, async (t) => {
      const auth = await setup();
      const { secret } = await agentKeys.issue('opus', 'user-1');
      const send = (payload) =>
        principal === 'invocation-token'
          ? post(auth, payload)
          : app.inject({
              method: 'POST',
              url: '/api/callbacks/post-message',
              headers: { 'x-agent-key-secret': secret },
              payload: { content: 'Published notification', targetCats: ['fable-5'], ...payload },
            });
      const payload = { threadId: target.id, effectClass: 'fyi', clientMessageId: 'old-notification' };
      const first = await send(payload);
      assert.equal(first.statusCode, 200, first.body);
      for (let index = 0; index < 21; index++)
        messages.append({
          userId: 'user-1',
          threadId: target.id,
          from: { kind: 'agent', catId: 'codex' },
          content: `Later message ${index}`,
          mentions: [],
          timestamp: Date.now() + index,
        });
      const retry = await send(payload);
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json().status, 'duplicate');
      assert.equal(retry.json().messageId, first.json().messageId);
      assert.deepEqual(retry.json().deliveredWithoutWake, ['fable-5']);
      assert.match(retry.json().message, /已送达，未叫醒/);
      assert.equal(
        messages.getByThread(target.id, 100, 'user-1').filter((message) => message.content === 'Published notification')
          .length,
        1,
      );
      assert.deepEqual(records, []);
      assert.deepEqual(executions, []);
      // The message identity also survives expiration/recovery of the transient registry retry guard.
      t.mock.method(principal === 'invocation-token' ? registry : agentKeys, 'claimClientMessageId', async () => true);
      const recovered = await send(payload);
      assert.equal(recovered.statusCode, 200, recovered.body);
      assert.equal(recovered.json().messageId, first.json().messageId);
      assert.deepEqual(recovered.json().deliveredWithoutWake, ['fable-5']);
      assert.deepEqual(records, []);
    });
  }

  test('line-start-only cross_post routing credentials still deliver a scarce notification', async () => {
    const auth = await setup();
    const response = await post(auth, {
      threadId: target.id,
      targetCats: [],
      content: '@fable5\nFYI',
      effectClass: 'fyi',
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().deliveredWithoutWake, ['fable-5']);
    assert.deepEqual(records, []);
  });

  test('production default policy reader consumes the active project dossier at send time', async (t) => {
    const previous = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = fixture.dossierRoot;
    t.after(() => {
      if (previous === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previous;
    });
    const auth = await setup({ useDefaultReader: true });
    const response = await post(auth, { threadId: target.id, effectClass: 'fyi' });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().deliveredWithoutWake, ['fable-5']);
    assert.deepEqual(records, []);
  });

  test('agent-key fyi delivers without waking, preserves retry receipt, and subsequent work wakes', async () => {
    await setup();
    const { secret } = await agentKeys.issue('opus', 'user-1');
    const send = (payload) =>
      app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-agent-key-secret': secret },
        payload: { threadId: target.id, content: 'Agent-key notification', targetCats: ['fable-5'], ...payload },
      });
    const first = await send({ effectClass: 'fyi', clientMessageId: 'agent-notification' });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json().deliveredWithoutWake, ['fable-5']);
    const retry = await send({ effectClass: 'fyi', clientMessageId: 'agent-notification' });
    assert.deepEqual(retry.json().deliveredWithoutWake, ['fable-5']);
    assert.deepEqual(records, []);
    const actionable = await send({});
    assert.equal(actionable.statusCode, 200, actionable.body);
    assert.notEqual(actionable.json().status, 'duplicate');
    assert.deepEqual(records[0].targetCats, ['fable-5']);
  });

  test('typed localReviewVerdict keeps the scarce author wake even with fyi', async () => {
    const auth = await setup();
    await threads.addParticipants(source.id, ['fable-5']);
    const response = await post(auth, {
      effectClass: 'fyi',
      clientMessageId: 'review-fact',
      localReviewVerdict: 'approved',
      reviewedHeadSha: 'a'.repeat(40),
      reviewSubjectRef: 'pr:zts212653/clowder-ai#4268',
      acceptedSourceRef: 'docs/features/F293-live-routing-context.md',
      acceptedRevision: 'b'.repeat(40),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].targetCats, ['fable-5']);
  });

  test('notification delivery intent survives Redis hydration', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const extra = { notificationDelivery: { withoutWakeCatIds: ['fable-5'] }, targetCats: ['fable-5'] };
    assert.deepEqual(safeParseExtra(serializeExtra(extra)), extra);
    assert.equal(
      safeParseExtra(JSON.stringify({ notificationDelivery: { withoutWakeCatIds: [42] } }))?.notificationDelivery,
      undefined,
    );
  });

  test('a mixed notification keeps both recipients and wakes only the ordinary cat', async () => {
    const auth = await setup();
    const response = await post(auth, { threadId: target.id, targetCats: ['fable-5', 'codex'], effectClass: 'fyi' });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      records.flatMap((record) => record.targetCats),
      ['codex'],
    );
    assert.deepEqual(messages.getById(response.json().messageId).mentions, ['fable-5', 'codex']);
    assert.deepEqual(response.json().deliveredWithoutWake, ['fable-5']);
  });
});
