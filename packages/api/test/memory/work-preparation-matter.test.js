import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matterPreparationFixture } from '../helpers/work-preparation-matter-fixture.js';

test('a prepared Matter returns every supporting condition beyond twelve and records exactly those reads', async (t) => {
  const { actor, app, rows, episodes, prepare: runPrepare } = await matterPreparationFixture(t);
  const prepare = await runPrepare();
  assert.equal(prepare.statusCode, 200, prepare.body);
  const [pointer] = prepare.json().pointers;
  assert.ok(pointer, prepare.body);
  const read = await app.inject({
    method: 'POST',
    url: '/api/callbacks/memory-cues/drill',
    payload: { handle: pointer.read.handle, requestId: 'read-all-conditions' },
  });
  assert.equal(read.statusCode, 200, read.body);
  const page = read.json().payload;
  assert.deepEqual(page.entries.map((entry) => entry.quote).sort(), rows.map((row) => row.content).sort());
  assert.equal(page.nextCursor, undefined, 'this complete read has no omitted supporting source');
  const actual = page.entries.map((entry) => ({ entryId: entry.entryId, sourceRevision: entry.source.sourceRevision }));
  const receipts = episodes.listByCue(actor.userId, pointer.cueId);
  assert.deepEqual(
    receipts.map((receipt) => receipt.consumptionOutcome),
    ['presented', 'drilled'],
  );
  for (const receipt of receipts) assert.deepEqual(receipt.readDetails.entries, actual);
});
