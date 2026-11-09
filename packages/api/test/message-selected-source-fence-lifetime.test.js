import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBeforeSearchCutoff } from '../dist/domains/memory/message-search-lifetime.js';
import { redisSelectedSourceReadFence } from '../dist/domains/memory/message-selected-read-fence.js';
import { human, selectedSourceRedisFixture } from './helpers/message-selected-source-redis-fixture.js';

const clients = async (redis) =>
  new Set(
    (await redis.client('LIST'))
      .trim()
      .split('\n')
      .map((line) => line.match(/^id=(\d+)/)?.[1]),
  );

for (const operation of ['read', 'prepare', 'fence'])
  for (const stop of ['deadline', 'abort'])
    test(`${operation} releases its witness on ${stop} before stalled downstream I/O returns`, async () => {
      const f = await selectedSourceRedisFixture();
      let release = () => {};
      let markFinished;
      const finished = new Promise((resolve) => {
        markFinished = resolve;
      });
      try {
        const response = f.store.response(f.store.get(f.prepared.publicationRef));
        const baseline = await clients(f.redis);
        let markStarted;
        const started = new Promise((resolve) => {
          markStarted = resolve;
        });
        const stalled = new Promise((resolve) => {
          release = resolve;
        });
        const list = f.threads.list.bind(f.threads);
        let calls = 0;
        f.threads.list = async (...args) => {
          // A new selection's first publisher/origin admissions have no owned
          // witness; pause the list call inside its final shared witness.
          if (operation === 'prepare' && ++calls < 3) return list(...args);
          markStarted();
          await stalled;
          markFinished();
          return list(...args);
        };
        const controller = new AbortController();
        const deadlineAt = Date.now() + 1600;
        let pending;
        if (operation === 'read') pending = f.search.readAnswerSnapshot(response, human, controller.signal, deadlineAt);
        if (operation === 'prepare')
          pending = f.search.selectAnswer('上线', f.request.selections, 'codex61-sol', human, {
            signal: controller.signal,
            deadlineAt,
          });
        if (operation === 'fence')
          pending = readBeforeSearchCutoff(
            (lifetime) =>
              redisSelectedSourceReadFence(f.redis)(
                [{ threadId: f.sourceThread.id, messageId: f.source.id }],
                'owner',
                async () => {
                  markStarted();
                  await stalled;
                  markFinished();
                  throw new Error('late downstream rejection');
                },
                lifetime,
              ),
            deadlineAt - 250,
            { signal: controller.signal, deadlineAt },
          );
        const observed = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await started;
        assert.equal(
          [...(await clients(f.redis))].filter((id) => !baseline.has(id)).length,
          1,
          'pause inside the owned witness',
        );
        if (stop === 'abort') controller.abort(new DOMException('User cancelled', 'AbortError'));
        const outcome = await observed;
        if (operation === 'fence' && stop === 'deadline') {
          // The outer soft cutoff may stop waiting, or the bounded inner read
          // may report its own timeout first. Neither can return a safe value.
          assert.ok(outcome.value?.completed === false || outcome.error?.name === 'TimeoutError');
        } else assert.equal(outcome.error?.name, stop === 'deadline' ? 'TimeoutError' : 'AbortError');
        assert.deepEqual(
          [...(await clients(f.redis))].filter((id) => !baseline.has(id)),
          [],
          'dispose without waiting for downstream I/O',
        );
        release();
        await finished;
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(
          [...(await clients(f.redis))].filter((id) => !baseline.has(id)),
          [],
          'a late value/rejection cannot recreate the witness',
        );
      } finally {
        release();
        await new Promise((resolve) => setImmediate(resolve));
        await f.close();
      }
    });

test('a witness that reaches its own deadline reports timeout rather than an authority conflict', async () => {
  const f = await selectedSourceRedisFixture();
  let release = () => {};
  let pending;
  try {
    const baseline = await clients(f.redis);
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const stalled = new Promise((resolve) => {
      release = resolve;
    });
    // The witness owns an independent deadline even without an outer waiter.
    pending = redisSelectedSourceReadFence(f.redis)(
      [{ threadId: f.sourceThread.id, messageId: f.source.id }],
      'owner',
      async () => {
        markStarted();
        await stalled;
        return 'late old row';
      },
      { deadlineAt: Date.now() + 250 },
    );
    const observed = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await started;
    const outcome = await observed;
    assert.equal(outcome.error?.name, 'TimeoutError');
    assert.deepEqual(
      [...(await clients(f.redis))].filter((id) => !baseline.has(id)),
      [],
    );
  } finally {
    release();
    await pending?.catch(() => {});
    await f.close();
  }
});
