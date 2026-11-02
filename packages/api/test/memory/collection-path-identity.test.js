// #1451 review 5197794663: exercise the actual producer, index, search,
// perspective graph projection and typed reader, not a copy of their algorithms.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import Fastify from 'fastify';
import { handleReadFileSlice } from '../../../mcp-server/dist/tools/file-tools.js';
import { BindingDryRun } from '../../dist/domains/memory/BindingDryRun.js';
import { CollectionIndexBuilder } from '../../dist/domains/memory/CollectionIndexBuilder.js';
import { FlatScanner } from '../../dist/domains/memory/FlatScanner.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { perspectiveRoutes } from '../../dist/routes/perspectives.js';

it('keeps POSIX literal backslashes out of slash-based excludes', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'issue1450-posix-filter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'private'));
  writeFileSync(join(root, 'private', 'secret.md'), '# Excluded');
  writeFileSync(join(root, 'private\\secret.md'), 'aws_key: AKIAIOSFODNN7EXAMPLE');
  writeFileSync(join(root, '..\\outside.md'), '# A literal filename inside root');
  const exclude = ['private/**'];
  const scanner = new FlatScanner('probe', exclude);
  const items = scanner.discover(root).map((r) => r.item);
  assert.deepEqual(items.map((item) => item.sourcePath).sort(), ['..\\outside.md', 'private\\secret.md']);
  assert.equal(new Set(items.map((item) => item.anchor)).size, 2);
  assert.equal(BindingDryRun.run(root, { exclude }).safe, false);
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  const manifest = { id: 'probe', root, reviewPolicy: { authorityCeiling: 'validated' } };
  const result = await new CollectionIndexBuilder(store, manifest, scanner).rebuild();
  assert.equal(result.blocked, true, 'a slash-based exclude must not hide a different literal POSIX filename');
  assert.equal(result.secretFindings[0].file, 'private\\secret.md');
});

it('keeps native paths through filtering, indexing, search, graph and file reading', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'issue1450-identity-'));
  const root = join(dataDir, 'root');
  const previousDataDir = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'foo'), { recursive: true });
  mkdirSync(join(root, 'private'));
  mkdirSync(join(dataDir, 'library'));
  writeFileSync(join(root, 'private', 'secret.md'), 'token = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
  const paths = ['foo/bar.md', ...(process.platform === 'win32' ? [] : ['foo\\bar.md'])];
  paths.forEach((path, index) => writeFileSync(join(root, path), `# Needle ${index}\n\nUnique document ${index}`));
  const manifest = {
    id: 'probe',
    kind: 'domain',
    name: 'probe',
    displayName: 'Probe',
    root,
    sensitivity: 'internal',
    scannerLevel: 0,
    exclude: ['private/**'],
    indexPolicy: { autoRebuild: false },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: '2026-11-03',
    updatedAt: '2026-11-03',
  };
  writeFileSync(join(dataDir, 'library', 'collections.json'), JSON.stringify([manifest]));
  const scanner = new FlatScanner('probe', manifest.exclude);
  const discovered = scanner.discover(root);
  assert.deepEqual(discovered.map((r) => r.item.sourcePath).sort(), [...paths].sort());
  assert.equal(new Set(discovered.map((r) => r.item.anchor)).size, paths.length);
  assert.equal(BindingDryRun.run(root, { exclude: manifest.exclude }).safe, true);
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  const result = await new CollectionIndexBuilder(store, manifest, scanner).rebuild();
  assert.equal(result.blocked, false);
  assert.equal(result.indexed, paths.length);
  await new CollectionIndexBuilder(store, manifest, scanner).incrementalUpdate([join(root, 'private', 'secret.md')]);
  assert.equal(await store.getByAnchor('probe:doc/private/secret'), null);
  const hits = await store.search('Needle', { scope: 'docs', mode: 'lexical', limit: 10 });
  assert.equal(hits.length, paths.length);
  const uris = new Set();
  const expectedUris = new Map([
    ['foo/bar.md', 'cat-cafe://collection/probe/foo/bar.md'],
    ['foo\\bar.md', 'cat-cafe://collection/probe/foo%5Cbar.md'],
  ]);
  for (const item of hits) {
    const uri = expectedUris.get(item.sourcePath);
    assert.ok(uri);
    assert.equal(item.drillDown.params.path, uri);
    uris.add(uri);
    const read = await handleReadFileSlice({ path: uri, startLine: 1, endLine: 3 });
    assert.equal(read.isError, undefined);
    assert.ok(read.content[0].text.includes(item.title));
  }
  assert.equal(uris.size, paths.length);

  const planDir = join(root, 'docs', 'perspectives', 'F209');
  mkdirSync(planDir, { recursive: true });
  const openedPaths = [];
  const app = Fastify();
  await app.register(perspectiveRoutes, {
    repoRoot: root,
    graphCatalog: { list: () => [manifest], get: (id) => (id === 'probe' ? manifest : undefined) },
    graphStores: new Map([['probe', store]]),
    openAnchor: async (candidate) => {
      openedPaths.push(candidate.drillDown.params.path);
      const read = await handleReadFileSlice({ path: candidate.drillDown.params.path, startLine: 1, endLine: 3 });
      assert.equal(read.isError, undefined);
      const indexed = hits.find((item) => item.anchor === candidate.anchor);
      assert.ok(indexed);
      assert.ok(read.content[0].text.includes(indexed.title));
      return {
        anchor: candidate.anchor,
        status: 'route_identified',
        tool: candidate.drillDown.tool,
        content: read.content[0].text,
      };
    },
  });
  t.after(() => app.close());
  for (const hit of hits) {
    writeFileSync(
      join(planDir, 'probe.md'),
      `---
schemaVersion: 1
id: F209/probe
title: Path identity
featureIds: [F209]
ownerCatId: codex
intent: Read the exact indexed document
steps:
  - id: graph
    type: graph_resolve
    anchor: ${JSON.stringify(hit.anchor)}
    depth: 1
  - id: open
    type: open_anchor
    source: previous_step
    selector: top
    maxOpen: 1
outputPolicy:
  storesResults: false
  returnsConclusion: false
  requiresAnchors: true
---
`,
    );
    const response = await app.inject('/api/perspectives/F209/probe/run');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().warnings, []);
  }
  assert.deepEqual(new Set(openedPaths), uris);
});
