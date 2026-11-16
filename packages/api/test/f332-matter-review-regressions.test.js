import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { headers, matterCallbackFixture, source } from './helpers/matter-callback-fixture.js';

describe('F332 review: persisted privacy, actual authors and description ownership', () => {
  let fixture;
  let sequence = 0;
  beforeEach(async () => {
    fixture = await matterCallbackFixture();
  });
  afterEach(async () => {
    await fixture.app.close();
    await fixture.evidenceStore.close();
  });
  const write = async (input, caller = 'call-a') => {
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-matters/write',
      headers: headers(caller),
      payload: { requestId: `review-${sequence++}`, ...input },
    });
    assert.ok(response.statusCode < 300, response.body);
    return response.json();
  };
  const read = async (id, caller = 'call-a') => {
    const response = await fixture.app.inject({ url: `/api/callbacks/memory-matters/${id}`, headers: headers(caller) });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  it('explicit public return addresses cannot erase an authoritative private trigger, including page-only edits', async () => {
    const { threadA, original, credentials, messageStore, app } = fixture;
    const privateTrigger = messageStore.append({
      from: { kind: 'user', userId: 'owner-a' },
      userId: 'owner-a',
      threadId: threadA.id,
      content: 'Private instruction',
      mentions: [],
      timestamp: 5000,
      visibility: 'whisper',
      whisperTo: ['codex-astra'],
    });
    credentials.get('call-a').originTriggerMessageId = privateTrigger.id;
    for (const sources of [
      undefined,
      [{ threadId: threadA.id }],
      [{ threadId: threadA.id, messageId: original.id }],
      [source(original)],
    ]) {
      const created = await write({
        operation: 'create',
        title: 'Private interpretation',
        summary: 'The private fact',
        ...(sources ? { sources } : {}),
      });
      const id = created.matter.matterId;
      await read(id);
      const denied = await app.inject({ url: `/api/callbacks/memory-matters/${id}`, headers: headers('call-b') });
      assert.equal(denied.statusCode, 404, `explicit sources must retain private provenance: ${denied.body}`);
      assert.equal(JSON.stringify(denied.json()).includes('Private'), false);
    }
    credentials.get('call-a').originTriggerMessageId = original.id;
    const publicPage = await write({
      operation: 'create',
      title: 'Public',
      summary: 'Public note',
      sources: [{ threadId: threadA.id }],
    });
    await read(publicPage.matter.matterId, 'call-b');
    credentials.get('call-a').originTriggerMessageId = privateTrigger.id;
    await write({
      operation: 'edit',
      matterId: publicPage.matter.matterId,
      expectedRevision: 1,
      title: 'Private title',
      description: 'Private explanation',
    });
    assert.equal(
      (
        await app.inject({
          url: `/api/callbacks/memory-matters/${publicPage.matter.matterId}`,
          headers: headers('call-b'),
        })
      ).statusCode,
      404,
    );
    const catalog = await app.inject({ url: '/api/callbacks/memory-matters', headers: headers('call-b') });
    assert.deepEqual(catalog.json(), { items: [] });
  });

  for (const operation of ['correct', 'retire_entry']) {
    it(`${operation} does not associate an independent description by equal text`, async () => {
      const description = '独立说明保持不变';
      const created = await write({
        operation: 'create',
        title: 'Independent',
        description,
        sources: [source(fixture.original)],
      });
      const matterId = created.matter.matterId;
      await write({
        operation: 'append',
        matterId,
        expectedRevision: 1,
        summary: description,
        sources: [{ threadId: fixture.threadA.id }],
      });
      const previous = (await read(matterId)).entries.find((entry) => entry.summary);
      await write({
        operation,
        matterId,
        expectedRevision: 2,
        entryId: previous.entryId,
        ...(operation === 'correct' ? { summary: 'New interpretation', source: { threadId: fixture.threadA.id } } : {}),
      });
      const page = await read(matterId);
      assert.equal(page.matter.description, description);
      assert.deepEqual(page.matter.descriptionAuthor, { kind: 'agent', catId: 'codex-astra' });
    });
  }

  it('tracks only the actual initial description entry across multiple sources and detaches after an independent edit', async () => {
    const created = await write({
      operation: 'create',
      title: 'Multiple sources',
      summary: 'Seed summary',
      sources: [{ threadId: fixture.threadA.id }, { threadId: fixture.threadB.id }],
    });
    const matterId = created.matter.matterId;
    const page = await read(matterId);
    const seed = page.entries.find((entry) => entry.source.threadId === fixture.threadA.id);
    const other = page.entries.find((entry) => entry.source.threadId === fixture.threadB.id);
    await write({
      operation: 'correct',
      matterId,
      expectedRevision: 1,
      entryId: other.entryId,
      summary: 'Other source changed',
      source: { threadId: fixture.threadB.id },
    });
    assert.equal((await read(matterId)).matter.description, 'Seed summary');
    await write(
      { operation: 'edit', matterId, expectedRevision: 2, title: 'Edited', description: 'Independent explanation' },
      'call-b',
    );
    await write({
      operation: 'correct',
      matterId,
      expectedRevision: 3,
      entryId: seed.entryId,
      summary: 'Independent explanation',
      source: { threadId: fixture.threadA.id },
    });
    const changed = await read(matterId);
    assert.equal(changed.matter.description, 'Independent explanation');
    assert.deepEqual(changed.matter.descriptionAuthor, { kind: 'agent', catId: 'codex61-sol' });
    const replacement = changed.entries.find((entry) => entry.summary === 'Independent explanation');
    await write({ operation: 'retire_entry', matterId, expectedRevision: 4, entryId: replacement.entryId });
    assert.equal((await read(matterId)).matter.description, 'Independent explanation');
  });

  for (const historical of [false, true]) {
    it(`title-only edits preserve ${historical ? 'unknown historical' : 'known'} description authors`, async () => {
      const created = await write({
        operation: 'create',
        title: 'Before',
        summary: 'Same interpretation',
        sources: [{ threadId: fixture.threadA.id }],
      });
      const matterId = created.matter.matterId;
      if (historical)
        fixture.evidenceStore
          .getDb()
          .prepare('UPDATE memory_matters SET description_author_json = NULL WHERE matter_id = ?')
          .run(matterId);
      const before = await read(matterId);
      await write(
        { operation: 'edit', matterId, expectedRevision: 1, title: 'After', description: before.matter.description },
        'call-b',
      );
      assert.deepEqual((await read(matterId)).matter.descriptionAuthor, before.matter.descriptionAuthor);
    });
  }

  it('counts both the summary and the exact excerpt actually returned by a mixed-entry read', async () => {
    const created = await write({
      operation: 'create',
      title: 'Mixed',
      summary: 'Cat interpretation',
      sources: [source(fixture.original)],
    });
    const page = await read(created.matter.matterId, 'call-b');
    assert.equal(page.entries[0].quote, fixture.original.content);
    const response = await fixture.app.inject({
      url: `/api/threads/${fixture.threadB.id}/invocations/call-b/memory-cues`,
      headers: { 'x-test-owner-session': 'owner-a' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().cues[0].matterRead.summaryCount, 1);
    assert.equal(response.json().cues[0].matterRead.messageCount, 1);
  });

  for (const unknown of [false, true]) {
    it(`source-only correction preserves both ${unknown ? 'unknown' : 'known'} summary authors and advances the description link`, async () => {
      const created = await write({
        operation: 'create',
        title: 'Seeded context',
        summary: 'Unchanged interpretation',
        sources: [{ threadId: fixture.threadA.id }],
      });
      const matterId = created.matter.matterId;
      if (unknown) {
        fixture.evidenceStore
          .getDb()
          .prepare('UPDATE memory_matters SET description_author_json = NULL WHERE matter_id = ?')
          .run(matterId);
        fixture.evidenceStore
          .getDb()
          .prepare('UPDATE memory_matter_entries SET summary_author_json = NULL WHERE matter_id = ?')
          .run(matterId);
      }
      const initial = (await read(matterId)).entries[0];
      await write(
        {
          operation: 'correct',
          matterId,
          expectedRevision: 1,
          entryId: initial.entryId,
          summary: initial.summary,
          source: { threadId: fixture.threadB.id },
        },
        'call-b',
      );
      const corrected = await read(matterId);
      assert.deepEqual(
        corrected.matter.descriptionAuthor,
        unknown ? undefined : { kind: 'agent', catId: 'codex-astra' },
      );
      assert.deepEqual(corrected.entries[0].summaryAuthor, initial.summaryAuthor);
      await write({
        operation: 'correct',
        matterId,
        expectedRevision: 2,
        entryId: corrected.entries[0].entryId,
        summary: 'Actually rewritten context',
        source: { threadId: fixture.threadB.id },
      });
      const rewritten = await read(matterId);
      assert.equal(rewritten.matter.description, 'Actually rewritten context');
      assert.deepEqual(rewritten.matter.descriptionAuthor, { kind: 'agent', catId: 'codex-astra' });
    });
  }

  it('the correction payload produced by the mixed-entry form keeps the verified quotation', async () => {
    const created = await write({
      operation: 'create',
      title: 'Mixed correction',
      summary: 'First interpretation',
      sources: [source(fixture.original)],
    });
    const matterId = created.matter.matterId;
    const old = (await read(matterId)).entries[0];
    await write(
      {
        operation: 'correct',
        matterId,
        expectedRevision: 1,
        entryId: old.entryId,
        summary: 'Corrected interpretation',
        source: source(fixture.original),
      },
      'call-b',
    );
    const page = await read(matterId);
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].summary, 'Corrected interpretation');
    assert.equal(page.entries[0].quote, fixture.original.content);
    assert.equal(page.entries[0].source.segment, 'body');
    assert.equal(page.entries[0].source.start, 0);
    assert.equal(page.entries[0].source.end, fixture.original.content.length);
  });
});
