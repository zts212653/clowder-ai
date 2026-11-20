import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { IEvidenceStore } from '../../src/domains/memory/interfaces.js';
import { LibraryCatalog } from '../../src/domains/memory/LibraryCatalog.js';
import { libraryRoutes } from '../../src/routes/library.js';

test('document offsets page each kind independently and retain total counts and the response shape', async (t) => {
  const db = new Database(':memory:'),
    app = Fastify(),
    catalog = new LibraryCatalog();
  t.after(async () => {
    await app.close();
    db.close();
  });
  db.exec('CREATE TABLE evidence_docs (anchor TEXT, title TEXT, kind TEXT, status TEXT, updated_at TEXT)');
  const insert = db.prepare('INSERT INTO evidence_docs VALUES (?, ?, ?, ?, ?)');
  for (const [kind, count] of [
    ['note', 45],
    ['decision', 25],
  ] as const)
    for (let i = 0; i < count; i++)
      insert.run(`${kind}-${i}`, `${kind} ${i}`, kind, 'active', new Date(i * 1000).toISOString());
  catalog.register({
    id: 'project:pagination',
    kind: 'project',
    name: 'pagination',
    displayName: 'Pagination',
    root: '/tmp/pagination',
    sensitivity: 'internal',
    scannerLevel: 0,
    indexPolicy: { autoRebuild: true },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  });
  await app.register(libraryRoutes, {
    catalog,
    stores: new Map([['project:pagination', { getDb: () => db } as unknown as IEvidenceStore]]),
  });
  const read = async (query = '') => {
    const response = await app.inject({ method: 'GET', url: '/api/library/project%3Apagination/documents' + query });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const first = await read(),
    second = await read('?offset=20'),
    third = await read('?offset=40');
  assert.deepEqual(Object.keys(first).sort(), ['collectionId', 'groups']);
  assert.deepEqual(first, await read('?offset=0'));
  for (const [kind, count] of [
    ['note', 45],
    ['decision', 25],
  ] as const) {
    const groups = [first, second, third].map((page) =>
      page.groups.find((group: { kind: string }) => group.kind === kind),
    );
    assert.deepEqual(
      groups.map((group) => group.count),
      [count, count, count],
    );
    assert.deepEqual(
      groups.map((group) => group.documents.length),
      count === 45 ? [20, 20, 5] : [20, 5, 0],
    );
    assert.deepEqual(
      groups.map((group) => group.hasMore),
      count === 45 ? [true, true, false] : [true, false, false],
    );
    const anchors = groups.flatMap((group) => group.documents.map((document: { anchor: string }) => document.anchor));
    assert.equal(new Set(anchors).size, count);
    assert.deepEqual(Object.keys(groups[0]).sort(), ['count', 'documents', 'hasMore', 'kind']);
    assert.deepEqual(Object.keys(groups[0].documents[0]).sort(), ['anchor', 'status', 'title', 'updatedAt']);
  }
  assert.ok(
    (await read('?offset=1000000')).groups.every(
      (group: { documents: unknown[]; hasMore: boolean }) => !group.documents.length && !group.hasMore,
    ),
  );
  for (const offset of ['-1', '1.5', '1000001', 'nope']) {
    const response = await app.inject({
      method: 'GET',
      url: '/api/library/project%3Apagination/documents?offset=' + offset,
    });
    assert.equal(response.statusCode, 400, response.body);
  }
});
