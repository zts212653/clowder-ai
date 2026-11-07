import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveProjectCollectionId } from '../../dist/domains/memory/bootstrap-collection-bridge.js';
import { createMemoryCueRuntime } from '../../dist/domains/memory/cue/createMemoryCueRuntime.js';
import { ContextProjectCueSource } from '../../dist/domains/memory/cue/sources/ContextProjectCueSource.js';
import { DecisionMemoryCueSource } from '../../dist/domains/memory/cue/sources/DecisionMemoryCueSource.js';
import { ProjectKnowledgeMemoryCueSource } from '../../dist/domains/memory/cue/sources/ProjectKnowledgeMemoryCueSource.js';
import { documentRevision, owner, publishedCueFixture, sha } from '../helpers/cue-published-fixture.js';

const scope = { ownerUserId: owner, threadId: 'fixture-thread', invocationId: 'fixture-invocation' };

function projectSource(f, { external = false } = {}) {
  const root = external ? join(f.root, 'external') : join(f.primary, 'docs');
  mkdirSync(root, { recursive: true });
  const thread = { createdBy: owner, projectPath: external ? root : f.primary };
  const id = external ? deriveProjectCollectionId(root) : 'project:cat-cafe';
  const manifest = {
    id,
    kind: 'project',
    root,
    status: 'active',
    sensitivity: 'private',
    ownerUserId: owner,
    updatedAt: '2026-11-07',
  };
  const item = {
    anchor: 'doc:lesson',
    kind: 'doc',
    status: 'active',
    sourcePath: 'lesson.md',
    sourceHash: sha('Published lesson'),
  };
  const deps = {
    threads: { get: async () => thread },
    catalog: { get: () => manifest },
    stores: new Map([
      [
        id,
        {
          getByAnchor: async () => item,
          getIndexedSourceRevision: async () => ({ sourceHash: item.sourceHash, vectorSourceHash: item.sourceHash }),
        },
      ],
    ]),
    resolver: {
      resolve: async () => ({
        meta: { degraded: false, effectiveMode: 'hybrid' },
        collectionGroups: [{ collectionId: id, status: 'ok' }],
        results: [item],
      }),
    },
    homeProjectPath: f.primary,
    homeDocsRoot: join(f.primary, 'docs'),
    publishedSource: f.publishedSource,
  };
  return { source: new ContextProjectCueSource(deps), item, thread, root };
}

test('project discovery and continued drill read the indexed published document, never a dirty working copy', async (t) => {
  const f = publishedCueFixture(t, { 'docs/lesson.md': 'Published lesson' });
  writeFileSync(join(f.primary, 'docs/lesson.md'), 'Unpublished local draft');
  const { source, item } = projectSource(f);
  const found = await source.discover({ scope, query: 'find the published lesson' });
  assert.equal(found.sources.length, 1, 'published index and source must share their publication authority');
  const input = { scope, anchor: found.sources[0].anchor, expectedRevision: found.sources[0].revision };
  const first = await source.read(input);
  assert.equal(first.status, 'ok');
  assert.equal(first.payload.content, 'Published lesson');
  assert.equal(readFileSync(join(f.primary, 'docs/lesson.md'), 'utf8'), 'Unpublished local draft');
  const corrected = `Corrected publication\n${'x'.repeat(5_000)}\nEnd of the original`;
  f.publish('docs/lesson.md', corrected);
  item.sourceHash = sha(corrected);
  assert.equal((await source.read(input)).status, 'not_available', 'old cue cannot silently return a new quote');
  const next = (await source.discover({ scope, query: 'corrected lesson' })).sources[0];
  const nextInput = { scope, anchor: next.anchor, expectedRevision: next.revision };
  const part = await source.read(nextInput);
  assert.equal(part.payload.contentRange.total, corrected.length);
  const tail = await source.read({ ...nextInput, window: { offset: part.payload.nextOffset } });
  assert.equal(part.payload.content + tail.payload.content, corrected);
  f.publish('docs/lesson.md', null);
  writeFileSync(join(f.primary, 'docs/lesson.md'), corrected);
  assert.equal(
    (await source.read(nextInput)).status,
    'not_available',
    'an unpublished remnant cannot resurrect the source',
  );
});

