import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { QueueRetryDeferrals } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-retry-deferrals.js'
);

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('timed out waiting for the retry wait'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe('QueueRetryDeferrals', () => {
  it('doubles the wait with each consecutive failure up to the longest wait', () => {
    const clock = { now: 1_000 };
    const deferrals = new QueueRetryDeferrals(
      () => {},
      { baseDelayMs: 100, maxDelayMs: 350 },
      () => clock.now,
    );

    const waits = [1, 2, 3, 4].map(() => deferrals.defer('thread-1', 'entry-1') - clock.now);

    assert.deepEqual(waits, [100, 200, 350, 350]);
    deferrals.forget('entry-1');
  });

  it('waits for the target’s own retry time when it is later than the backoff, up to the longest wait', () => {
    const clock = { now: 1_000 };
    const deferrals = new QueueRetryDeferrals(
      () => {},
      { baseDelayMs: 100, maxDelayMs: 1_000 },
      () => clock.now,
    );

    assert.equal(deferrals.defer('thread-1', 'later', clock.now + 600), clock.now + 600);
    assert.equal(deferrals.defer('thread-1', 'earlier', clock.now + 50), clock.now + 100, 'the backoff still applies');
    assert.equal(
      deferrals.defer('thread-1', 'far', clock.now + 60_000),
      clock.now + 1_000,
      'bounded by the longest wait',
    );
    assert.equal(deferrals.defer('thread-1', 'unknown', Number.POSITIVE_INFINITY), clock.now + 100);
    for (const entryId of ['later', 'earlier', 'far', 'unknown']) deferrals.forget(entryId);
  });

  it('holds the entry until its wait ends, then drains its thread', async () => {
    const drained = [];
    const deferrals = new QueueRetryDeferrals((threadId) => drained.push(threadId), { baseDelayMs: 30 });

    deferrals.defer('thread-1', 'entry-1');
    assert.equal(deferrals.isDeferred('entry-1'), true);
    assert.equal(deferrals.isDeferred('entry-2'), false);

    await waitFor(() => drained.length === 1);
    assert.deepEqual(drained, ['thread-1']);
    assert.equal(deferrals.isDeferred('entry-1'), false);
  });

  it('forgets a handed-off entry: no drain fires and its next failure starts from the shortest wait', async () => {
    const clock = { now: 1_000 };
    const drained = [];
    const deferrals = new QueueRetryDeferrals(
      (threadId) => drained.push(threadId),
      { baseDelayMs: 30, maxDelayMs: 1_000 },
      () => clock.now,
    );
    deferrals.defer('thread-1', 'entry-1');
    deferrals.defer('thread-1', 'entry-1');

    deferrals.forget('entry-1');

    assert.equal(deferrals.isDeferred('entry-1'), false);
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.deepEqual(drained, []);
    assert.equal(deferrals.defer('thread-1', 'entry-1') - clock.now, 30);
    deferrals.forget('entry-1');
  });
});
