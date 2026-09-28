import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { paginatePawFeelBundles } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/read-model-pagination.js';

function cohort() {
  let reads = 0;
  const bundles = Array.from({ length: 40 }, (_, bundleIndex) => ({
    bundleKey: `bundle-${String(bundleIndex).padStart(2, '0')}`,
    members: Array.from({ length: 8 }, (_, memberIndex) => ({
      issue: { resolution: bundleIndex >= 36 ? 'resolved' : 'open', resolvedAt: '2026-09-11T12:00:00.000Z' },
      disposition: {
        signalId: `signal-${bundleIndex}-${memberIndex}`,
        get discoveredAt() {
          reads++;
          return new Date(Date.UTC(2026, 8, 1, 0, 0, (39 - bundleIndex) * 8 + memberIndex)).toISOString();
        },
        lastTransitionAt: '2026-09-11T12:00:00.000Z',
      },
    })),
  }));
  return { bundles, reads: () => reads };
}

describe('global inbox bundle key read budget', () => {
  for (const sort of ['oldest', 'newest']) {
    it(`${sort}: computes each member key once, including cursor comparison`, () => {
      const firstInput = cohort();
      const first = paginatePawFeelBundles(firstInput.bundles, { sort, limit: 5 });
      const expected = Array.from(
        { length: 36 },
        (_, i) => `bundle-${String(sort === 'oldest' ? 35 - i : i).padStart(2, '0')}`,
      );
      assert.deepEqual(
        first.bundles.map((b) => b.bundleKey),
        expected.slice(0, 5),
      );
      assert(first.nextCursor);
      assert(firstInput.reads() <= 36 * 8, `first page read ${firstInput.reads()} member timestamps`);

      const nextInput = cohort();
      const next = paginatePawFeelBundles(nextInput.bundles, { sort, cursor: first.nextCursor, limit: 50 });
      assert.deepEqual(
        next.bundles.map((b) => b.bundleKey),
        [...expected.slice(5), 'bundle-36', 'bundle-37', 'bundle-38', 'bundle-39'],
      );
      assert.equal(next.nextCursor, undefined);
      assert(nextInput.reads() <= 36 * 8, `cursor page read ${nextInput.reads()} member timestamps`);
    });
  }
});
