import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { MessageSearchAnswerPublicationStore } from '../../dist/domains/memory/MessageSearchAnswerPublicationStore.js';
import { fixture, human, post, producer, response } from '../helpers/message-search-answer-fixture.js';

test('one claimed operation searches once, stores one bounded publicReply snapshot, and retries read it', async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.service.prepare(f.request), f.service.prepare(f.request)]);
    const prepared = results.find((r) => r.status === 'prepared');
    assert.ok(prepared);
    assert.equal(f.searches(), 1);
    assert.equal(f.calls(), 0);
    assert.equal(prepared.response.results.length, 3);
    assert.ok(!JSON.stringify(prepared).includes('PRIVATE'));
    assert.ok(JSON.stringify(prepared).length <= 24000);
    assert.equal(f.db.prepare('SELECT count(*) n FROM message_search_answer_publications').get().n, 1);
    assert.equal((await f.service.prepare(f.request)).publicationRef, prepared.publicationRef);
    assert.equal(f.searches(), 1);
    await assert.rejects(
      () => f.service.prepare({ ...f.request, input: { query: 'changed', mode: 'lexical' } }),
      /ANSWER_OPERATION_CONFLICT/,
    );
    assert.equal(f.searches(), 1);
  } finally {
    f.db.close();
  }
});
test('prepared is not published; an actual explicit message binds once, and normal extra cannot replace that proof', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.request);
    assert.equal(prepared.status, 'prepared');
    assert.equal((await f.service.read('fake', 'fake', human)).status, 'unavailable');
    const p = await post(f, prepared);
    assert.ok(p.published?.extra.messageSearchAnswer);
    assert.equal(
      (await f.service.read(p.message.id, p.published.extra.messageSearchAnswer.blockId, human)).status,
      'available',
    );
    const retry = await f.service.publishPost(p.selection, p.message.id, producer, 'owner');
    assert.equal(retry.extra.rich.blocks.length, 1);
    f.messages.updateExtra(p.message.id, {
      messageSearchAnswer: { publicationRef: 'FORGED' },
      targetCats: [],
      rich: { v: 1, blocks: [] },
    });
    assert.equal(f.messages.getById(p.message.id).extra.messageSearchAnswer.publicationRef, prepared.publicationRef);
    assert.equal(
      f.messages.getById(p.message.id).extra.rich.blocks.length,
      1,
      'ordinary rich patches retain the Host-owned ref',
    );
    assert.equal((await f.service.prepare(f.request)).status, 'published');
    assert.equal(f.searches(), 1);
    assert.equal(await f.service.preparePost(p.selection, 'owner', producer, 'origin', 'different-message'), null);
  } finally {
    f.db.close();
  }
});
test('lost binding response recovers the same message and card after service recreation without search', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.request),
      block = await f.service.preparePost({ publicationRef: prepared.publicationRef }, 'owner', producer, 'origin');
    const msg = f.messages.append({
      from: { kind: 'agent', catId: producer.catId },
      userId: 'owner',
      threadId: 'origin',
      content: 'Answer',
      mentions: [],
      timestamp: 2000,
      origin: 'callback',
      extra: { isExplicitPost: true, rich: { v: 1, blocks: [block] } },
    });
    const original = f.messages.attachMessageSearchAnswer.bind(f.messages);
    f.messages.attachMessageSearchAnswer = () => {
      throw new Error('simulated process loss after record claim');
    };
    await assert.rejects(() =>
      f.service.publishPost({ publicationRef: prepared.publicationRef }, msg.id, producer, 'owner'),
    );
    assert.equal(f.store.get(prepared.publicationRef).bound_message_id, msg.id);
    assert.equal((await f.service.read(msg.id, block.id, human)).status, 'unavailable');
    f.messages.attachMessageSearchAnswer = original;
    const recovered = await f
      .recreate()
      .publishPost({ publicationRef: prepared.publicationRef }, msg.id, producer, 'owner');
    assert.equal(recovered.id, msg.id);
    assert.equal(recovered.extra.rich.blocks.length, 1);
    assert.equal(f.searches(), 1);
  } finally {
    f.db.close();
  }
});
test('a pending search remains honestly pending after interruption and never automatically starts again', async () => {
  const f = fixture();
  try {
    let enter, finish;
    const entered = new Promise((r) => {
      enter = r;
    });
    const gate = new Promise((r) => {
      finish = r;
    });
    const actual = f.search.search.bind(f.search);
    f.search.search = async (...args) => {
      enter();
      await gate;
      return actual(...args);
    };
    const first = f.service.prepare(f.request);
    await entered;
    assert.equal((await f.recreate().prepare(f.request)).status, 'pending');
    assert.equal(f.searches(), 0);
    finish();
    await first;
    assert.equal(f.searches(), 1);
  } finally {
    f.db.close();
  }
});
test('only an actually completed normal R attaches, and boot recovery uses that same original response', async () => {
  for (const status of ['processing', 'failed', 'canceled', 'interrupted', 'completed']) {
    const f = fixture();
    try {
      await f.service.prepare(f.request);
      const msg = response(f, status);
      await f.recreate().recoverPreparedResponses();
      const stored = f.messages.getById(msg.id);
      assert.equal(!!stored.extra?.messageSearchAnswer, status === 'completed', status);
      if (status === 'completed') {
        await f.recreate().publishResponse(stored, producer.id);
        assert.equal(f.messages.getById(msg.id).extra.rich.blocks.length, 1);
      }
      assert.equal(f.searches(), 1);
      assert.equal(f.calls(), 0);
    } finally {
      f.db.close();
    }
  }
});
test('copied refs, wrong producer, changed destination and cross-user reads cannot manufacture an admitted card', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.request),
      p = await post(f, prepared),
      block = p.published.extra.messageSearchAnswer.blockId;
    await assert.rejects(
      () => f.service.preparePost(p.selection, 'other', producer, 'origin'),
      /destination unavailable/,
    );
    assert.equal(await f.service.preparePost(p.selection, 'owner', { ...producer, id: 'another' }, 'origin'), null);
    assert.equal(await f.service.preparePost(p.selection, 'owner', producer, 'forward'), null);
    assert.equal(
      (await f.service.read(p.message.id, block, { userId: 'other', viewer: { type: 'user' } })).status,
      'unavailable',
    );
    const fake = f.messages.append({
      from: { kind: 'agent', catId: producer.catId },
      userId: 'owner',
      threadId: 'origin',
      content: 'fake',
      mentions: [],
      timestamp: 3,
      extra: { rich: { v: 1, blocks: p.published.extra.rich.blocks } },
    });
    assert.equal((await f.service.read(fake.id, block, human)).status, 'unavailable');
    assert.throws(
      () =>
        f.messages.append({
          from: { kind: 'agent', catId: producer.catId },
          userId: 'owner',
          content: 'fake',
          mentions: [],
          timestamp: 4,
          extra: { messageSearchAnswer: p.published.extra.messageSearchAnswer },
        }),
      /dedicated Host/,
    );
  } finally {
    f.db.close();
  }
});
test('withdrawal and revisions suppress saved bodies, and updated ledgers cannot revive an old label', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.request),
      p = await post(f, prepared),
      block = p.published.extra.messageSearchAnswer.blockId;
    f.messages.getById(f.source[0].id).content = 'edited source';
    let read = await f.service.read(p.message.id, block, human);
    assert.equal(read.changedSources, 1);
    assert.ok(!JSON.stringify(read).includes('original source 0'));
    f.setRevision('b'.repeat(40));
    f.dropLedger();
    read = await f.service.read(p.message.id, block, human);
    assert.equal(read.decisionUpdated, true);
    assert.ok(read.response.results.every((row) => !row.decisionSources));
    for (const row of f.source) f.messages.getById(row.id).recall = { version: 1, exposure: 'none', recalledAt: 5 };
    read = await f.service.read(p.message.id, block, human);
    assert.deepEqual(read, { status: 'unavailable' });
    assert.deepEqual(await f.service.prepare(f.request), {
      status: 'unavailable',
      publicationRef: prepared.publicationRef,
    });
    assert.equal(f.searches(), 1);
  } finally {
    f.db.close();
  }
});
test('an unrelated Git commit cannot invalidate an unchanged exact decided-table fact', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.request),
      p = await post(f, prepared);
    f.setRevision('b'.repeat(40));
    const read = await f.service.read(p.message.id, p.published.extra.messageSearchAnswer.blockId, human);
    assert.equal(read.decisionUpdated, false);
    assert.deepEqual(read.response.results[0].decisionSources, prepared.response.results[0].decisionSources);
    assert.equal(f.searches(), 1);
  } finally {
    f.db.close();
  }
});
test('explicit forwarding re-admits the same snapshot and new destination, without copying the original binding', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.request),
      p = await post(f, prepared);
    const selection = { source: { messageId: p.message.id, blockId: p.published.extra.messageSearchAnswer.blockId } };
    const forwarded = await post(f, prepared, {
      threadId: 'forward',
      selection,
      producer: { kind: 'agent_key', id: 'key', catId: 'opus55' },
    });
    assert.equal(forwarded.published.extra.messageSearchAnswer.forwardedFromMessageId, p.message.id);
    assert.equal(
      (await f.service.read(forwarded.message.id, forwarded.published.extra.messageSearchAnswer.blockId, human)).status,
      'available',
    );
    f.threads.get('sources').createdBy = 'another';
    assert.equal(
      (await f.service.read(forwarded.message.id, forwarded.published.extra.messageSearchAnswer.blockId, human)).status,
      'unavailable',
    );
    assert.equal(f.searches(), 1);
  } finally {
    f.db.close();
  }
});
test('the sole response snapshot survives database reopen without TTL, with no second message body copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'j6-answer-')),
    file = join(dir, 'memory.sqlite');
  const f = fixture(file);
  try {
    const prepared = await f.service.prepare({
      ...f.request,
      producer: { kind: 'agent_key', id: 'persistent', catId: producer.catId },
    });
    const digest = f.store.get(prepared.publicationRef).response_digest;
    f.db.close();
    const db = new Database(file);
    try {
      const store = new MessageSearchAnswerPublicationStore(db),
        record = store.get(prepared.publicationRef);
      assert.equal(record.response_digest, digest);
      assert.equal(record.state, 'prepared');
      assert.equal(store.response(record).results.length, 3);
      assert.ok(!Object.keys(record).some((key) => /ttl|expires/i.test(key)));
    } finally {
      db.close();
    }
  } finally {
    if (f.db.open) f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupted or missing result is unavailable on retry and cannot be silently replaced by a new search', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.request);
    f.db
      .prepare('UPDATE message_search_answer_publications SET response_digest=? WHERE publication_ref=?')
      .run('0'.repeat(64), prepared.publicationRef);
    assert.deepEqual(await f.recreate().prepare(f.request), {
      status: 'unavailable',
      publicationRef: prepared.publicationRef,
    });
    assert.equal(f.searches(), 1);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});