test('external project and revoked owner paths cannot borrow the home publication', async (t) => {
  const f = publishedCueFixture(t, { 'docs/lesson.md': 'Home publication' });
  const { source, item, thread, root } = projectSource(f, { external: true });
  const body = 'External project source';
  item.sourceHash = sha(body);
  writeFileSync(join(root, 'lesson.md'), body);
  const result = await source.discover({ scope, query: 'external lesson' });
  assert.equal(result.sources.length, 1);
  const read = await source.read({
    scope,
    anchor: result.sources[0].anchor,
    expectedRevision: result.sources[0].revision,
  });
  assert.equal(read.payload.content, body);
  thread.createdBy = 'another-owner';
  assert.deepEqual(await source.discover({ scope, query: 'external lesson' }), {
    sources: [],
    omission: 'scope_unavailable',
  });
});

test('exact ADR and feature sources use publication authority and keep their existing revision contract', async (t) => {
  const adrPath = 'decisions/999-approved.md';
  const featurePath = 'features/F999-published.md';
  const adr = '---\nstatus: accepted\n---\n# Approved decision\nPublished constraints';
  const feature = '# Current feature\nPublished implementation scope';
  const f = publishedCueFixture(t, { [`docs/${adrPath}`]: adr, [`docs/${featurePath}`]: feature });
  writeFileSync(join(f.primary, 'docs', adrPath), '---\nstatus: draft\n---\nUnpublished decision');
  writeFileSync(join(f.primary, 'docs', featurePath), 'Unpublished feature scope');
  const items = new Map([
    [
      'ADR-999',
      { anchor: 'ADR-999', kind: 'decision', sourcePath: adrPath, status: 'active', title: 'Approved decision' },
    ],
    ['F999', { anchor: 'F999', kind: 'feature', sourcePath: featurePath, status: 'active', title: 'Current feature' }],
  ]);
  const deps = {
    projectDocsRoot: join(f.primary, 'docs'),
    evidenceStore: { getByAnchor: async (anchor) => items.get(anchor) ?? null },
    episodeStore: { hasTerminalConsumptionForSource: () => false },
    publishedSource: f.publishedSource,
  };
  const decision = new DecisionMemoryCueSource(deps);
  const project = new ProjectKnowledgeMemoryCueSource(deps);
  const decisionCue = await decision.resolve({ ownerUserId: owner, decisionAnchor: 'ADR-999' });
  assert.ok(decisionCue, 'the published accepted ADR stays available while its checkout contains a draft');
  const featureCue = await project.resolve({ ownerUserId: owner, featureId: 'F999' });
  assert.equal(decisionCue.revision, documentRevision(adrPath, adr));
  assert.equal(featureCue.revision, documentRevision(featurePath, feature));
  assert.equal(
    (await decision.read({ anchor: 'ADR-999', expectedRevision: decisionCue.revision })).payload.content,
    adr,
  );
  assert.equal(
    (await project.read({ anchor: 'F999', expectedRevision: featureCue.revision })).payload.content,
    feature,
  );
  const runtime = createMemoryCueRuntime({
    evidenceStore: deps.evidenceStore,
    projectDocsRoot: deps.projectDocsRoot,
    publishedProjectSource: f.publishedSource,
    ownerUserId: owner,
    episodeStore: {},
    handles: {},
    messageStore: {},
    eventStore: {},
    entityRegistry: {},
    tasteRepository: f.repository,
    profileRepository: {},
    autoDreamStore: {},
  });
  for (const [anchor, cue, expected] of [
    ['ADR-999', decisionCue, adr],
    ['F999', featureCue, feature],
  ]) {
    const read = await runtime.sourceReader.read({ family: 'evidence', anchor, expectedRevision: cue.revision, scope });
    assert.equal(read.status, 'ok', 'the runtime composition must pass the publication source to its consumers');
    assert.equal(read.payload.content, expected);
  }
});
