import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../helpers/message-search-answer-fixture.js';

test('ordinary recall cannot automatically become a card; only explicit cat selections are stored', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.request.input.query = 'piano original';
  const raw = await f.search.search(f.request.input, f.request.principal);
  assert.equal(raw.results.length, 4);
  assert.equal(raw.meta.resultKind, 'sources');
  assert.equal(raw.meta.qualification, undefined);
  assert.equal(f.calls(), 0);
  await assert.rejects(f.service.prepare({ ...f.request, selections: undefined }), /Select source quotations/);
  assert.equal(f.store.forOperation('owner', f.request.producer, f.request.operationId), null);
  // Keep the same query and raw pool, but the answering cat chooses one public source.
  const prepared = await f.service.prepare({ ...f.request, selections: f.request.selections.slice(1, 2) });
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(
    prepared.response.results.map((row) => row.messageId),
    [f.source[1].id],
  );
  assert.equal(prepared.response.meta.qualification, undefined);
  assert.equal(f.calls(), 0);
  assert.equal(f.searches(), 1, 'preparation consumes chosen sources without a second search');
  const saved = f.store.response(f.store.get(prepared.publicationRef));
  assert.deepEqual(
    saved.results.map((row) => row.messageId),
    [f.source[1].id],
  );
  await f.service.prepare({ ...f.request, selections: f.request.selections.slice(1, 2) });
  assert.equal(f.searches(), 1, 'idempotent answer retry never repeats retrieval');
});
