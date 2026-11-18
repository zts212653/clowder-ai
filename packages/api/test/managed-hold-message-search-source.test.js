import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAgentReadableManagedHoldMessage } from '../dist/domains/cats/services/stores/visibility.js';
import { CAT, OWNER, schedulerReadFixture } from './helpers/scheduler-read-fixture.js';

function holdSource(f, phase) {
  return {
    connector: 'hold-ball',
    meta: {
      managedHold: true,
      taskId: 'owned-command',
      threadId: f.thread.id,
      catId: CAT,
      ...(phase === undefined ? {} : { phase }),
    },
  };
}

function wake(f, overrides = {}) {
  const { deliveryStatus = 'delivered', ...rest } = overrides;
  const message = f.messages.append({
    from: { kind: 'system', service: 'hold-ball' },
    userId: OWNER,
    threadId: f.thread.id,
    content: 'Managed command completed; continue the accepted work.',
    mentions: [CAT],
    timestamp: Date.now(),
    deliveryStatus: 'queued',
    source: holdSource(f, 'wake'),
    ...rest,
  });
  if (deliveryStatus === 'delivered') f.messages.markDelivered(message.id, Date.now());
  if (deliveryStatus === 'canceled') f.messages.markCanceled(message.id);
  return f.messages.getById(message.id);
}

test('an owner-bound delivered managed wake can search through its authenticated callback source', async (t) => {
  const f = await schedulerReadFixture(t);
  const source = await f.publish('managed-hold');
  assert.equal(source.source.meta.phase, 'wake');
  assert.equal(source.deliveryStatus, 'delivered');
  const res = await f.search(await f.auth(source));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    res.json().results.map((r) => r.messageId),
    [f.answer.id],
  );
  assert.equal(f.stats.reads, 1);
  assert.equal(f.stats.adoptions, 0);
});

for (const [label, override] of [
  ['foreign owner', { userId: 'foreign-owner' }],
  ['ownerless scheduler', { userId: 'scheduler' }],
  ['undelivered', { deliveryStatus: 'queued' }],
  ['canceled', { deliveryStatus: 'canceled' }],
  ['hidden trigger', { extra: { scheduler: { hiddenTrigger: true } } }],
  ['other-cat whisper', { visibility: 'whisper', whisperTo: ['codex61-sol'] }],
  ['briefing', { origin: 'briefing' }],
  ['untyped source', { source: { connector: 'hold-ball' } }],
]) {
  test(`a ${label} managed wake cannot authorize message search`, async (t) => {
    const f = await schedulerReadFixture(t);
    const res = await f.search(await f.auth(wake(f, override)));
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(f.stats.reads, 0);
  });
}

test('a recipient managed wake can search without publishing its private origin as a result', async (t) => {
  const f = await schedulerReadFixture(t);
  const source = wake(f, { visibility: 'whisper', whisperTo: [CAT], content: 'piano PRIVATE_ORIGIN_SENTINEL' });
  const headers = await f.auth(source);
  const res = await f.search(headers);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    res.json().results.map((row) => row.messageId),
    [f.answer.id],
  );
  assert.ok(!res.body.includes('PRIVATE_ORIGIN_SENTINEL'));
  assert.equal(f.stats.reads, 1);
  f.answer.id = source.id;
  f.answer.content = source.content;
  const onlyOrigin = await f.search(headers);
  assert.equal(onlyOrigin.statusCode, 200, onlyOrigin.body);
  assert.deepEqual(onlyOrigin.json().results, []);
  assert.ok(!onlyOrigin.body.includes('PRIVATE_ORIGIN_SENTINEL'));
});

test('a waiting receipt without delivery metadata remains readable but cannot authorize an invocation', async (t) => {
  const f = await schedulerReadFixture(t);
  // This is the exact legacy-visible shape written by callback-hold-ball-routes:
  // waiting is a History fact, with no Queue input or deliveryStatus.
  const source = f.messages.append({
    from: { kind: 'system', service: 'hold-ball' },
    userId: OWNER,
    threadId: f.thread.id,
    content: 'Waiting for the accepted work.',
    mentions: [],
    timestamp: Date.now(),
    source: holdSource(f, 'waiting'),
  });
  assert.equal(source.deliveryStatus, undefined);
  assert.equal(isAgentReadableManagedHoldMessage(source), true);
  assert.equal((await f.read(source)).statusCode, 200);
  const res = await f.search(await f.auth(source));
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(f.stats.reads, 0);
});

for (const phase of ['waiting', 'status', undefined]) {
  test(`a delivered ${phase ?? 'missing-phase'} hold receipt cannot authorize an invocation`, async (t) => {
    const f = await schedulerReadFixture(t);
    const source = wake(f, { source: holdSource(f, phase) });
    assert.equal(isAgentReadableManagedHoldMessage(source), true);
    assert.equal((await f.search(await f.auth(source))).statusCode, 403);
    assert.equal(f.stats.reads, 0);
  });
}

test('an ordinary recipient user whisper retains its existing source admission', async (t) => {
  const f = await schedulerReadFixture(t);
  const source = f.messages.append({
    from: { kind: 'user', userId: OWNER },
    userId: OWNER,
    threadId: f.thread.id,
    content: 'Find the earlier piano source.',
    mentions: [CAT],
    timestamp: Date.now(),
    visibility: 'whisper',
    whisperTo: [CAT],
  });
  const res = await f.search(await f.auth(source));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(f.stats.reads, 1);
});

test('a managed wake with foreign typed thread coordinates cannot authorize message search', async (t) => {
  const f = await schedulerReadFixture(t);
  const source = wake(f, {
    source: {
      connector: 'hold-ball',
      meta: { managedHold: true, taskId: 'owned-command', threadId: f.caller.id, catId: CAT, phase: 'wake' },
    },
  });
  assert.equal((await f.search(await f.auth(source))).statusCode, 403);
  assert.equal(f.stats.reads, 0);
});

test('a delivered managed source is re-admitted after withdrawal while retrieval is running', async (t) => {
  const f = await schedulerReadFixture(t);
  const source = wake(f);
  f.setDuringSearch(() => f.messages.softDelete(source.id, OWNER));
  const res = await f.search(await f.auth(source));
  assert.equal(f.stats.reads, 1);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().results, undefined);
});
