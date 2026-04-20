import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { withCapabilityLock } from '../../../dist/config/capabilities/capability-orchestrator.js';

describe('withCapabilityLock', () => {
  test('serializes concurrent writes — no entries lost', async () => {
    let counter = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withCapabilityLock('test-project-lock', async () => {
          const current = counter;
          await new Promise((r) => setTimeout(r, 5));
          counter = current + 1;
          return counter;
        }),
      ),
    );
    assert.equal(counter, 10, 'All 10 increments must succeed without race');
    assert.deepEqual(results, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('different project roots run independently', async () => {
    let counterA = 0;
    let counterB = 0;
    await Promise.all([
      withCapabilityLock('project-a', async () => {
        counterA++;
      }),
      withCapabilityLock('project-b', async () => {
        counterB++;
      }),
    ]);
    assert.equal(counterA, 1);
    assert.equal(counterB, 1);
  });

  test('error in fn does not block subsequent calls', async () => {
    await assert.rejects(
      withCapabilityLock('error-project', async () => {
        throw new Error('deliberate');
      }),
    );
    const result = await withCapabilityLock('error-project', async () => 'recovered');
    assert.equal(result, 'recovered');
  });
});
