import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unreadProjectionFixture } from './helpers/unread-projection-cost-fixture.js';

const target = process.env.CAT_CAFE_READ_COST_TARGET === 'dist' ? 'dist' : 'src';
const { projectRedisUnreadSummaries } = await import(
  `../${target}/domains/cats/services/stores/redis/redis-unread-summary-projection.js`
);

test('unread counts consume each metadata batch without retaining the full historical payload window', async () => {
  const fixture = unreadProjectionFixture(5000);
  const result = await projectRedisUnreadSummaries(fixture.redis, fixture.cursors, 'owner');
  assert.deepEqual(result, [{ threadId: 'reader-cost', unreadCount: 5000, hasUserMention: true }]);
  const stats = fixture.stats();
  assert.equal(stats.batches, 5);
  assert.equal(stats.foldedRows, 5000);
  assert.equal(stats.outstandingBytes, 0);
  assert(
    stats.maxOutstandingBytes <= fixture.bytesPerRow * 1000,
    `retained ${stats.maxOutstandingBytes} bytes of raw metadata instead of one bounded batch`,
  );
});

test('a failed later unread batch rejects the whole summary rather than returning earlier partial counts', async () => {
  const fixture = unreadProjectionFixture(2001, 2);
  await assert.rejects(
    projectRedisUnreadSummaries(fixture.redis, fixture.cursors, 'owner'),
    /Unread hash pipeline returned no results/,
  );
});

test('shared index membership retains each thread count while reading each payload once', async () => {
  const fixture = unreadProjectionFixture(2001);
  const cursor = fixture.cursors[0];
  assert(cursor);
  const cursors = [...fixture.cursors, { ...cursor, threadId: 'other-window' }];
  const result = await projectRedisUnreadSummaries(fixture.redis, cursors, 'owner');
  assert.deepEqual(result, [
    { threadId: 'reader-cost', unreadCount: 2001, hasUserMention: true },
    { threadId: 'other-window', unreadCount: 2001, hasUserMention: true },
  ]);
  assert.equal(fixture.stats().batches, 3);
  assert(fixture.stats().maxOutstandingBytes <= fixture.bytesPerRow * 1000);
});
