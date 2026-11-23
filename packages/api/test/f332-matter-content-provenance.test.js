import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { headers, matterCallbackFixture, source } from './helpers/matter-callback-fixture.js';

describe('F332 normalized content provenance through real entrypoints', () => {
  let fixture;
  let sequence = 0;
  beforeEach(async () => {
    fixture = await matterCallbackFixture();
  });
  afterEach(async () => {
    await fixture.app.close();
    await fixture.evidenceStore.close();
  });
  const write = async (payload, caller = 'call-a') => {
    const requestId = `content-provenance-${sequence++}`;
    const owner = caller === 'owner';
    const response = await fixture.app.inject({
      method: 'POST',
      url: owner ? '/api/memory/matters/write' : '/api/callbacks/remember',
      headers: owner
        ? { 'x-test-owner-session': 'owner-a', 'x-csrf-token': 'test-csrf', origin: 'http://localhost:3003' }
        : headers(caller),
      payload: owner
        ? { requestId, ...payload }
        : { clientRequestId: requestId, items: [{ itemId: 'one', target: 'matter', payload }] },
    });
    assert.ok(response.statusCode < 300, response.body);
    if (owner) return response.json();
    const result = response.json().results[0];
    assert.ok(result.statusCode < 300, JSON.stringify(result));
    return result.result;
  };
  const read = async (matterId, history = false) => {
    const response = await fixture.app.inject({
      url: `/api/callbacks/memory-matters/${matterId}?history=${history}`,
      headers: headers('call-b'),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const catalog = async (query) => {
    const response = await fixture.app.inject({
      url: `/api/callbacks/memory-matters?query=${encodeURIComponent(query)}`,
      headers: headers('call-b'),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().items;
  };
  const receipt = async (saved) => {
    const query = new URLSearchParams({ actorKey: saved.writeRef.actorKey, requestId: saved.writeRef.requestId });
    const response = await fixture.app.inject({
      url: `/api/memory/matters/${saved.matter.matterId}/write-receipt?${query}`,
      headers: { 'x-test-owner-session': 'owner-a' },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  for (const [kind, select] of [
    ['thread', ({ threadA }) => ({ threadId: threadA.id })],
    ['message', ({ original }) => ({ threadId: original.threadId, messageId: original.id })],
    ['quotation', ({ original }) => source(original)],
  ]) {
    it(`summary-only correction keeps the exact ${kind} source across invocations and in its receipt`, async () => {
      const created = await write({
        operation: 'create',
        title: 'Preserve source',
        summary: '原来的归纳。',
        sources: [select(fixture)],
      });
      const matterId = created.matter.matterId;
      const initial = await read(matterId);
      fixture.credentials.get('call-b').originTriggerMessageId = fixture.correction.id;
      const corrected = await write(
        {
          operation: 'correct',
          matterId,
          expectedRevision: 1,
          entryId: initial.entries[0].entryId,
          summary: '另一只猫只改归纳。',
        },
        'call-b',
      );
      const current = await read(matterId);
      assert.deepEqual(current.entries[0].source, initial.entries[0].source);
      assert.equal(current.entries[0].summary, '另一只猫只改归纳。');
      assert.deepEqual(current.entries[0].summaryAuthor, { kind: 'agent', catId: 'codex61-sol' });
      const snapshot = await receipt(corrected);
      assert.deepEqual(snapshot.entries[0].source, initial.entries[0].source);
      assert.deepEqual(snapshot.previousEntries[0].source, initial.entries[0].source);
      const history = await read(matterId, true);
      assert.equal(history.entries.find((entry) => entry.entryId === initial.entries[0].entryId).status, 'superseded');
    });
  }

  it('rejects an obsolete correction with stale_revision before looking up its superseded entry', async () => {
    const created = await write({ operation: 'create', title: 'Concurrent correction', summary: '旧归纳。' });
    const matterId = created.matter.matterId;
    const initial = await read(matterId);
    await write({
      operation: 'correct',
      matterId,
      expectedRevision: 1,
      entryId: initial.entries[0].entryId,
      summary: '第一只猫已改。',
    });
    const current = await read(matterId);
    for (const [expectedRevision, entryId, statusCode, error] of [
      [1, initial.entries[0].entryId, 409, 'stale_revision'],
      [1, current.entries[0].entryId, 409, 'stale_revision'],
      [2, 'entry_missing', 404, 'not_available'],
      [2, initial.entries[0].entryId, 404, 'not_available'],
    ]) {
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/api/callbacks/remember',
        headers: headers('call-b'),
        payload: {
          clientRequestId: `concurrent-${sequence++}`,
          items: [
            {
              itemId: 'one',
              target: 'matter',
              payload: {
                operation: 'correct',
                matterId,
                expectedRevision,
                entryId,
                summary: '第二只猫的更正。',
              },
            },
          ],
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json().results[0];
      assert.equal(result.statusCode, statusCode, JSON.stringify(result));
      assert.equal(result.result.error, error);
      assert.deepEqual(await read(matterId), current, 'Rejected changes must not mutate the current page');
    }
  });

  it('source-only quotation correction retains the interpretation in both the page and write receipt', async () => {
    const created = await write({ operation: 'create', title: 'Selected source', summary: '保留这句归纳。' });
    const matterId = created.matter.matterId;
    const initial = await read(matterId);
    const corrected = await write(
      {
        operation: 'correct',
        matterId,
        expectedRevision: 1,
        entryId: initial.entries[0].entryId,
        source: source(fixture.correction),
      },
      'call-b',
    );
    const current = await read(matterId);
    assert.equal(current.entries[0].source.segment, 'body');
    assert.equal(current.entries[0].source.messageId, fixture.correction.id);
    assert.equal(current.entries[0].quote, fixture.correction.content);
    assert.equal(current.entries[0].summary, initial.entries[0].summary);
    assert.deepEqual(current.entries[0].summaryAuthor, initial.entries[0].summaryAuthor);
    const snapshot = await receipt(corrected);
    assert.equal(snapshot.entries[0].summary, initial.entries[0].summary);
    assert.deepEqual(snapshot.entries[0].summaryAuthor, initial.entries[0].summaryAuthor);
  });

  it('description-only compatibility creates a real seed: correcting it updates directory search and retiring clears it', async () => {
    const created = await write({ operation: 'create', title: '会议时间', description: '旧结论：会议周一举行' });
    const matterId = created.matter.matterId;
    const initial = await read(matterId);
    assert.equal(initial.entries[0].summary, '旧结论：会议周一举行');
    await write({
      operation: 'correct',
      matterId,
      expectedRevision: 1,
      entryId: initial.entries[0].entryId,
      summary: '新结论：会议周二举行',
    });
    const current = await read(matterId);
    assert.equal(current.matter.description, '新结论：会议周二举行');
    assert.equal(current.entries[0].summary, current.matter.description);
    assert.equal(current.summaryStatus, undefined);
    assert.deepEqual(await catalog('周一'), []);
    const found = await catalog('周二');
    assert.equal(found[0].matterId, matterId);
    assert.equal(found[0].revision, 2);
    await write({ operation: 'retire_entry', matterId, expectedRevision: 2, entryId: current.entries[0].entryId });
    const retired = await read(matterId);
    assert.equal(retired.matter.description, '');
    assert.equal(retired.matter.descriptionAuthor, undefined);
    assert.deepEqual(await catalog('周二'), []);
    assert.equal((await receipt(created)).descriptionChange.after, '旧结论：会议周一举行');
  });

  it('source-only correction preserves a compatibility description verbatim before a real text rewrite', async () => {
    const description = '  保留原来的归纳空白。\n';
    const created = await write({ operation: 'create', title: 'Formatting', description });
    const matterId = created.matter.matterId;
    const initial = await read(matterId);
    await write(
      {
        operation: 'correct',
        matterId,
        expectedRevision: 1,
        entryId: initial.entries[0].entryId,
        source: { threadId: fixture.threadB.id },
      },
      'call-b',
    );
    const moved = await read(matterId);
    assert.equal(moved.entries[0].summary, initial.entries[0].summary);
    assert.equal(moved.entries[0].source.threadId, fixture.threadB.id);
    assert.equal(moved.matter.description, description);
    assert.deepEqual(moved.matter.descriptionAuthor, initial.matter.descriptionAuthor);
    assert.deepEqual(moved.entries[0].summaryAuthor, initial.entries[0].summaryAuthor);
    await write(
      {
        operation: 'correct',
        matterId,
        expectedRevision: 2,
        entryId: moved.entries[0].entryId,
        summary: '实际改写了归纳。',
        source: { threadId: fixture.threadB.id },
      },
      'call-b',
    );
    const rewritten = await read(matterId);
    assert.equal(rewritten.matter.description, '实际改写了归纳。');
    assert.deepEqual(rewritten.matter.descriptionAuthor, { kind: 'agent', catId: 'codex61-sol' });
  });

  it('explicit description and equal summary stay independent even when both were supplied in the same create', async () => {
    const created = await write({
      operation: 'create',
      title: 'Independent explanation',
      description: '独立说明',
      summary: '独立说明',
    });
    const matterId = created.matter.matterId;
    const initial = await read(matterId);
    await write({
      operation: 'correct',
      matterId,
      expectedRevision: 1,
      entryId: initial.entries[0].entryId,
      summary: '只改条目的归纳',
    });
    const corrected = await read(matterId);
    assert.equal(corrected.matter.description, '独立说明');
    await write({ operation: 'retire_entry', matterId, expectedRevision: 2, entryId: corrected.entries[0].entryId });
    assert.equal((await read(matterId)).matter.description, '独立说明');
  });

  it('an independent append still credits its actual writer even when the words match another entry', async () => {
    const created = await write({ operation: 'create', title: 'Independent entries', summary: '相同的归纳文字。' });
    const matterId = created.matter.matterId;
    const appended = await write(
      { operation: 'append', matterId, expectedRevision: 1, summary: '相同的归纳文字。' },
      'call-b',
    );
    const page = await read(matterId);
    assert.equal(page.entries.length, 2);
    assert.deepEqual(page.matter.descriptionAuthor, { kind: 'agent', catId: 'codex-astra' });
    assert.deepEqual(page.entries.find((entry) => entry.source.threadId === fixture.threadA.id).summaryAuthor, {
      kind: 'agent',
      catId: 'codex-astra',
    });
    const snapshot = await receipt(appended);
    assert.equal(snapshot.entries.length, 1);
    assert.deepEqual(snapshot.entries[0].summaryAuthor, { kind: 'agent', catId: 'codex61-sol' });
  });

  for (const unknown of [false, true]) {
    for (const caller of ['call-b', 'owner']) {
      it(`${caller} changes only the source: retains ${unknown ? 'unknown' : 'known'} content author while recording the actual operator`, async () => {
        const created = await write({ operation: 'create', title: 'Attribution', summary: '归纳内容没有变化。' });
        const matterId = created.matter.matterId;
        if (unknown) {
          const db = fixture.evidenceStore.getDb();
          db.prepare('UPDATE memory_matters SET description_author_json = NULL WHERE matter_id = ?').run(matterId);
          db.prepare('UPDATE memory_matter_entries SET summary_author_json = NULL WHERE matter_id = ?').run(matterId);
        }
        const initial = await read(matterId);
        const saved = await write(
          {
            operation: 'correct',
            matterId,
            expectedRevision: 1,
            entryId: initial.entries[0].entryId,
            source: { threadId: fixture.threadB.id },
          },
          caller,
        );
        const moved = await read(matterId);
        assert.equal(moved.entries[0].summary, initial.entries[0].summary);
        assert.equal(moved.entries[0].source.threadId, fixture.threadB.id);
        const author = unknown ? undefined : { kind: 'agent', catId: 'codex-astra' };
        assert.deepEqual(moved.entries[0].summaryAuthor, author);
        assert.deepEqual(moved.matter.descriptionAuthor, author);
        const snapshot = await receipt(saved);
        const operator =
          caller === 'owner' ? { kind: 'user', userId: 'owner-a' } : { kind: 'agent', catId: 'codex61-sol' };
        assert.deepEqual(snapshot.writer, operator);
        assert.deepEqual(snapshot.entries[0].summaryAuthor, author);
        assert.deepEqual(snapshot.previousEntries[0].summaryAuthor, author);
        const history = await read(matterId, true);
        assert.deepEqual(
          history.entries.find((entry) => entry.entryId === initial.entries[0].entryId).summaryAuthor,
          author,
        );
        await write(
          {
            operation: 'correct',
            matterId,
            expectedRevision: 2,
            entryId: moved.entries[0].entryId,
            summary: '这次确实由操作者重写了。',
            source: { threadId: fixture.threadB.id },
          },
          caller,
        );
        const rewritten = await read(matterId);
        assert.deepEqual(rewritten.entries[0].summaryAuthor, operator);
        assert.deepEqual(rewritten.matter.descriptionAuthor, operator);
        assert.deepEqual((await receipt(saved)).entries[0].summaryAuthor, author);
      });
    }
  }
});
