import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveProjectCollectionId } from '../../dist/domains/memory/bootstrap-collection-bridge.js';
import { ContextProjectCueSource } from '../../dist/domains/memory/cue/sources/ContextProjectCueSource.js';

function fixture(t, external = false) {
  const root = mkdtempSync(join(tmpdir(), 'f321-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const docs = external ? join(root, 'external') : join(root, 'docs');
  mkdirSync(docs);
  const body = '# A current reusable experience\nDo the prior approved sequence.';
  writeFileSync(join(docs, 'lesson.md'), body);
  const projectPath = external ? docs : root;
  const id = external ? deriveProjectCollectionId(projectPath) : 'project:cat-cafe';
  const manifest = {
    id,
    kind: 'project',
    root: docs,
    status: 'active',
    sensitivity: 'private',
    ownerUserId: 'owner',
    updatedAt: '2026-10-20',
  };
  const thread = { createdBy: 'owner', projectPath };
  const item = {
    anchor: 'runbook:lesson',
    status: 'active',
    sourcePath: 'lesson.md',
    sourceHash: createHash('sha256').update(body).digest('hex'),
  };
  const calls = [];
  const result = {
    meta: { degraded: false, effectiveMode: 'hybrid' },
    collectionGroups: [{ collectionId: id, status: 'ok' }],
    results: [item],
  };
  const source = new ContextProjectCueSource({
    threads: { get: async () => thread },
    catalog: { get: (key) => (key === id ? manifest : null) },
    stores: new Map([
      [
        id,
        {
          getByAnchor: async (key) => (key === item.anchor ? item : null),
          getIndexedSourceRevision: async () => ({
            sourceHash: item.sourceHash,
            vectorSourceHash: item.vectorSourceHash ?? item.sourceHash,
          }),
        },
      ],
    ]),
    resolver: {
      resolve: async (query, options) => {
        calls.push({ query, options });
        return result;
      },
    },
    homeProjectPath: root,
    homeDocsRoot: join(root, 'docs'),
  });
  const scope = { ownerUserId: 'owner', threadId: 'thread', invocationId: 'invocation' };
  return { source, manifest, thread, item, docs, scope, calls, result };
}

for (const external of [false, true])
  test(`exact ${external ? 'external' : 'home'} collection uses original query and current source`, async (t) => {
    const f = fixture(t, external);
    const query = 'Continue getting the plugin ready.';
    const discovered = await f.source.discover({ scope: f.scope, query });
    assert.equal(discovered.sources.length, 1);
    assert.equal(f.calls[0].query, query);
    assert.deepEqual(f.calls[0].options.collections, [f.manifest.id]);
    assert.deepEqual(f.calls[0].options.authorizedCollections, [f.manifest.id]);
    const coordinate = discovered.sources[0];
    assert.equal(
      (await f.source.read({ scope: f.scope, anchor: coordinate.anchor, expectedRevision: coordinate.revision }))
        .status,
      'ok',
    );
    writeFileSync(join(f.docs, 'lesson.md'), '# corrected');
    assert.equal((await f.source.discover({ scope: f.scope, query })).omission, 'index_stale');
    assert.equal(
      (await f.source.read({ scope: f.scope, anchor: coordinate.anchor, expectedRevision: coordinate.revision }))
        .invalidationReason,
      'source_corrected',
    );
  });

for (const [name, mutate, reason] of [
  [
    'unknown index revision',
    (f) => {
      delete f.item.sourceHash;
    },
    'index_revision_unverified',
  ],
  [
    'stale vector revision',
    (f) => {
      f.item.vectorSourceHash = 'a'.repeat(64);
    },
    'index_stale',
  ],
  [
    'lexical fallback',
    (f) => {
      f.result.meta.degraded = true;
    },
    'degraded',
  ],
  [
    'partial collection result',
    (f) => {
      f.result.collectionGroups[0].status = 'error';
    },
    'scope_unavailable',
  ],
  [
    'wrong owner',
    (f) => {
      f.manifest.ownerUserId = 'other';
    },
    'scope_unavailable',
  ],
  [
    'project unbound',
    (f) => {
      f.thread.projectPath = '/nonexistent';
    },
    'scope_unavailable',
  ],
  [
    'archived original',
    (f) => {
      f.item.status = 'archived';
    },
    'source_unavailable',
  ],
])
  test(`${name} omits safely`, async (t) => {
    const f = fixture(t);
    mutate(f);
    const found = await f.source.discover({ scope: f.scope, query: 'Continue.' });
    assert.deepEqual(found.sources, []);
    assert.equal(found.omission, reason);
  });

test('revoked owner/project binding invalidates already issued coordinate', async (t) => {
  const f = fixture(t);
  const coordinate = (await f.source.discover({ scope: f.scope, query: 'Continue.' })).sources[0];
  f.manifest.ownerUserId = 'other';
  assert.equal(
    (await f.source.read({ scope: f.scope, anchor: coordinate.anchor, expectedRevision: coordinate.revision }))
      .invalidationReason,
    'scope_revoked',
  );
});
