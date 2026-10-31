import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, human, post } from '../helpers/message-search-answer-fixture.js';

test('an unchanged moved ledger row retains its label and opens its current location without replacing the snapshot', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.request),
      p = await post(f, prepared);
    const saved = f.store.get(prepared.publicationRef);
    const before = { body: saved.response_json, digest: saved.response_digest };
    f.setRevision('b'.repeat(40));
    f.updateDecision({ line: 2 });
    const read = await f.service.read(p.message.id, p.published.extra.messageSearchAnswer.blockId, human);
    assert.equal(read.status, 'available');
    assert.equal(read.decisionUpdated, false, 'a moved coordinate is not a changed decision');
    assert.deepEqual(read.response.results[0].decisionSources, [
      {
        ...prepared.response.results[0].decisionSources[0],
        line: 2,
        documentRevision: 'b'.repeat(40),
      },
    ]);
    const after = f.store.get(prepared.publicationRef);
    assert.equal(after.response_json, before.body);
    assert.equal(after.response_digest, before.digest);
    assert.equal(f.searches(), 1);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});

for (const patch of [
  { conclusion: 'The decision changed' },
  { status: 'superseded' },
  { decidedBy: 'Another person' },
  { decidedAt: '10-16 09:00' },
  { documentPath: 'docs/features/F310.md' },
]) {
  test(`moving a row does not upgrade changed decision metadata: ${Object.keys(patch)[0]}`, async () => {
    const f = fixture();
    try {
      const prepared = await f.service.prepare(f.request),
        p = await post(f, prepared);
      f.setRevision('b'.repeat(40));
      f.updateDecision({ line: 2, ...patch });
      const read = await f.service.read(p.message.id, p.published.extra.messageSearchAnswer.blockId, human);
      assert.equal(read.status, 'available');
      assert.equal(read.decisionUpdated, true);
      assert.equal(read.response.results[0].decisionSources, undefined);
      assert.equal(f.searches(), 1);
    } finally {
      f.db.close();
    }
  });
}
