import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeResolver } from '../../dist/domains/memory/KnowledgeResolver.js';

test('an early timer does not reject discovery before its shared absolute deadline', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = KnowledgeResolver.discover('stalled', {
    deadlineAt: 1020,
    limit: 1,
    sources: [
      {
        id: 'stalled',
        read: () => new Promise(() => {}),
        project: async (row) => row,
        key: (row) => row,
      },
    ],
  });
  const observed = pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  now = 1019;
  t.mock.timers.tick(20);
  await new Promise(setImmediate);
  assert.equal(settled, false, 'the shared wall-clock deadline has not expired');

  now = 1020;
  t.mock.timers.tick(1);
  await assert.rejects(pending, { name: 'TimeoutError' });
  await observed;
});
