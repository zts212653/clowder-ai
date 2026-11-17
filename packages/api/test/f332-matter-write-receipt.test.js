import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { headers, matterCallbackFixture, source } from './helpers/matter-callback-fixture.js';

describe('F332 per-write matter receipts', () => {
  let fixture;
  let sequence = 0;
  beforeEach(async () => {
    fixture = await matterCallbackFixture();
  });
  afterEach(async () => {
    await fixture.app.close();
    await fixture.evidenceStore.close();
  });
  const remember = async (payload) => {
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/remember',
      headers: headers('call-a'),
      payload: { clientRequestId: `receipt-${sequence++}`, items: [{ itemId: 'one', target: 'matter', payload }] },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const saved = (result) => {
    assert.ok(result.results[0].statusCode < 300, JSON.stringify(result));
    return result.results[0].result;
  };
  const readReceipt = (result, userId = 'owner-a') => {
    const query = new URLSearchParams({
      actorKey: result.writeRef?.actorKey ?? 'missing',
      requestId: result.writeRef?.requestId ?? 'missing',
    });
    return fixture.app.inject({
      url: `/api/memory/matters/${result.matter.matterId}/write-receipt?${query}`,
      headers: userId ? { 'x-test-owner-session': userId } : {},
    });
  };
  it('freezes create, appended text and description edits separately, with content-free group references', async () => {
    const created = saved(
      await remember({
        operation: 'create',
        title: 'Original title',
        summary: 'First summary',
        sources: [{ threadId: fixture.threadA.id }],
      }),
    );
    const matterId = created.matter.matterId;
    const appendedResult = await remember({
      operation: 'append',
      matterId,
      expectedRevision: 1,
      sources: [source(fixture.original)],
    });
    const appended = saved(appendedResult);
    const edited = saved(
      await remember({
        operation: 'edit',
        matterId,
        expectedRevision: 2,
        title: 'Later title',
        description: 'First summary\nA later sixth item',
      }),
    );
    const first = await readReceipt(created),
      second = await readReceipt(appended),
      third = await readReceipt(edited);
    for (const response of [first, second, third]) assert.equal(response.statusCode, 200, response.body);
    assert.equal(first.json().matter.title, 'Original title');
    assert.equal(first.json().matter.revision, 1);
    assert.equal(first.json().entries[0].summary, 'First summary');
    assert.equal(second.json().operation, 'append');
    assert.equal(second.json().matter.revision, 2);
    assert.equal(second.json().entries.length, 1);
    assert.equal(second.json().entries[0].quote, fixture.original.content);
    assert.equal(JSON.stringify(second.json()).includes('sixth'), false);
    assert.deepEqual(third.json().descriptionChange, {
      before: 'First summary',
      after: 'First summary\nA later sixth item',
      author: { kind: 'agent', catId: 'codex-astra' },
    });
    const message = await fixture.messageStore.getById(appendedResult.messageId);
    const row = message.extra.rich.blocks[0].meta.memoryGroup.rows[0];
    assert.deepEqual(row.matterWriteRef, appended.writeRef);
    assert.equal(JSON.stringify(message).includes(fixture.original.content), false);
    assert.equal(JSON.stringify(row).includes('First summary'), false);
    fixture.messageStore.getById(fixture.original.id).content += ' changed after the write';
    const changed = await readReceipt(appended);
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().sourcesChanged, true);
    assert.equal(changed.json().entries[0].sourceStatus, 'changed');
    assert.equal(changed.json().entries[0].quote, undefined);
    assert.equal(JSON.stringify(changed.json()).includes('changed after the write'), false);
    assert.equal((await readReceipt(appended, 'owner-b')).statusCode, 404);
    assert.equal((await readReceipt(appended, null)).statusCode, 401);
  });

  it('denies unreadable sources and purges saved write content when the owner forgets the page', async () => {
    const created = saved(
      await remember({
        operation: 'create',
        title: 'Private',
        summary: 'Sensitive stored interpretation',
        sources: [source(fixture.original)],
      }),
    );
    assert.equal((await readReceipt(created)).statusCode, 200);
    fixture.threadStore.get(fixture.threadA.id).deletedAt = 10;
    assert.equal((await readReceipt(created)).statusCode, 404);
    fixture.threadStore.get(fixture.threadA.id).deletedAt = undefined;
    const forgotten = await fixture.app.inject({
      method: 'POST',
      url: '/api/memory/matters/write',
      headers: {
        'x-test-owner-session': 'owner-a',
        'x-csrf-token': 'test-csrf',
        origin: 'http://localhost:3003',
        'x-requested-with': 'XMLHttpRequest',
      },
      payload: {
        operation: 'forget',
        requestId: 'forget-receipt',
        matterId: created.matter.matterId,
        expectedRevision: 1,
      },
    });
    assert.equal(forgotten.statusCode, 200, forgotten.body);
    assert.equal((await readReceipt(created)).statusCode, 404);
    const rows = fixture.evidenceStore
      .getDb()
      .prepare('SELECT result_json FROM memory_matter_requests WHERE matter_id = ?')
      .all(created.matter.matterId);
    assert.equal(JSON.stringify(rows).includes('Sensitive stored interpretation'), false);
    assert.equal(JSON.stringify(rows).includes('snapshot'), false);
  });

  it('a failed write never publishes a saved-content heading or a successful receipt reference', async () => {
    const failed = await remember({
      operation: 'create',
      title: 'Invalid source',
      sources: [{ ...source(fixture.original), quote: 'not original words' }],
    });
    assert.equal(failed.results[0].statusCode, 400);
    const message = await fixture.messageStore.getById(failed.messageId);
    const block = message.extra.rich.blocks[0];
    assert.equal(block.title, '这次记忆提交结果');
    assert.equal(block.meta.memoryGroup.rows[0].matterWriteRef, undefined);
  });
});
