import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { readIndependentThreadWorks, WorkCatalogue } from '../dist/domains/collaborative-content/works/catalogue.js';
import { workPublicationContentRef } from '../dist/domains/video-studio/content-owner/publication.js';
import { ProjectContentOwnerService } from '../dist/domains/video-studio/content-owner/service.js';
import { workCatalogueFixture } from './helpers/work-catalogue-fixture.js';

function freshPublication(scope, operationId) {
  const publicationScope = { ...scope, creationOperationId: operationId };
  const bytes = Buffer.from(operationId);
  return {
    contentRef: workPublicationContentRef(publicationScope),
    mediaType: 'video/mp4',
    bytes,
    actor: { kind: 'human', actorId: 'owner' },
    operationId,
    publicationScope,
    sourcePublication: {
      sourceRef: `workspace:fixture:${operationId}`,
      artifactRef: `${operationId}.mp4`,
      threadId: scope.threadId,
      revision: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
  };
}

test('thread Works discovery and validation do not grow with unrelated works, including a cold owner', async (t) => {
  const fixture = await workCatalogueFixture(t);
  const target = await Promise.all(Array.from({ length: 3 }, (_, i) => fixture.create(`target-${i}`)));
  await Promise.all(Array.from({ length: 10 }, (_, i) => fixture.create(`foreign-${i}`, 'other')));
  // Legacy backfill is measured separately; steady reads and a cold process must reuse its durable result.
  await readIndependentThreadWorks(new WorkCatalogue(fixture.service), 'owner', 'selected-thread');
  const originalRead = fs.readFile;
  const originalOpen = fs.opendir;
  const ownerRoot = join(fixture.root, 'projects', 'content-owner-v1');
  let manifests = 0;
  let globalWalks = 0;
  fs.readFile = async (path, ...args) => {
    if (String(path).startsWith(ownerRoot) && basename(String(path)) === 'state.json') manifests++;
    return originalRead(path, ...args);
  };
  fs.opendir = async (path, ...args) => {
    if (String(path) === ownerRoot) globalWalks++;
    return originalOpen(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFile = originalRead;
    fs.opendir = originalOpen;
    syncBuiltinESMExports();
  });
  const measure = async (owner = fixture.owner) => {
    manifests = 0;
    globalWalks = 0;
    const began = performance.now();
    // Reuse the actual service/version/auth chain; substitute only its owner instance on cold restart.
    const readThread =
      owner === fixture.owner
        ? () => readIndependentThreadWorks(new WorkCatalogue(fixture.service), 'owner', 'selected-thread')
        : async () => {
            const heads = [];
            for await (const head of owner.retainedThreadMediaHeads('owner', 'selected-thread')) heads.push(head);
            return heads.map((head) => ({ ref: head.contentRef }));
          };
    const result = await readThread();
    assert.deepEqual(result.map((item) => item.ref).sort(), target.map((item) => item.reference.contentRef).sort());
    return { manifests, globalWalks, elapsedMs: performance.now() - began };
  };
  const small = await measure();
  await Promise.all(Array.from({ length: 90 }, (_, i) => fixture.create(`large-${i}`, 'other')));
  const large = await measure();
  t.diagnostic(JSON.stringify({ targetWorks: 3, unrelatedWorks: [10, 100], small, large }));
  assert.equal(small.globalWalks, 0, 'a thread read must not enumerate the canonical owner root');
  assert.equal(large.globalWalks, 0);
  assert.equal(large.manifests, small.manifests);
  assert.ok(large.manifests <= 15, 'only target manifests and selected exact versions may be read');
  const cold = await measure(new ProjectContentOwnerService({ dataDir: fixture.root }));
  assert.equal(cold.globalWalks, 0, 'a cold process reuses the durable index');
  t.diagnostic(JSON.stringify({ cold }));
});

test('source lineage lookup reads only candidates for the requested source coordinates', async (t) => {
  const f = await workCatalogueFixture(t);
  const saved = await f.create('source-target');
  await Promise.all(Array.from({ length: 10 }, (_, i) => f.create(`unrelated-source-${i}`, 'other')));
  for await (const _head of f.owner.retainedThreadMediaHeads('owner', 'selected-thread')) {
    /* initialize legacy index */
  }
  const read = fs.readFile;
  let states = 0;
  fs.readFile = async (path, ...args) => {
    if (basename(String(path)) === 'state.json') states++;
    return read(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFile = read;
    syncBuiltinESMExports();
  });
  const lookup = [
    {
      lookupId: 'source',
      ownerUserId: 'owner',
      sourceRef: 'workspace:fixture:source-target',
      artifactRef: 'source-target',
      revisions: [f.command('source-target').source.expectedSourceRevision],
    },
  ];
  const measure = async () => {
    states = 0;
    const began = performance.now();
    const found = await f.owner.findSourcePublicationsBatch(lookup);
    assert.equal(found.get('source')[0].contentRef, saved.reference.contentRef);
    return { manifests: states, elapsedMs: performance.now() - began };
  };
  const small = await measure();
  await Promise.all(Array.from({ length: 90 }, (_, i) => f.create(`more-source-${i}`, 'other')));
  const large = await measure();
  t.diagnostic(JSON.stringify({ lineage: { small, large } }));
  assert.equal(small.manifests, 1, 'lineage must not reintroduce an owner-wide manifest scan');
  assert.equal(large.manifests, 1);
});

test('legacy migration failure does not block unrelated publication and a repaired read can retry', async (t) => {
  const f = await workCatalogueFixture(t);
  const saved = await f.create('legacy');
  const state = JSON.parse(await fs.readFile(f.statePath(saved.reference.contentRef), 'utf8'));
  const index = join(f.root, 'projects', 'content-owner-index-v1');
  assert.ok(index.startsWith(f.root));
  await fs.rm(index, { recursive: true });
  const broken = join(
    f.root,
    'projects',
    'content-owner-v1',
    createHash('sha256').update('interrupted-old-write').digest('hex'),
  );
  assert.ok(broken.startsWith(f.root));
  await fs.mkdir(join(broken, 'blobs'), { recursive: true });
  const cold = new ProjectContentOwnerService({ dataDir: f.root });
  await assert.doesNotReject(cold.importContent(freshPublication(state.publicationScope, 'fresh-publication')));
  const heads = async () => {
    const found = [];
    for await (const head of cold.retainedThreadMediaHeads('owner', 'selected-thread')) found.push(head.contentRef);
    return found;
  };
  await assert.rejects(heads(), /Incomplete content owner manifest/);
  await fs.rm(broken, { recursive: true });
  assert.equal((await heads()).length, 2, 'a failed migration promise cannot permanently poison this owner');
});

test('publication during legacy backfill remains indexed before the ready marker commits', async (t) => {
  const f = await workCatalogueFixture(t);
  const saved = await f.create('migration-original');
  const path = f.statePath(saved.reference.contentRef);
  const state = JSON.parse(await fs.readFile(path, 'utf8'));
  const index = join(f.root, 'projects', 'content-owner-index-v1');
  assert.ok(index.startsWith(f.root));
  await fs.rm(index, { recursive: true });
  const cold = new ProjectContentOwnerService({ dataDir: f.root });
  const read = fs.readFile;
  let added;
  fs.readFile = async (candidate, ...args) => {
    const contents = await read(candidate, ...args);
    if (String(candidate) === path && !added) {
      added = cold.importContent(freshPublication(state.publicationScope, 'during-backfill'));
      await added;
    }
    return contents;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFile = read;
    syncBuiltinESMExports();
  });
  const heads = [];
  for await (const head of cold.retainedThreadMediaHeads('owner', 'selected-thread')) heads.push(head.contentRef);
  assert.ok(added);
  assert.equal(heads.length, 2);
  assert.equal(await read(join(index, 'ready'), 'utf8'), '1');
});

