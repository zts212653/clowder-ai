import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanPawFeelSignalIds } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/signal-scan.js';

describe('F313 bounded paw-feel signal scan primitive', () => {
  it('carries one bounded Redis overflow batch without dropping a terminal page', async () => {
    const ids = Array.from({ length: 75 }, (_, index) => `signal-${index}`);
    let calls = 0;
    const redis = {
      async sscan() {
        calls += 1;
        return ['0', ids];
      },
    };

    const first = await scanPawFeelSignalIds(redis, 'signals', undefined, 50);
    assert.deepEqual(first.signalIds, ids.slice(0, 50));
    assert.deepEqual(first.nextCursor, {
      redisCursor: '0',
      pendingSignalIds: ids.slice(50),
      completeAfterPending: true,
    });
    const second = await scanPawFeelSignalIds(redis, 'signals', first.nextCursor, 50);
    assert.deepEqual(second.signalIds, ids.slice(50));
    assert.equal(second.nextCursor, undefined);
    assert.equal(second.scanCalls, 0);
    assert.equal(calls, 1);
  });

  it('fails closed instead of serializing an unbounded scan overflow', async () => {
    const redis = {
      async sscan() {
        return ['0', Array.from({ length: 101 }, (_, index) => `signal-${index}`)];
      },
    };

    await assert.rejects(scanPawFeelSignalIds(redis, 'signals', undefined, 50), /bounded continuation/i);
  });

  it('rejects impossible process cursors before consulting Redis', async () => {
    let calls = 0;
    const redis = {
      async sscan() {
        calls += 1;
        return ['0', []];
      },
    };
    await assert.rejects(
      scanPawFeelSignalIds(
        redis,
        'signals',
        { redisCursor: '0', pendingSignalIds: [], completeAfterPending: false },
        50,
      ),
      /invalid.*cursor/i,
    );
    assert.equal(calls, 0);
  });
});