test('a forwarded card rechecks its original bound message after asynchronous source admission', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare(f.request),
      original = await post(f, prepared);
    const source = { messageId: original.message.id, blockId: original.published.extra.messageSearchAnswer.blockId };
    const forwarded = await post(f, prepared, { threadId: 'forward', selection: { source } });
    const read = f.search.readAnswerSnapshot.bind(f.search);
    f.search.readAnswerSnapshot = async (...args) => {
      const result = await read(...args);
      f.messages.getById(original.message.id).recall = { version: 1, exposure: 'none', recalledAt: 5 };
      return result;
    };
    assert.deepEqual(
      await f.service.read(forwarded.message.id, forwarded.published.extra.messageSearchAnswer.blockId, human),
      { status: 'unavailable' },
    );
    assert.equal(f.searches(), 1);
  } finally {
    f.db.close();
  }
});

test('a canceled one-time preparation stays failed on retry without another retrieval', async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    const search = f.search.search.bind(f.search);
    f.search.search = async (...args) => {
      const result = await search(...args);
      controller.abort();
      return result;
    };
    await assert.rejects(() => f.service.prepare(f.request, { signal: controller.signal }), { name: 'AbortError' });
    const retry = await f.recreate().prepare(f.request);
    assert.equal(retry.status, 'failed');
    assert.equal(f.searches(), 1);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});

test('producer identity depends on named fields, not JavaScript object property insertion order', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare({
      ...f.request,
      producer: { catId: producer.catId, kind: producer.kind, id: producer.id },
    });
    const actual = response(f);
    const published = await f.service.publishResponse(actual, producer.id);
    assert.equal(published.extra?.messageSearchAnswer?.publicationRef, prepared.publicationRef);
    assert.equal((await f.service.prepare(f.request)).publicationRef, prepared.publicationRef);
    assert.equal(f.searches(), 1);
  } finally {
    f.db.close();
  }
});

test('cancellation during final destination admission cannot leave a prepared result behind', async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    let enter, finish;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const release = new Promise((resolve) => {
      finish = resolve;
    });
    // Pause the real thread store only after the single search has settled.
    const threads = f.threadStore;
    const get = threads.get.bind(threads);
    threads.get = async (id) => {
      if (id === 'origin' && f.searches()) {
        enter();
        await release;
      }
      return get(id);
    };
    const first = f.service.prepare(f.request, { signal: controller.signal });
    await entered;
    controller.abort();
    finish();
    await assert.rejects(() => first, { name: 'AbortError' });
    assert.equal((await f.service.prepare(f.request)).status, 'failed');
    assert.equal(f.searches(), 1);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});
