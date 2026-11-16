import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { memoryReadRefSchema } from '@cat-cafe/shared';
import { handleReadMemory } from '../../mcp-server/dist/tools/read-memory-tools.js';
import { formatEntityReadingPointer } from '../dist/domains/memory/entity-reading-pointer.js';
import { GraphQueryResolver } from '../dist/domains/memory/GraphQueryResolver.js';
import { PerspectiveRunner } from '../dist/domains/memory/PerspectiveRunner.js';
import { RecentBrowseResolver } from '../dist/domains/memory/RecentBrowseResolver.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';

test('the same original is directly readable from actual search, graph, recent, perspective and entity producers', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'read-ref-producers-'));
  const saved = process.env.ALLOWED_WORKSPACE_DIRS;
  process.env.ALLOWED_WORKSPACE_DIRS = directory;
  writeFileSync(join(directory, 'original.md'), 'The exact original readrefroundtrip condition.\nSecond line.');
  const store = new SqliteEvidenceStore(':memory:', undefined, { sourceRoot: directory });
  await store.initialize();
  t.after(async () => {
    await store.close();
    if (saved === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
    else process.env.ALLOWED_WORKSPACE_DIRS = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  await store.upsert([
    {
      anchor: 'F332',
      title: 'readrefroundtrip',
      kind: 'feature',
      status: 'active',
      summary: 'readrefroundtrip condition',
      sourcePath: 'original.md',
      updatedAt: new Date().toISOString(),
    },
  ]);
  const catalog = {
    list: () => [{ id: 'project', kind: 'project', sensitivity: 'internal' }],
    get: (id) => (id === 'project' ? { id, kind: 'project', sensitivity: 'internal' } : undefined),
  };
  const stores = new Map([['project', store]]);
  const search = await store.search('readrefroundtrip', { mode: 'lexical' });
  const graph = await new GraphQueryResolver(catalog, stores).resolve('F332');
  const recent = await new RecentBrowseResolver(catalog, stores).list({ since: '7d', limit: 5, scope: 'docs' });
  const perspective = new PerspectiveRunner({
    searchEvidence: (query, options) => store.searchWithMeta(query, options),
    openAnchor: async (candidate) => ({
      anchor: candidate.anchor,
      status: 'route_identified',
      readRef: candidate.readRef,
    }),
  });
  const run = await perspective.run(
    {
      schemaVersion: 1,
      id: 'F332/read',
      title: 'Source route',
      featureIds: ['F332'],
      ownerCatId: 'codex61-sol',
      intent: 'read source',
      steps: [{ id: 'find', type: 'search_evidence', query: 'readrefroundtrip' }],
      outputPolicy: { storesResults: false, returnsConclusion: false, requiresAnchors: true },
    },
    { actorCatId: 'codex61-sol' },
  );
  const pointer = formatEntityReadingPointer(
    {
      source: 'cat-proposed',
      sourcePath: join(directory, 'original.md'),
      note: 'Read the exact condition before applying it.',
    },
    'entity:source',
  );
  const entityRefs = JSON.parse(pointer.match(/ReadRefs: (\[[^\n]+\]);/)[1]);
  const refs = [
    search[0].readRef,
    graph.graph.nodes.find((node) => node.anchor === 'F332').readRef,
    recent.items[0].readRef,
    run.candidateAnchors[0].readRef,
    entityRefs[0],
  ];
  for (const [index, ref] of refs.entries()) {
    assert.ok(memoryReadRefSchema.safeParse(ref).success, `producer ${index} must emit a complete shared ref`);
    const result = await handleReadMemory({ ref });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, 'ok', JSON.stringify(body));
    assert.match(result.content[body.data.contentBlock].text, /exact original readrefroundtrip condition/);
  }
  await store.upsert([
    {
      anchor: 'session-private',
      title: 'privatesessionboundary',
      kind: 'session',
      status: 'active',
      summary: 'privatesessionboundary',
      sourcePath: 'original.md',
      updatedAt: new Date().toISOString(),
    },
  ]);
  assert.equal(
    (await store.getByAnchor('session-private')).readRef,
    undefined,
    'a self-only session must not acquire a generic file reading pointer',
  );
  const sessions = await store.search('privatesessionboundary', { mode: 'lexical', scope: 'sessions' });
  assert.equal(sessions[0].drillDown.tool, 'cat_cafe_read_session_digest');
  assert.equal(sessions[0].readRef, undefined);
});
