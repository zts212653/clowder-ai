import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { lifecycleInputIdentityForStoredMessage } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { queueHttpFixture as fixture } from './helpers/1398-queue-http-fixture.js';

for (const scenario of [
  { targets: ['gemini'], whisper: false },
  { targets: ['gemini', 'codex'], whisper: false },
  { targets: ['gemini', 'codex'], whisper: true },
]) {
  for (const mode of ['manual', 'drain']) {
    for (const explicit of [false, true]) {
      test(`late unavailable recipient settles visibly without expanding Queue authority (${mode}, exact=${explicit}, targets=${scenario.targets.length}, whisper=${scenario.whisper})`, async (t) => {
        const f = await fixture(t);
        f.reply('opus');
        f.threads.updateRoutingPolicy(f.thread.id, {
          v: 1,
          scopes: { review: { avoidCats: ['opus'], preferCats: ['codex'] } },
        });
        const sent = await f.app.inject({
          method: 'POST',
          url: '/api/messages',
          headers: { 'x-cat-cafe-user': 'owner' },
          payload: {
            threadId: f.thread.id,
            content: `${scenario.targets.map((cat) => `@${cat}`).join(' ')} please review this change`,
            idempotencyKey: randomUUID(),
            ...(explicit ? { mentions: scenario.targets } : {}),
            ...(scenario.whisper ? { visibility: 'whisper', whisperTo: scenario.targets } : {}),
          },
        });
        assert.equal(sent.statusCode, 202, sent.body);
        const entry = f.queue.list(f.thread.id, 'owner')[0];
        assert.deepEqual(entry.targets, scenario.targets);
        for (const target of scenario.targets)
          f.agents.markUnavailable(target, { code: 'rejected-account-binding', message: 'late fixture outage' });
        f.router.refreshFromRegistry(f.agents);
        const deliveries = [];
        f.router.routeExecution = async function* (...args) {
          deliveries.push(args[4]);
          throw new Error('No other recipient may acquire this queued source');
        };
        const processor = new QueueProcessor({
          queue: f.queue,
          invocationTracker: new InvocationTracker(),
          invocationRecordStore: new InvocationRecordStore(),
          messageStore: f.messages,
          router: f.router,
          socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
          log: { info() {}, warn() {}, error() {} },
        });
        const process = () =>
          mode === 'manual' ? processor.processNext(f.thread.id, 'owner') : processor.requestDrain(f.thread.id);
        await process();
        assert.equal(
          f.queue.list(f.thread.id, 'owner').length,
          0,
          'an unavailable recipient must not leave an unclaimable Queue row',
        );
        assert.deepEqual(deliveries, []);
        const history = f.messages.getByThread(f.thread.id);
        const failures = history.filter((message) => message.lifecycle?.kind === 'delivery_failure');
        assert.equal(failures.length, 1);
        assert.equal(failures[0].lifecycle.inputMessageId, entry.payload.messageId);
        assert.deepEqual(failures[0].lifecycle.requestedTargets, scenario.targets);
        if (scenario.whisper) {
          assert.equal(f.messages.getById(entry.payload.messageId).visibility, 'whisper');
          assert.deepEqual(f.messages.getById(entry.payload.messageId).whisperTo, scenario.targets);
        }
        assert.equal(failures[0].lifecycle.reason, 'invalid_explicit_target');
        assert.equal(f.messages.getById(entry.payload.messageId).deliveryStatus, 'delivered');
        await process();
        assert.equal(
          f.messages.getByThread(f.thread.id).filter((message) => message.lifecycle?.kind === 'delivery_failure')
            .length,
          1,
        );
      });
    }
  }
}

for (const mode of ['manual', 'drain'])
  test(`an unavailable sibling preserves owner-held work (${mode})`, async (t) => {
    const f = await fixture(t);
    const sent = await f.app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { threadId: f.thread.id, content: '@gemini @codex continue', mentions: ['gemini', 'codex'] },
    });
    assert.equal(sent.statusCode, 202, sent.body);
    const entry = f.queue.list(f.thread.id, 'owner')[0];
    assert.ok(await f.queue.markProcessingByIdDurable(f.thread.id, entry.id, 'gemini'));
    await f.queue.holdClaimedRoutingTarget(f.thread.id, [entry.id], 'gemini', f.messages);
    await f.queue.rollbackProcessingDurable(f.thread.id, entry.id);
    assert.deepEqual((await f.queue.getDurableEntry(f.thread.id, entry.id)).delivery.routingHeldTargetIds, ['gemini']);
    for (const cat of mode === 'drain' ? ['gemini', 'codex'] : ['codex'])
      f.agents.markUnavailable(cat, { code: 'rejected-account-binding', message: 'late outage' });
    f.router.refreshFromRegistry(f.agents);
    const processor = new QueueProcessor({
      queue: f.queue,
      invocationTracker: new InvocationTracker(),
      invocationRecordStore: new InvocationRecordStore(),
      messageStore: f.messages,
      router: f.router,
      socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
      log: { info() {}, warn() {}, error() {} },
    });
    if (mode === 'manual')
      assert.equal(
        (await processor.processNext(f.thread.id, 'owner')).started,
        false,
        'a healthy held recipient still requires owner retry',
      );
    else await processor.requestDrain(f.thread.id);
    const remaining = await f.queue.getDurableEntry(f.thread.id, entry.id);
    assert.ok(remaining, 'an automatic failure cannot consume the owner-held recipient');
    assert.deepEqual(remaining.targets, ['gemini', 'codex']);
    assert.deepEqual(remaining.delivery.routingHeldTargetIds, ['gemini']);
    assert.equal(
      f.messages.getByThread(f.thread.id).filter((message) => message.lifecycle?.kind === 'delivery_failure').length,
      0,
    );
    if (mode === 'drain') {
      const deliveries = [];
      f.router.routeExecution = async function* (...args) {
        deliveries.push(args[4]);
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      };
      const next = await f.app.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { 'x-cat-cafe-user': 'owner' },
        payload: { threadId: f.thread.id, content: '@opus independent work', mentions: ['opus'] },
      });
      assert.equal(next.statusCode, 202, next.body);
      await processor.requestDrain(f.thread.id);
      await new Promise(setImmediate);
      assert.deepEqual(deliveries, [['opus']], 'owner-held work only holds its own recipients');
    }
  });

