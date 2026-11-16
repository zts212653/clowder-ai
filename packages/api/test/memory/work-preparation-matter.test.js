import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matterPreparationFixture } from '../helpers/work-preparation-matter-fixture.js';

test('preparation keeps a thread-only summary and records its interpretation without claiming an original read', async (t) => {
  const f = await matterPreparationFixture(t);
  await f.matters.write(f.actor, {
    operation: 'retire',
    requestId: 'retire-original',
    matterId: f.created.matter.matterId,
    expectedRevision: 1,
  });
  await f.matters.write(f.actor, {
    operation: 'create',
    requestId: 'summary-only',
    title: 'html w3allconditions',
    summary: '只记归纳，原对话里保留完整条件。',
    sources: [{ threadId: 'history' }],
  });
  const prepared = await f.prepare();
  assert.equal(prepared.statusCode, 200, prepared.body);
  const [pointer] = prepared.json().pointers;
  assert.ok(pointer, prepared.body);
  const read = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/memory-cues/drill',
    payload: { handle: pointer.readRef.handle, requestId: 'read-light-summary' },
  });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().payload.entries[0].summary, '只记归纳，原对话里保留完整条件。');
  assert.equal(read.json().payload.entries[0].source.kind, 'thread');
  assert.equal(read.json().payload.entries[0].quote, undefined);
  const receipts = f.episodes.listByCue(f.actor.userId, pointer.cueId);
  assert.deepEqual(
    receipts.map((receipt) => receipt.consumptionOutcome),
    ['presented', 'drilled'],
  );
  assert.ok(receipts.every((receipt) => typeof receipt.readDetails.entries[0].entryRevision === 'string'));
  assert.ok(receipts.every((receipt) => receipt.readDetails.entries[0].sourceRevision === undefined));
});

test('a prepared Matter returns every supporting condition beyond twelve and records exactly those reads', async (t) => {
  const { actor, app, rows, episodes, prepare: runPrepare } = await matterPreparationFixture(t);
  const prepare = await runPrepare();
  assert.equal(prepare.statusCode, 200, prepare.body);
  const [pointer] = prepare.json().pointers;
  assert.ok(pointer, prepare.body);
  const read = await app.inject({
    method: 'POST',
    url: '/api/callbacks/memory-cues/drill',
    payload: { handle: pointer.readRef.handle, requestId: 'read-all-conditions' },
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
