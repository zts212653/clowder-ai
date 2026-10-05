import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DELEGATE, NEXT_CAT } from './f290-communication-a2a-custody-callback.fixture.js';
import { inlineCustodyFixture } from './f290-communication-a2a-custody-inline.fixture.js';
import { CAT } from './f290-communication-validation.host.js';

for (const defer of ['busy', 'pending', 'interrupted'] as const) {
  test(`actual callback creates a non-original private B turn whose text cannot escape through ${defer}`, async () => {
    const f = await inlineCustodyFixture('private', defer);
    try {
      const source = await f.run();
      assert.deepEqual(f.calls, [
        { catId: CAT, policy: 'collective_work' },
        { catId: DELEGATE, policy: 'collective_work' },
      ]);
      assert.deepEqual(source?.extra?.collectiveWorkDelegationV1?.targetCatIds, [DELEGATE]);
      assert.equal(source?.extra?.collectiveWorkDelegationV1?.taskId, f.task.id);
      assert.equal(
        f.queue.list(f.threadId, f.cafe.ownerUserId).length,
        0,
        'Non-original text does not create C home custody',
      );
    } finally {
      await f.close();
    }
  });
}

test('actual ordinary callback still reaches non-original B and defers its home text routing', async () => {
  const f = await inlineCustodyFixture('home', 'busy');
  try {
    const source = await f.run();
    assert.deepEqual(
      f.calls.map((call) => call.catId),
      [CAT, DELEGATE],
    );
    assert.ok(f.calls.every((call) => call.policy === undefined));
    assert.equal(source?.extra?.collectiveWorkDelegationV1, undefined);
    const entries = f.queue.list(f.threadId, f.cafe.ownerUserId);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].targetCats, [NEXT_CAT]);
    assert.equal(entries[0].executionScope, undefined);
  } finally {
    await f.close();
  }
});
