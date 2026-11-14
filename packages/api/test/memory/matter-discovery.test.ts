import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MatterMemoryService } from '../../src/domains/memory/matters/MatterMemoryService.js';
import { SqliteEvidenceStore } from '../../src/domains/memory/SqliteEvidenceStore.js';

test('Matter query and first page project bounded index candidates, not the whole directory', async () => {
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  const actor = { userId: 'owner', viewer: { type: 'user' as const } };
  const messages = new Map<
    string,
    {
      id: string;
      threadId: string;
      userId: string;
      catId: null;
      content: string;
      timestamp: number;
      mentions: string[];
    }
  >();
  let sourceReads = 0;
  const service = new MatterMemoryService({
    db: evidence.getDb(),
    runWrite: (operation) => evidence.runExclusive(operation),
    messageStore: {
      getById: (id) => {
        sourceReads++;
        return messages.get(id) ?? null;
      },
    },
    threadStore: { get: (id) => ({ id, createdBy: 'owner' }), list: () => [] },
  });
  try {
    let needle: string | undefined;
    for (let i = 0; i < 45; i++) {
      const id = `m${i}`;
      messages.set(id, {
        id,
        threadId: 't',
        userId: 'owner',
        catId: null,
        content: 'source',
        timestamp: i,
        mentions: [],
      });
      const receipt = await service.write(actor, {
        operation: 'create',
        requestId: id,
        title: i === 44 ? 'NEEDLE 归一' : `ordinary ${i}`,
        description: '条件原样保留',
        sources: [{ threadId: 't', messageId: id, segment: 'body', start: 0, end: 6, quote: 'source' }],
      });
      if (i === 44) needle = receipt.matter.matterId;
    }
    sourceReads = 0;
    const found = await service.catalog(actor, { query: 'needle 归一', limit: 2 });
    assert.deepEqual(
      found.items.map((item) => item.matterId),
      [needle],
    );
    assert.ok(sourceReads <= 2, `query read ${sourceReads} sources`);
    sourceReads = 0;
    const first = await service.catalog(actor, { limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    assert.ok(sourceReads <= 6, `first page read ${sourceReads} sources`);
    await service.write(actor, {
      operation: 'edit',
      requestId: 'rename',
      matterId: needle!,
      expectedRevision: 1,
      title: 'replacement',
      description: 'new conditions',
    });
    assert.deepEqual((await service.catalog(actor, { query: 'needle' })).items, []);
    assert.equal((await service.catalog(actor, { query: 're' })).items[0]?.matterId, needle);
    assert.equal((await service.catalog(actor, { query: 'REPLACEMENT' })).items[0]?.revision, 2);
    await service.write(actor, { operation: 'forget', requestId: 'forget', matterId: needle!, expectedRevision: 2 });
    assert.deepEqual((await service.catalog(actor, { query: 'replacement' })).items, []);
    assert.deepEqual(
      evidence.getDb().prepare("SELECT rowid FROM memory_matter_search WHERE text MATCH 'replacement'").all(),
      [],
    );
    assert.equal(evidence.getDb().prepare('SELECT count(*) AS n FROM memory_matters').get().n, 44);
  } finally {
    await evidence.close();
  }
});

test('a directory can continue past a private candidate budget without exposing its progress', async () => {
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  const owner = { userId: 'owner', viewer: { type: 'user' as const } };
  const reader = { userId: 'owner', viewer: { type: 'cat' as const, catId: 'codex-astra' } };
  const privateMessage = {
    id: 'private',
    threadId: 't',
    userId: 'owner',
    catId: null,
    content: 'private source',
    timestamp: 1,
    visibility: 'whisper' as const,
    whisperTo: ['codex61-sol'],
  };
  const publicMessage = {
    id: 'public',
    threadId: 't',
    userId: 'owner',
    catId: null,
    content: 'public source',
    timestamp: 1,
  };
  const service = new MatterMemoryService({
    db: evidence.getDb(),
    runWrite: (operation) => evidence.runExclusive(operation),
    messageStore: { getById: (id) => (id === 'private' ? privateMessage : publicMessage) },
    threadStore: { get: (id) => ({ id, createdBy: 'owner' }), list: () => [] },
  });
  const write = (id: string, text: string) =>
    service.write(owner, {
      operation: 'create',
      requestId: id,
      title: `hidden ${id}`,
      description: '',
      sources: [{ threadId: 't', messageId: id, segment: 'body', start: 0, end: text.length, quote: text }],
    });
  try {
    const original = await write('private', privateMessage.content);
    const source = service.store.entries(original.matter.matterId)[0]!.source;
    for (let i = 0; i < 1000; i++)
      service.store.write(
        'owner',
        'owner',
        {
          operation: 'create',
          requestId: `private-${i}`,
          title: `hidden private ${i}`,
          description: '',
          sources: [],
        },
        [source],
      );
    const visible = await write('public', publicMessage.content);
    evidence.getDb().prepare('UPDATE memory_matters SET updated_at = 100').run();
    evidence
      .getDb()
      .prepare('UPDATE memory_matters SET updated_at = 1 WHERE matter_id = ?')
      .run(visible.matter.matterId);
    const first = await service.catalog(reader, { query: 'hidden', limit: 2 });
    assert.deepEqual(first.items, []);
    assert.ok(first.nextCursor);
    const cursor = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
    assert.equal(typeof cursor.progress, 'string');
    assert.equal(cursor.after, null);
    assert.doesNotMatch(JSON.stringify(cursor), /private|1000|offset/);
    const second = await service.catalog(reader, { query: 'hidden', limit: 2, cursor: first.nextCursor });
    assert.deepEqual(
      second.items.map((item) => item.matterId),
      [visible.matter.matterId],
    );
    assert.equal(second.nextCursor, undefined);
    cursor.progress = `!${cursor.progress.slice(1)}`;
    await assert.rejects(
      service.catalog(reader, { query: 'hidden', cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') }),
      /invalid_cursor/,
    );
  } finally {
    await evidence.close();
  }
});
