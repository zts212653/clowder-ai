import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, human, producer, response } from '../helpers/message-search-answer-fixture.js';

async function seed(f) {
  return f.service.prepare({ ...f.request, producer: { ...producer, kind: 'agent_key', id: 'seed' } });
}
async function retainedResponse(f, saved, number, status = 'completed') {
  const author = { ...producer, id: `retained-${number}` };
  const { record } = await f.store.claim({
    ownerUserId: 'owner',
    producer: author,
    operationId: 'original-purpose',
    targetThreadId: 'origin',
    requestDigest: f.store.get(saved.publicationRef).request_digest,
  });
  // Fixed valid refs put the actual historical prefix ahead of the lost R.
  const ref = `message-search-answer:${number.toString(16).padStart(64, '0')}`;
  f.db
    .prepare('UPDATE message_search_answer_publications SET publication_ref=? WHERE publication_ref=?')
    .run(ref, record.publication_ref);
  await f.store.complete(ref, saved.response);
  return { author, ref, message: status === null ? null : response(f, status, author) };
}

test('over 1000 actually bound R publications cannot starve a later completed response after restart', async () => {
  const f = fixture();
  try {
    const saved = await seed(f);
    for (let i = 0; i < 1001; i++) {
      const row = await retainedResponse(f, saved, i);
      const bound = await f.service.publishResponse(row.message, row.author.id);
      assert.ok(bound.extra?.messageSearchAnswer);
    }
    const target = await retainedResponse(f, saved, 0xffff);
    const result = await f.recreate().recoverPreparedResponses();
    const actual = f.messages.getById(target.message.id);
    assert.ok(actual.extra?.messageSearchAnswer, 'the real completed R beyond the old bound prefix is recovered');
    assert.ok(result.scanned < 1000, 'already reconciled messages do not spend the bounded recovery budget');
    assert.equal(
      (await f.service.read(actual.id, actual.extra.messageSearchAnswer.blockId, human)).status,
      'available',
    );
    assert.equal(f.searches(), 1);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});

test('an unreconciled prefix rotates durably instead of starving a later R on every restart', async () => {
  const f = fixture();
  try {
    const saved = await seed(f);
    for (let i = 0; i < 1001; i++) await retainedResponse(f, saved, i, 'processing');
    const target = await retainedResponse(f, saved, 0xffff);
    const first = await f.recreate().recoverPreparedResponses();
    assert.equal(first.scanned, 1000);
    assert.equal(first.hasMore, true);
    assert.equal(f.messages.getById(target.message.id).extra?.messageSearchAnswer, undefined);
    const second = await f.recreate().recoverPreparedResponses();
    assert.ok(second.scanned <= 1000);
    assert.ok(
      f.messages.getById(target.message.id).extra?.messageSearchAnswer,
      'persisted scan progress survives service recreation',
    );
    assert.equal(f.searches(), 1);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});

test('a reserved message coordinate remains recoverable until its actual Host binding exists', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.request);
    const message = response(f);
    const blockId = `search-answer-${prepared.publicationRef.slice(-32)}`;
    assert.equal(await f.store.claimBinding(prepared.publicationRef, message.id, blockId), true);
    assert.equal((await f.service.read(message.id, blockId, human)).status, 'unavailable');
    await f.recreate().recoverPreparedResponses();
    assert.equal(f.messages.getById(message.id).extra.rich.blocks.length, 1);
    assert.equal((await f.service.read(message.id, blockId, human)).status, 'available');
    assert.equal(f.searches(), 1);
  } finally {
    f.db.close();
  }
});

test('new preparations between restarts cannot repeatedly jump ahead of an older recoverable R', async () => {
  const f = fixture();
  try {
    const saved = await seed(f);
    const target = await retainedResponse(f, saved, 0xffff, null);
    await f.recreate().recoverPreparedResponses();
    const message = response(f, 'completed', target.author);
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 1000; i++) await retainedResponse(f, saved, round * 1000 + i, null);
      assert.ok((await f.recreate().recoverPreparedResponses()).scanned <= 1000);
    }
    assert.ok(
      f.messages.getById(message.id).extra?.messageSearchAnswer,
      'new arrivals join the current scan round instead of resetting to the front',
    );
    assert.equal(f.searches(), 1);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});

test('loss after the Host commit but before recovery acknowledgement repairs metadata without a second card', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.request);
    const message = response(f);
    f.store.completeRecovery = async () => {
      throw new Error('lost acknowledgement');
    };
    await assert.rejects(() => f.service.publishResponse(message, producer.id), /lost acknowledgement/);
    assert.equal(f.messages.getById(message.id).extra.rich.blocks.length, 1);
    await f.recreate().recoverPreparedResponses();
    assert.equal(f.messages.getById(message.id).extra.rich.blocks.length, 1);
    assert.equal((await f.recreate().recoverPreparedResponses()).scanned, 0);
    assert.equal((await f.recreate().prepare(f.request)).publicationRef, prepared.publicationRef);
    assert.equal(f.searches(), 1);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});
