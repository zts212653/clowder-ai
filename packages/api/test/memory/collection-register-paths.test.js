import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import Fastify from 'fastify';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { LibraryCatalog } from '../../dist/domains/memory/LibraryCatalog.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { libraryRoutes } from '../../dist/routes/library.js';

it('registers a native child collection without retaining its rows in the parent index', async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'issue1450-register-'));
  const root = join(fixture, 'docs');
  const child = join(root, 'library', 'finance');
  mkdirSync(join(root, 'features'), { recursive: true });
  mkdirSync(child, { recursive: true });
  writeFileSync(join(root, 'features', 'F001-parent.md'), '---\nfeature_ids: [F001]\n---\n# Parent');
  writeFileSync(join(child, 'report.md'), '# Child finance');
  const app = Fastify();
  const parentStore = new SqliteEvidenceStore(':memory:');
  const stores = new Map([['project:cat-cafe', parentStore]]);
  t.after(async () => {
    await app.close();
    stores.forEach((store) => store.close());
    rmSync(fixture, { recursive: true, force: true });
  });
  await parentStore.initialize();
  const builder = new IndexBuilder(parentStore, root);
  await builder.rebuild();
  await parentStore.upsert([
    {
      anchor: 'old-child-row',
      kind: 'research',
      status: 'active',
      title: 'Historical child row',
      sourcePath: 'library/finance/report.md',
      updatedAt: '2026-11-03',
    },
  ]);
  const catalog = new LibraryCatalog();
  catalog.register({
    id: 'project:cat-cafe',
    root,
    name: 'parent',
    displayName: 'Parent',
    kind: 'project',
    sensitivity: 'internal',
    scannerLevel: 0,
    exclude: [],
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: '2026-11-03',
    updatedAt: '2026-11-03',
  });
  await app.register(libraryRoutes, {
    catalog,
    stores,
    indexBuilder: builder,
    parentRoot: root,
    dataDir: join(fixture, 'data'),
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/library/register',
    remoteAddress: '127.0.0.1',
    payload: {
      id: 'domain:finance',
      kind: 'domain',
      name: 'finance',
      displayName: 'Finance',
      root: child,
      sensitivity: 'internal',
      scannerLevel: 0,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(catalog.get('project:cat-cafe').exclude, ['library/finance/**']);
  assert.equal(await parentStore.getByAnchor('old-child-row'), null);
  assert.ok(await parentStore.getByAnchor('F001'));
  await builder.incrementalUpdate([join(child, 'report.md')]);
  assert.equal(
    parentStore
      .getDb()
      .prepare("SELECT count(*) AS n FROM evidence_docs WHERE source_path LIKE 'library/finance/%'")
      .get().n,
    0,
  );
});
