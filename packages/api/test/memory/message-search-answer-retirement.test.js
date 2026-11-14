import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { MessageSelectionError } from '../../dist/domains/memory/message-selected-quote.js';
import { fixture, human, post, seedHistoricalAnswer } from '../helpers/message-search-answer-fixture.js';

test('a new answer needs cat-selected sources, and the cat can correct the same operation without retrieval', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.service.prepare({ ...f.request, selections: undefined }),
      (error) => error instanceof MessageSelectionError && /select|选/i.test(error.message),
    );
    assert.equal(f.store.forOperation('owner', f.request.producer, f.request.operationId), null);
    assert.equal(f.searches(), 0, 'missing selections cannot turn into another source search');
    assert.equal(f.calls(), 0, 'missing selections cannot launch qualification');
    const row = f.source[1];
    const corrected = await f.service.prepare({
      ...f.request,
      selections: [
        {
          threadId: row.threadId,
          messageId: row.id,
          contentRevision: createHash('sha256').update(row.content).digest('hex'),
          quote: 'original source 1',
          reason: 'The cat read and selected this original source.',
        },
      ],
    });
    assert.equal(corrected.status, 'prepared');
    assert.equal(corrected.response.meta.resultKind, 'selected-answer');
    assert.equal(corrected.response.meta.qualification, undefined);
    const saved = f.store.get(corrected.publicationRef).response_json;
    await assert.rejects(f.service.prepare({ ...f.request, selections: undefined }), /ANSWER_OPERATION_CONFLICT/);
    assert.equal(f.store.get(corrected.publicationRef).response_json, saved);
    assert.equal(f.searches(), 0);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});

test('a saved supported card survives publication, reopen and legacy retry without requalification or rewriting history', async () => {
  const f = fixture();
  try {
    const prepared = await seedHistoricalAnswer(f);
    const legacy = prepared.response;
    assert.ok(legacy.meta.qualification.supported > 0);
    const before = f.store.get(prepared.publicationRef).response_json;
    const card = await post(f, prepared);
    assert.ok(card.published);
    const reopened = await f.recreate().read(card.message.id, card.published.extra.messageSearchAnswer.blockId, human);
    assert.equal(reopened.status, 'available');
    assert.deepEqual(reopened.response.meta.qualification, legacy.meta.qualification);
    const retried = await f.recreate().prepare({ ...f.request, selections: undefined });
    assert.equal(retried.publicationRef, prepared.publicationRef);
    assert.equal(f.store.get(prepared.publicationRef).response_json, before);
    assert.equal(f.searches(), 0);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});
