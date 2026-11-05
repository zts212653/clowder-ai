import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

test('file-backed refresh and dirty summary agree while full passage indexing keeps the unretained tail', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'thread-summary-projection-'));
  const docs = join(root, 'docs');
  mkdirSync(join(docs, 'features'), { recursive: true });
  const context = { store: new SqliteEvidenceStore(join(root, 'evidence.sqlite')) };
  await context.store.initialize();
  t.after(() => {
    context.store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const thread = { id: 'fixture', title: 'Retained title', participants: ['sol'], lastActiveAt: 1700000000000 };
  let version = 'initial';
  let summaryReads = 0;
  let passageReads = 0;
  const source = (_id, limit) =>
    Array.from({ length: 100 }, (_, i) => ({
      id: `m-${i}`,
      threadId: thread.id,
      timestamp: thread.lastActiveAt + i,
      get content() {
        if (limit === 100) summaryReads++;
        else passageReads++;
        return i ? `tail-${i} ` + 'complete passage '.repeat(300) : `${version} ` + 'prefix '.repeat(1500);
      },
      contentBlocks:
        i === 99
          ? [{ type: 'context_attachment', attachment: { text: 'tail quote', comment: 'tail owner comment' } }]
          : [],
    }));
  let builder = new IndexBuilder(context.store, docs, undefined, undefined, () => [thread], source);
  await builder.rebuild();
  let row = await context.store.getByAnchor('thread-fixture');
  assert.equal(summaryReads, 1);
  assert.equal(passageReads, 100);
  assert.equal(row.summary, `[user] initial ${'prefix '.repeat(1500).trim()}`.slice(0, 2997) + '...');
  const tail = context.store
    .getDb()
    .prepare('SELECT content FROM evidence_passages WHERE passage_id=?')
    .get('msg-m-99').content;
  assert.ok(tail.length > 3000);
  assert.ok(tail.endsWith('tail quote\ntail owner comment'));
  context.store.close();
  context.store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await context.store.initialize();
  builder = new IndexBuilder(context.store, docs, undefined, undefined, () => [thread], source);
  version = 'updated';
  summaryReads = 0;
  passageReads = 0;
  builder.markThreadDirty(thread.id);
  assert.equal(await builder.flushDirtyThreads(), 1);
  row = await context.store.getByAnchor('thread-fixture');
  assert.equal(summaryReads, 1);
  assert.equal(passageReads, 100);
  assert.equal(row.summary, `[user] updated ${'prefix '.repeat(1500).trim()}`.slice(0, 2997) + '...');
  const hash = row.sourceHash;
  summaryReads = 0;
  passageReads = 0;
  await builder.refreshThreadIndex({ force: true });
  assert.equal((await context.store.getByAnchor('thread-fixture')).sourceHash, hash);
  assert.equal(summaryReads, 1);
  assert.equal(passageReads, 100);
  assert.equal(context.store.getDb().prepare('SELECT count(*) AS n FROM evidence_passages').get().n, 100);
});