test('an initial ENOENT followed by committed rename is readable, while a missing committed state still fails', async (t) => {
  const f = await workCatalogueFixture(t);
  const saved = await f.create('point-read');
  for await (const _head of f.owner.retainedThreadMediaHeads('owner', 'selected-thread')) {
    /* warm backfill */
  }
  const path = f.statePath(saved.reference.contentRef),
    staged = `${path}.held`;
  const read = fs.readFile,
    stat = fs.stat;
  let moved = false,
    restored = false;
  fs.readFile = async (candidate, ...args) => {
    if (String(candidate) === path && !moved) {
      moved = true;
      await fs.rename(path, staged);
    }
    return read(candidate, ...args);
  };
  fs.stat = async (candidate, ...args) => {
    if (String(candidate) === join(path, '..') && moved && !restored) {
      restored = true;
      await fs.rename(staged, path);
    }
    return stat(candidate, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFile = read;
    fs.stat = stat;
    syncBuiltinESMExports();
  });
  const heads = [];
  for await (const head of f.owner.retainedThreadMediaHeads('owner', 'selected-thread')) heads.push(head.contentRef);
  assert.equal(heads.length, 1);
  assert.equal(restored, true);
  await fs.rm(path);
  await assert.rejects(async () => {
    for await (const _head of f.owner.retainedThreadMediaHeads('owner', 'selected-thread')) {
      /* consume */
    }
  }, /Incomplete content owner manifest/);
});
