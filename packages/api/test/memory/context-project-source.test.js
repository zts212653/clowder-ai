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
  const items = new Map([[item.anchor, item]]);
  const result = {
    meta: { degraded: false, effectiveMode: 'hybrid' },
    collectionGroups: [{ collectionId: id, status: 'ok' }],
    results: [item],
  };
  const resolver = {
    resolve: async (query, options) => {
      calls.push({ query, options });
      return result;
    },
  };
  const source = new ContextProjectCueSource({
    threads: { get: async () => thread },
    catalog: { get: (key) => (key === id ? manifest : null) },
    stores: new Map([
      [
        id,
        {
          getByAnchor: async (key) => items.get(key) ?? null,
          getIndexedSourceRevision: async (key) => {
            const current = items.get(key);
            return current
              ? {
                  sourceHash: current.sourceHash,
                  vectorSourceHash: current.vectorSourceHash ?? current.sourceHash,
                }
              : null;
          },
        },
      ],
    ]),
    resolver,
    homeProjectPath: root,
    homeDocsRoot: join(root, 'docs'),
  });
  const scope = { ownerUserId: 'owner', threadId: 'thread', invocationId: 'invocation' };
  return { source, manifest, thread, item, items, docs, scope, calls, result, resolver };
}

for (const [badPosition, mutate, reason] of [
  [
    0,
    (item) => {
      delete item.sourceHash;
    },
    'index_revision_unverified',
  ],
  [
    1,
    (item) => {
      item.vectorSourceHash = 'a'.repeat(64);
    },
    'index_stale',
  ],
  [
    2,
    (item) => {
      item.status = 'archived';
    },
    'source_unavailable',
  ],
  [
    4,
    (item) => {
      item.sourceHash = 'a'.repeat(64);
    },
    'index_stale',
  ],
])
  test(`invalid candidate at position ${badPosition + 1} preserves two valid sources`, async (t) => {
    const f = fixture(t);
    const hits = Array.from({ length: 5 }, (_, i) => ({ ...f.item, anchor: `candidate:${i}` }));
    for (const hit of hits) f.items.set(hit.anchor, hit);
    mutate(hits[badPosition]);
    f.result.results = hits;
    const found = await f.source.discover({ scope: f.scope, query: 'Continue.' });
    assert.equal(found.sources.length, 2);
    assert.deepEqual(found.omissions, [reason]);
    for (const cue of found.sources) {
      assert.equal(
        (await f.source.read({ scope: f.scope, anchor: cue.anchor, expectedRevision: cue.revision })).status,
        'ok',
      );
    }
  });

test('all invalid candidates retain omission diagnostics and the resolver records partial failures', async (t) => {
  const { ProjectKnowledgeCueResolver } = await import(
    '../../dist/domains/memory/cue/resolvers/ProjectKnowledgeCueResolver.js'
  );
  const f = fixture(t);
  const other = { ...f.item, anchor: 'second', status: 'archived' };
  f.items.set(other.anchor, other);
  f.result.results = [f.item, other];
  const reasons = [];
  const message = { userId: 'owner', threadId: 'thread', content: 'Continue the original route.' };
  const resolver = new ProjectKnowledgeCueResolver({}, f.source, { getById: async () => message });
  const cues = await resolver.resolve(
    {
      v: 1,
      kind: 'fresh_context_sources',
      opportunityId: 'opportunity',
      scope: f.scope,
      payload: { sourceMessageId: 'message' },
    },
    {
      now: 1_000,
      expiresAt: 10_000,
      createDrillHandle: () => 'opaque',
      recordOmission: (reason) => reasons.push(reason),
    },
  );
  assert.equal(cues.length, 1);
  assert.deepEqual(reasons, ['source_unavailable']);
  delete f.item.sourceHash;
  const allBad = await f.source.discover({ scope: f.scope, query: 'Continue.' });
  assert.deepEqual(allBad.sources, []);
  assert.deepEqual(allBad.omissions, ['index_revision_unverified', 'source_unavailable']);
  assert.equal(allBad.omission, 'index_revision_unverified');
});

test('an overall retrieval failure is not reported as empty knowledge, and rebinding revokes the batch', async (t) => {
  const f = fixture(t);
  const failure = new Error('retrieval unavailable');
  f.resolver.resolve = async () => {
    throw failure;
  };
  await assert.rejects(f.source.discover({ scope: f.scope, query: 'Continue.' }), failure);
  f.resolver.resolve = async () => {
    f.manifest.ownerUserId = 'other';
    return f.result;
  };
  const revoked = await f.source.discover({ scope: f.scope, query: 'Continue.' });
  assert.deepEqual(revoked, { sources: [], omission: 'scope_unavailable' });
});

