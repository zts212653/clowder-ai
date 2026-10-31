import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectRecallReplies } from '../src/routes/recall-reply-index.js';
import { fixtureRedis, hash, type MessageHash } from './helpers/recall-reply-fixture.js';

test('reply index snapshot survives a head append, removal, or rescore before metadata hydration', async () => {
  const rows = Array.from({ length: 1500 }, (_, i) => hash(`m-${String(i).padStart(4, '0')}`, i));
  const mutations = [
    (index: MessageHash[]) => index.unshift(hash('new-head', 5000)),
    (index: MessageHash[]) => index.shift(),
    (index: MessageHash[]) => {
      const moved = index.pop();
      if (moved) index.unshift({ ...moved, timelineOrderAt: '5000' });
    },
  ];
  for (const before of [undefined, { timestamp: 1400, messageId: 'm-1400' }]) {
    for (const mutate of mutations) {
      const expected = before
        ? await fixtureRedis(rows).store.getByThreadBefore(
            'thread-owned',
            before.timestamp,
            500,
            before.messageId,
            'owner',
          )
        : await fixtureRedis(rows).store.getByThread('thread-owned', 500, 'owner');
      const { store, calls } = fixtureRedis(rows, undefined, mutate);
      const actual = await store.getThreadReplyProjection('thread-owned', 'owner', 500, before);
      assert.deepEqual(
        actual.map((row) => row.id),
        expected.map((row) => row.id),
        'one index snapshot must retain all original 500 positions',
      );
      assert.equal(new Set(actual.map((row) => row.id)).size, 500);
      const indexReads = calls.filter(
        (call) => call.method === 'zrevrange' || call.method === 'zrevrangebyscore',
      ).length;
      // The inclusive composite-cursor query excludes its boundary member and may need one refill.
      assert.equal(indexReads, before ? 2 : 1);
      assert.ok(calls.filter((call) => call.method === 'exec').every((call) => (call.size ?? 0) <= 100));
    }
  }
});

test('499 visible messages followed by 5000 invisible rows keep Redis round trips bounded', async (t) => {
  const rows = Array.from({ length: 5499 }, (_, i) =>
    hash(`m-${String(i).padStart(4, '0')}`, i, { userId: i < 5000 ? 'other' : 'owner' }),
  );
  const { store, calls } = fixtureRedis(rows);
  const actual = await store.getThreadReplyProjection('thread-owned', 'owner', 500);
  assert.equal(actual.length, 499);
  const trips = calls.filter((call) => ['zrevrange', 'zrevrangebyscore', 'exec'].includes(call.method)).length;
  t.diagnostic(`near-full page Redis round trips: ${trips}`);
  assert.ok(trips <= 80, `near-full page made ${trips} Redis round trips`);
  assert.ok(calls.filter((call) => call.method === 'exec').every((call) => (call.size ?? 0) <= 100));
});

test('reply metadata uses the full reader numeric decoding for legacy Redis spellings', async () => {
  for (const raw of ['', 'inf', '+inf', '-inf', ' 1.5 ']) {
    const { store } = fixtureRedis([hash('number-row', 1, { timestamp: raw, timelineOrderAt: raw })]);
    const full = await store.getByThread('thread-owned', 500, 'owner');
    const native = await store.getThreadReplyProjection('thread-owned', 'owner', 500);
    assert.deepEqual(projectRecallReplies(native), projectRecallReplies(full));
    assert.equal(native[0]?.timelineOrderAt, full[0]?.timelineOrderAt);
  }
});
