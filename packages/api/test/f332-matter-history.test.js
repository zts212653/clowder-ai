import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { headers, matterCallbackFixture, source } from './helpers/matter-callback-fixture.js';

describe('F332 current content deduplication and independent historical occurrences', () => {
  let fixture;
  let sequence = 0;
  beforeEach(async () => {
    fixture = await matterCallbackFixture();
  });
  afterEach(async () => {
    await fixture.app.close();
    await fixture.evidenceStore.close();
  });
  const request = (input, caller = 'call-a') =>
    fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-matters/write',
      headers: headers(caller),
      payload: { requestId: `history-${sequence++}`, ...input },
    });
  const write = async (input, caller = 'call-a') => {
    const response = await request(input, caller);
    assert.ok(response.statusCode < 300, response.body);
    return response.json();
  };
  const read = async (matterId, history = false) => {
    const response = await fixture.app.inject({
      url: `/api/callbacks/memory-matters/${matterId}?history=${history}`,
      headers: headers('call-b'),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const snapshot = async (saved) => {
    const query = new URLSearchParams({ actorKey: saved.writeRef.actorKey, requestId: saved.writeRef.requestId });
    const response = await fixture.app.inject({
      url: `/api/memory/matters/${saved.matter.matterId}/write-receipt?${query}`,
      headers: { 'x-test-owner-session': 'owner-a' },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const pair = (kind) => {
    if (kind === 'thread') return [{ threadId: fixture.threadA.id }, { threadId: fixture.threadB.id }];
    if (kind === 'message')
      return [fixture.original, fixture.correction].map((message) => ({
        threadId: message.threadId,
        messageId: message.id,
      }));
    return [source(fixture.original), source(fixture.correction)];
  };

  for (const kind of ['thread', 'message', 'mixed-quote', 'quote-only']) {
    for (const caller of ['call-a', 'call-b']) {
      it(`${kind}: ${caller} can correct A→B→A repeatedly without reactivating history or changing authors`, async () => {
        const sources = pair(kind);
        const summary = kind === 'quote-only' ? undefined : '归纳文字保持不变。';
        const created = await write({ operation: 'create', title: 'Return address', summary, sources: [sources[0]] });
        const matterId = created.matter.matterId;
        const initial = (await read(matterId)).entries[0];
        const entries = [initial];
        const receipts = [created];
        const requests = [];
        for (const index of [1, 0, 1, 0]) {
          const input = {
            operation: 'correct',
            requestId: `cycle-${sequence++}`,
            matterId,
            expectedRevision: entries.length,
            entryId: entries.at(-1).entryId,
            summary,
            source: sources[index],
          };
          receipts.push(await write(input, caller));
          requests.push(input);
          const current = await read(matterId);
          assert.equal(current.entries.length, 1);
          const entry = current.entries[0];
          assert.equal(
            entries.some((old) => old.entryId === entry.entryId),
            false,
            'Never reactivate a past occurrence',
          );
          assert.deepEqual(entry.summaryAuthor, initial.summaryAuthor);
          assert.equal(entry.quote, sources[index].quote);
          if (index === 0) assert.deepEqual(entry.source, initial.source);
          entries.push(entry);
        }
        const history = await read(matterId, true);
        assert.equal(history.entries.length, 5);
        for (let index = 0; index < 4; index++) {
          const old = history.entries.find((entry) => entry.entryId === entries[index].entryId);
          assert.equal(old.status, 'superseded');
          assert.equal(old.supersededBy, entries[index + 1].entryId);
          assert.deepEqual(old.source, entries[index].source);
          assert.equal(old.summary, entries[index].summary);
          assert.deepEqual(old.summaryAuthor, initial.summaryAuthor);
        }
        for (let index = 0; index < receipts.length; index++) {
          const saved = await snapshot(receipts[index]);
          assert.equal(saved.matter.revision, index + 1);
          assert.equal(saved.entries[0].entryId, entries[index].entryId);
          assert.equal(saved.entries[0].summary, entries[index].summary);
          assert.equal(saved.entries[0].quote, entries[index].quote);
          assert.deepEqual(saved.entries[0].summaryAuthor, initial.summaryAuthor);
        }
        for (let index = 0; index < requests.length; index++)
          assert.deepEqual(await write(requests[index], caller), receipts[index + 1]);
        assert.equal((await read(matterId, true)).entries.length, 5, 'Exact old retries never change lifecycle');
        assert.equal((await read(matterId)).matter.revision, 5);
      });
    }
  }

  for (const caller of ['call-a', 'call-b']) {
    it(`${caller} can also rewrite summary A→B→A and back while crediting actual rewrites`, async () => {
      const selected = { threadId: fixture.threadA.id };
      const created = await write({
        operation: 'create',
        title: 'Text history',
        summary: '结论 A',
        sources: [selected],
      });
      const matterId = created.matter.matterId;
      for (const [index, summary] of ['结论 B', '结论 A', '结论 B'].entries()) {
        const current = await read(matterId);
        await write(
          {
            operation: 'correct',
            matterId,
            expectedRevision: index + 1,
            entryId: current.entries[0].entryId,
            summary,
            source: selected,
          },
          caller,
        );
        const changed = await read(matterId);
        const author = { kind: 'agent', catId: caller === 'call-a' ? 'codex-astra' : 'codex61-sol' };
        assert.equal(changed.matter.description, summary);
        assert.deepEqual(changed.entries[0].summaryAuthor, author);
        assert.deepEqual(changed.matter.descriptionAuthor, author);
      }
      assert.equal((await read(matterId, true)).entries.length, 4);
    });
  }

  it('a new validated append after retirement creates a new occurrence; retrying the old retirement does not retire it', async () => {
    const selected = { threadId: fixture.threadA.id };
    const created = await write({ operation: 'create', title: 'Retirement', summary: '同一内容', sources: [selected] });
    const matterId = created.matter.matterId;
    const old = (await read(matterId)).entries[0];
    const retire = {
      operation: 'retire_entry',
      requestId: 'retire-once',
      matterId,
      expectedRevision: 1,
      entryId: old.entryId,
    };
    const retired = await write(retire);
    await write({ operation: 'append', matterId, expectedRevision: 2, summary: old.summary, sources: [selected] });
    assert.deepEqual(await write(retire), retired);
    const page = await read(matterId);
    assert.equal(page.entries.length, 1);
    assert.notEqual(page.entries[0].entryId, old.entryId);
    assert.equal(page.matter.description, '', 'An append does not reattach retired page context');
    const history = await read(matterId, true);
    assert.equal(history.entries.find((entry) => entry.entryId === old.entryId).status, 'retired');
  });

  for (const inactive of ['superseded', 'retired']) {
    it(`an old-format ${inactive} content key does not block a new valid correction`, async () => {
      const [a, b] = pair('thread');
      const created = await write({ operation: 'create', title: 'Old private keys', summary: '归纳', sources: [a] });
      const matterId = created.matter.matterId;
      const first = (await read(matterId)).entries[0];
      const db = fixture.evidenceStore.getDb();
      const originalKey = db
        .prepare('SELECT source_key FROM memory_matter_entries WHERE entry_id = ?')
        .get(first.entryId).source_key;
      if (inactive === 'superseded')
        await write({
          operation: 'correct',
          matterId,
          expectedRevision: 1,
          entryId: first.entryId,
          summary: first.summary,
          source: b,
        });
      else {
        await write({ operation: 'retire_entry', matterId, expectedRevision: 1, entryId: first.entryId });
        await write({ operation: 'append', matterId, expectedRevision: 2, summary: first.summary, sources: [b] });
      }
      db.prepare('UPDATE memory_matter_entries SET source_key = ? WHERE entry_id = ?').run(originalKey, first.entryId);
      const before = await read(matterId);
      await write({
        operation: 'correct',
        matterId,
        expectedRevision: before.matter.revision,
        entryId: before.entries[0].entryId,
        summary: first.summary,
        source: a,
      });
      const restored = await read(matterId, true);
      assert.equal(restored.entries.find((entry) => entry.entryId === first.entryId).status, inactive);
      assert.notEqual(restored.entries.find((entry) => entry.status === 'active').entryId, first.entryId);
    });
  }

  it('still deduplicates active content across multiple inputs and correction into another active entry', async () => {
    const [a, b] = pair('thread');
    const created = await write({ operation: 'create', title: 'Active dedup', summary: '归纳', sources: [a, a, b] });
    const matterId = created.matter.matterId;
    const page = await read(matterId);
    assert.equal(page.entries.length, 2);
    const target = page.entries.find((entry) => entry.source.threadId === a.threadId);
    const other = page.entries.find((entry) => entry.entryId !== target.entryId);
    await write({
      operation: 'correct',
      matterId,
      expectedRevision: 1,
      entryId: other.entryId,
      summary: other.summary,
      source: a,
    });
    await write({ operation: 'append', matterId, expectedRevision: 2, summary: target.summary, sources: [a, a] });
    const current = await read(matterId);
    assert.equal(current.entries.length, 1);
    assert.equal(current.entries[0].entryId, target.entryId);
    assert.equal((await read(matterId, true)).entries.length, 2);
  });

  it('rejects a genuinely unchanged correction with a useful non-selection hint and no revision change', async () => {
    const [selected] = pair('thread');
    const created = await write({ operation: 'create', title: 'No-op', summary: '归纳', sources: [selected] });
    const matterId = created.matter.matterId;
    const old = (await read(matterId)).entries[0];
    const response = await request({
      operation: 'correct',
      matterId,
      expectedRevision: 1,
      entryId: old.entryId,
      summary: old.summary,
      source: selected,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().reason, 'unchanged_entry');
    assert.doesNotMatch(response.json().message, /UTF-16|start\/end|Select exact/);
    assert.equal((await read(matterId)).matter.revision, 1);
    assert.equal((await read(matterId, true)).entries.length, 1);
  });

  it('a failed receipt insert rolls back replacement, dedup key and page revision together', async () => {
    const [a, b] = pair('thread');
    const created = await write({ operation: 'create', title: 'Atomic history', summary: '归纳', sources: [a] });
    const matterId = created.matter.matterId;
    const old = (await read(matterId)).entries[0];
    const db = fixture.evidenceStore.getDb();
    const before = db.prepare('SELECT * FROM memory_matter_entries WHERE matter_id = ?').all(matterId);
    db.exec(
      "CREATE TEMP TRIGGER fail_history_receipt BEFORE INSERT ON memory_matter_requests BEGIN SELECT RAISE(ABORT, 'receipt fault'); END",
    );
    const input = {
      operation: 'correct',
      requestId: 'atomic-retry',
      matterId,
      expectedRevision: 1,
      entryId: old.entryId,
      summary: old.summary,
      source: b,
    };
    assert.equal((await request(input)).statusCode, 500);
    assert.deepEqual(db.prepare('SELECT * FROM memory_matter_entries WHERE matter_id = ?').all(matterId), before);
    assert.equal((await read(matterId)).matter.revision, 1);
    db.exec('DROP TRIGGER fail_history_receipt');
    await write(input);
    assert.equal((await read(matterId, true)).entries.length, 2);
  });
});