test('continued context reads reject path escape and revoked thread ownership', async (t) => {
  const f = fixture(t);
  const cue = (await f.source.discover({ scope: f.scope, query: 'Continue.' })).sources[0];
  const input = { scope: f.scope, anchor: cue.anchor, expectedRevision: cue.revision, window: { offset: 4_000 } };
  f.item.sourcePath = '../outside.md';
  assert.equal((await f.source.read(input)).status, 'not_available');
  f.item.sourcePath = 'lesson.md';
  f.thread.createdBy = 'other';
  assert.equal((await f.source.read(input)).invalidationReason, 'scope_revoked');
});

test('a whole lesson document retains its whole-file hash even when named lessons-learned.md', async (t) => {
  const f = fixture(t, true);
  f.item.anchor = 'doc:lessons-learned';
  f.item.kind = 'lesson';
  f.item.sourcePath = 'lessons-learned.md';
  writeFileSync(join(f.docs, f.item.sourcePath), '# A current reusable experience\nDo the prior approved sequence.');
  f.items.set(f.item.anchor, f.item);
  const found = await f.source.discover({ scope: f.scope, query: 'Continue.' });
  assert.equal(found.sources.length, 1, JSON.stringify(found));
});

test('long context source locates later text, continues, then refuses a corrected revision', async (t) => {
  const f = fixture(t);
  const content =
    '# Context\n' +
    'Early context.\n'.repeat(500) +
    '## Release sequence\nUse the approved registry.\n' +
    'Later context.\n'.repeat(500);
  writeFileSync(join(f.docs, 'lesson.md'), content);
  f.item.sourceHash = createHash('sha256').update(content).digest('hex');
  const cue = (await f.source.discover({ scope: f.scope, query: 'Release sequence' })).sources[0];
  const input = { scope: f.scope, anchor: cue.anchor, expectedRevision: cue.revision };
  const located = await f.source.read({ ...input, window: { query: 'Release sequence' } });
  assert.equal(located.status, 'ok');
  assert.match(located.payload.content, /Use the approved registry/);
  assert.ok(located.payload.contentRange.start > 4_000);
  const next = await f.source.read({ ...input, window: { offset: located.payload.nextOffset } });
  assert.equal(next.payload.contentRange.start, located.payload.contentRange.end);
  assert.equal(next.payload.sourceRevision, cue.revision);
  writeFileSync(join(f.docs, 'lesson.md'), content + 'Corrected.');
  assert.equal(
    (await f.source.read({ ...input, window: { offset: located.payload.nextOffset } })).invalidationReason,
    'source_corrected',
  );
});

test('split lesson verifies its own indexed body and starts at that lesson', async (t) => {
  const f = fixture(t);
  const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
  const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
  const store = new SqliteEvidenceStore(':memory:');
  t.after(() => store.close());
  await store.initialize();
  const prefix = '# Lessons\n' + 'Introduction.\n'.repeat(400);
  const lesson = '### LL-999: Respect the approved sequence\n\nUse the original approved route.\n';
  writeFileSync(join(f.docs, 'lessons-learned.md'), prefix + lesson);
  await new IndexBuilder(store, f.docs).rebuild();
  const item = await store.getByAnchor('LL-999');
  f.items.set(item.anchor, item);
  f.result.results = [item];
  const found = await f.source.discover({ scope: f.scope, query: 'approved sequence' });
  assert.equal(found.sources.length, 1, JSON.stringify(found));
  const cue = found.sources[0];
  const input = { scope: f.scope, anchor: cue.anchor, expectedRevision: cue.revision };
  const read = await f.source.read(input);
  assert.match(read.payload.content, /^### LL-999/);
  assert.equal(read.payload.contentRange.start, prefix.length);
  writeFileSync(join(f.docs, 'lessons-learned.md'), prefix + lesson.replace('original approved', 'corrected approved'));
  assert.equal((await f.source.discover({ scope: f.scope, query: 'sequence' })).omission, 'index_stale');
  assert.equal((await f.source.read(input)).invalidationReason, 'source_corrected');
  await new IndexBuilder(store, f.docs).rebuild();
  const corrected = await store.getByAnchor('LL-999');
  assert.notEqual(corrected.sourceHash, item.sourceHash, 'changing only the lesson body must reindex it');
  f.items.set(corrected.anchor, corrected);
  const fresh = (await f.source.discover({ scope: f.scope, query: 'sequence' })).sources[0];
  assert.notEqual(fresh.revision, cue.revision);
  const reread = await f.source.read({ scope: f.scope, anchor: fresh.anchor, expectedRevision: fresh.revision });
  assert.match(reread.payload.content, /corrected approved route/);
});

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