test('a lost Queue removal acknowledgment reuses the committed failure on retry', async (t) => {
  const f = await fixture(t);
  const sent = await f.app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: f.thread.id, content: '@gemini continue', mentions: ['gemini'] },
  });
  assert.equal(sent.statusCode, 202, sent.body);
  const entry = f.queue.list(f.thread.id, 'owner')[0];
  f.agents.markUnavailable('gemini', { code: 'rejected-account-binding', message: 'late outage' });
  f.router.refreshFromRegistry(f.agents);
  const processor = new QueueProcessor({
    queue: f.queue,
    invocationTracker: new InvocationTracker(),
    invocationRecordStore: new InvocationRecordStore(),
    messageStore: f.messages,
    router: f.router,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  const remove = f.queue.removeProcessedAcrossUsersDurable.bind(f.queue);
  let failRemoval = true;
  f.queue.removeProcessedAcrossUsersDurable = async (...args) => {
    if (failRemoval) {
      failRemoval = false;
      throw new Error('simulated Queue acknowledgment loss');
    }
    return remove(...args);
  };
  await assert.rejects(() => processor.processNext(f.thread.id, 'owner'), /simulated Queue acknowledgment loss/);
  const source = f.messages.getById(entry.payload.messageId);
  const failure = f.messages.getByThread(f.thread.id).find((message) => message.lifecycle?.kind === 'delivery_failure');
  assert.ok(failure);
  const publishedAt = source.deliveredAt;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1000 });
  await processor.processNext(f.thread.id, 'owner');
  assert.equal(f.queue.list(f.thread.id, 'owner').length, 0);
  assert.equal(f.messages.getById(source.id).deliveredAt, publishedAt);
  assert.deepEqual(
    f.messages
      .getByThread(f.thread.id)
      .filter((message) => message.lifecycle?.kind === 'delivery_failure')
      .map((message) => message.id),
    [failure.id],
  );
});

test('after one recipient adopts an input, the remaining unavailable recipient settles without changing that reply', async (t) => {
  const f = await fixture(t);
  const sent = await f.app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: f.thread.id, content: '@codex @gemini continue', mentions: ['codex', 'gemini'] },
  });
  assert.equal(sent.statusCode, 202, sent.body);
  const entry = f.queue.list(f.thread.id, 'owner')[0];
  const source = f.messages.getById(entry.payload.messageId);
  const publishedAt = Date.now();
  assert.ok(await f.queue.claimExactExposureDurable(f.thread.id, 'owner', entry.id, 'codex', source.id));
  assert.equal(
    f.messages.advanceLifecycleInputDispatch(source.id, {
      ...lifecycleInputIdentityForStoredMessage(source),
      targetId: 'codex',
      statusMessageId: 'codex-response',
      phase: 'dispatched',
      dispatchedAt: publishedAt,
    }).kind,
    'applied',
  );
  f.messages.markDelivered(source.id, publishedAt);
  assert.ok(
    await f.queue.commitClaimedAdoptionDurable(f.thread.id, 'owner', entry.id, 'codex', 'codex-run', publishedAt),
  );
  assert.deepEqual((await f.queue.getDurableEntry(f.thread.id, entry.id)).targets, ['gemini']);
  f.agents.markUnavailable('gemini', { code: 'rejected-account-binding', message: 'late outage' });
  f.router.refreshFromRegistry(f.agents);
  const processor = new QueueProcessor({
    queue: f.queue,
    invocationTracker: new InvocationTracker(),
    invocationRecordStore: new InvocationRecordStore(),
    messageStore: f.messages,
    router: f.router,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  await processor.requestDrain(f.thread.id);
  assert.equal(f.queue.list(f.thread.id, 'owner').length, 0);
  const current = f.messages.getById(source.id);
  assert.equal(current.deliveredAt, publishedAt);
  assert.equal(current.lifecycle.dispatchRefs[0].statusMessageId, 'codex-response');
  const failure = f.messages.getByThread(f.thread.id).find((message) => message.lifecycle?.kind === 'delivery_failure');
  assert.ok(failure);
  assert.deepEqual(failure.lifecycle.requestedTargets, ['gemini']);
  assert.equal(current.lifecycle.dispatchRefs[1].statusMessageId, failure.id);
});
