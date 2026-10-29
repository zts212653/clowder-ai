import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { WorkCatalogue } from '../src/domains/collaborative-content/works/catalogue.js';
import { inspectWorkResult } from '../src/domains/collaborative-content/works/inspection.js';
import { LivingWorkService, type OpenWorkSource } from '../src/domains/collaborative-content/works/service.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';

const actor = { kind: 'cat' as const, actorId: 'director' };
const principal = { userId: 'operator', threadId: 'production', actor, invocationId: 'running-child' };
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}` as const;
const source = (value: string) => ({
  worktreeId: 'authorized-root',
  path: `${value}.mp4`,
  expectedSourceRevision: digest(value),
});
const create = {
  action: 'create' as const,
  operationId: 'first-film',
  title: '同名也不合并',
  changeSummary: '第一次交片',
  source: source('first'),
};

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'f326-living-work-'));
  const owner = new ProjectContentOwnerService({ dataDir: root });
  const store = new ArtifactReviewStore(join(root, 'reviews.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  let allowed = true;
  let opens = 0;
  const deps = {
    owner,
    versions: store.works,
    authorize: async () => {
      if (!allowed) throw new Error('production authority revoked');
    },
    source: {
      inspect: async () => ({ source: source('first'), mediaType: 'video/mp4', byteLength: 5 }),
      openCurrent: async (input: { locator: { worktreeId: string; path: string } }): Promise<OpenWorkSource> =>
        deps.source.open({ source: source(input.locator.path.replace('.mp4', '')) }),
      open: async (input: { source: ReturnType<typeof source> }) => {
        opens++;
        const name = input.source.path.replace('.mp4', '');
        return {
          mediaType: 'video/mp4' as const,
          stream: Readable.from([Buffer.from(name)]),
          byteLength: Buffer.byteLength(name),
          blobDigest: digest(name),
          publication: {
            artifactRef: input.source.path,
            sourceRef: `workspace:authorized-root:${input.source.path}`,
            revision: digest(name),
          },
          revalidate: async () => undefined,
        };
      },
    },
  };
  return {
    root,
    owner,
    store,
    deps,
    service: new LivingWorkService(deps),
    revoke: () => {
      allowed = false;
    },
    opens: () => opens,
  };
}

test('common work entry owns explicit versions, independent of messages, Tasks, titles and source filenames', async (t) => {
  const f = await fixture(t);
  const first = await f.service.commit(create, principal);
  assert.equal(first.reference.ownerRevision, 1);
  const second = await f.service.commit(
    {
      ...create,
      action: 'submit',
      contentRef: first.reference.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'second-film',
      title: '改名后的同一作品',
      changeSummary: '剪短了片头',
      source: source('second'),
    },
    principal,
  );
  assert.equal(second.reference.contentRef, first.reference.contentRef);
  assert.equal(second.reference.ownerRevision, 2);
  assert.deepEqual((await f.owner.load(first.reference.contentRef, 1)).bytes, Buffer.from('first'));
  assert.deepEqual((await f.owner.load(first.reference.contentRef, 2)).bytes, Buffer.from('second'));
  assert.equal((await f.service.read(first.reference, principal)).version.changeSummary, '第一次交片');
  assert.equal((await f.service.read(second.reference, principal)).version.title, '改名后的同一作品');
  const separate = await f.service.commit({ ...create, operationId: 'different-work' }, principal);
  assert.notEqual(separate.reference.contentRef, first.reference.contentRef);
  const restarted = new LivingWorkService({ ...f.deps, owner: new ProjectContentOwnerService({ dataDir: f.root }) });
  assert.equal((await restarted.read(first.reference, principal)).currentOwnerRevision, 2);
});

test('delivery cards pin the requested version and reauthorize after restart without republishing bytes', async (t) => {
  const f = await fixture(t);
  const first = await f.service.commit(create, principal);
  const next = await f.service.commit(
    {
      ...create,
      action: 'submit',
      contentRef: first.reference.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'next',
      title: '新版标题',
      changeSummary: '新版修改',
      source: source('next'),
    },
    principal,
  );
  const reopened = new LivingWorkService({ ...f.deps, owner: new ProjectContentOwnerService({ dataDir: f.root }) });
  const before = f.opens();
  const result = await reopened.reference(first.reference, principal);
  assert.deepEqual(result.reference, first.reference);
  assert.equal(result.block.title, create.title);
  assert.deepEqual(result.block.meta?.reference, first.reference);
  assert.equal(result.block.meta?.kind, 'work_reference');
  assert.match(result.block.bodyMarkdown ?? '', /第一次交片/);
  assert.notEqual(result.block.id, (await reopened.reference(next.reference, principal)).block.id);
  assert.deepEqual(await reopened.reference(first.reference, principal), result);
  assert.equal(f.opens(), before, 'publishing a reference never re-reads a source or commits a version');
  assert.equal((await f.owner.describe(first.reference.contentRef)).currentOwnerRevision, 2);
  f.revoke();
  await assert.rejects(reopened.reference(first.reference, principal), /revoked/);
});

test('receipt replay needs no original file, semantic changes conflict, and stale CAS never creates a version', async (t) => {
  const f = await fixture(t);
  const first = await f.service.commit(create, principal);
  const before = f.opens();
  assert.deepEqual(await f.service.commit(create, principal), first);
  assert.equal(f.opens(), before);
  await assert.rejects(f.service.commit({ ...create, changeSummary: 'different claim' }, principal), /idempotency/i);
  await f.service.commit(
    {
      ...create,
      action: 'submit',
      contentRef: first.reference.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'v2',
      source: source('second'),
    },
    principal,
  );
  await assert.rejects(
    f.service.commit(
      {
        ...create,
        action: 'submit',
        contentRef: first.reference.contentRef,
        expectedOwnerRevision: 1,
        operationId: 'stale',
        source: source('third'),
      },
      principal,
    ),
    /conflict/i,
  );
  assert.equal((await f.owner.describe(first.reference.contentRef)).currentOwnerRevision, 2);
});

test('owner success followed by projection failure recovers the same version and receipt', async (t) => {
  const f = await fixture(t);
  const record = f.store.works.recordVersion.bind(f.store.works);
  f.store.works.recordVersion = () => {
    throw new Error('metadata database temporarily unavailable');
  };
  await assert.rejects(f.service.commit(create, principal), /saved; annotations pending/);
  f.store.works.recordVersion = record;
  const recovered = await f.service.commit(create, principal);
  assert.equal(recovered.reference.ownerRevision, 1);
  assert.equal(f.opens(), 1);
  assert.equal((await f.owner.listOutbox(recovered.reference.contentRef)).length, 1);
});

test('revocation rejects a replay and read; caller actor fields are not accepted as authority', async (t) => {
  const f = await fixture(t);
  const first = await f.service.commit(create, principal);
  await assert.rejects(f.service.commit({ ...create, actor: { kind: 'human', actorId: 'operator' } }, principal));
  f.revoke();
  await assert.rejects(f.service.commit(create, principal), /revoked/);
  await assert.rejects(f.service.read(first.reference, principal), /revoked/);
});

test('the catalogue is owner-derived, readable after restart, and fenced across version changes', async (t) => {
  const f = await fixture(t);
  const first = await f.service.commit(create, principal);
  const page = await f.service.list(principal);
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0]?.reference, first.reference);
  await f.service.commit(
    {
      ...create,
      action: 'submit',
      contentRef: first.reference.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'updated-head',
      source: source('second'),
    },
    principal,
  );
  await assert.rejects(f.service.list(principal, first.reference.contentRef, page.snapshot), /publication_changed/);
  const newPage = await f.service.list(principal);
  assert.equal(newPage.items[0]?.currentOwnerRevision, 2);
});

test('Works discovers an unpublished owner work with its actual current version and no invented message', async (t) => {
  const f = await fixture(t);
  const first = await f.service.commit(create, principal);
  const second = await f.service.commit(
    {
      ...create,
      action: 'submit',
      contentRef: first.reference.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'current-cut',
      title: '现在的片名',
      source: source('second'),
    },
    principal,
  );
  const catalogue = new WorkCatalogue(f.service);
  const page = await catalogue.readThread({ ownerUserId: 'operator', threadId: 'production' });
  assert.equal(page.artifacts.length, 1);
  assert.equal(page.artifacts[0]?.name, '现在的片名');
  assert.equal(page.artifacts[0]?.sourceMessageId, null);
  assert.equal(page.artifacts[0]?.type, 'video');
  assert.deepEqual(page.artifacts[0]?.work, { ...second.reference, currentOwnerRevision: 2 });
  const elsewhere = await catalogue.readThread({ ownerUserId: 'operator', threadId: 'another-production' });
  assert.deepEqual(elsewhere.artifacts, []);
});

test('identical bytes do not become a creative version, and every encoded response byte is recoverable', async (t) => {
  const f = await fixture(t);
  const first = await f.service.commit(create, principal);
  await assert.rejects(
    f.service.commit(
      {
        ...create,
        action: 'submit',
        contentRef: first.reference.contentRef,
        expectedOwnerRevision: 1,
        operationId: 'same-file-again',
      },
      principal,
    ),
    /publication_changed/,
  );
  assert.equal((await f.owner.describe(first.reference.contentRef)).currentOwnerRevision, 1);
  const value = { body: '\\"\n🐾'.repeat(8000) };
  let cursor = 0;
  let expectedSnapshot: string | undefined;
  let json = '';
  do {
    const page = inspectWorkResult({ cursor, expectedSnapshot }, value);
    assert.ok(JSON.stringify(page).length <= 12000);
    json += page.json;
    expectedSnapshot = page.snapshot;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  } while (cursor > 0);
  assert.deepEqual(JSON.parse(json), value);
  assert.throws(() => inspectWorkResult({ cursor: 1 }, value), /publication_changed/);
  assert.throws(() => inspectWorkResult({ cursor: 1, expectedSnapshot }, { body: 'changed' }), /publication_changed/);
});

test('Works displays the frozen version production time without changing catalogue ordering or owner history', async (t) => {
  const f = await fixture(t);
  const saved = await f.service.commit(create, principal);
  const production = { createdAt: '2026-10-15T12:34:00.000Z', sourceRef: 'release/first.mp4#mtime' };
  f.store.works.contexts.save(
    {
      action: 'set-context',
      reference: saved.reference,
      operationId: 'source-time',
      expectedMetadataRevision: 0,
      context: {
        format: 'video',
        extractorVersion: 'release-source-v2',
        provenance: [{ ref: production.sourceRef, digest: digest('first') }],
        production,
        story: [],
        assets: [],
      },
    },
    principal,
    digest('source-time'),
  );
  const catalogue = new WorkCatalogue(f.service, f.store.works.contexts);
  const page = await catalogue.readThread({ ownerUserId: 'operator', threadId: 'production' });
  assert.equal(page.artifacts[0]?.work?.versionCreatedAt, Date.parse(production.createdAt));
  assert.equal(page.artifacts[0]?.work?.versionTimeSource, production.sourceRef);
  const ownerVersion = await f.owner.describe(saved.reference.contentRef);
  assert.notEqual(page.artifacts[0]?.createdAt, Date.parse(production.createdAt));
  assert.equal(ownerVersion.currentOwnerRevision, 1);
  assert.deepEqual((await catalogue.readThread({ ownerUserId: 'operator', threadId: 'other' })).artifacts, []);
});

test('file landing reuses the exact registered version, refuses ambiguity and creates no work on a miss', async (t) => {
  const f = await fixture(t);
  const service = f.service;
  const first = await service.commit(create, principal);
  const second = await service.commit(
    {
      ...create,
      action: 'submit',
      contentRef: first.reference.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'new-cut',
      source: source('second'),
    },
    principal,
  );
  const located = await service.resolveFile({ worktreeId: 'authorized-root', path: 'first.mp4' }, principal);
  assert.deepEqual(located.artifact?.work, { ...first.reference, currentOwnerRevision: 2 });
  assert.notDeepEqual(located.artifact?.work, { ...second.reference, currentOwnerRevision: 2 });
  const before = await f.owner.describe(first.reference.contentRef);
  assert.deepEqual(await service.resolveFile({ worktreeId: 'authorized-root', path: 'unregistered.mp4' }, principal), {
    artifact: null,
  });
  assert.equal((await f.owner.describe(first.reference.contentRef)).currentOwnerRevision, before.currentOwnerRevision);
  await service.commit({ ...create, operationId: 'separate-work-same-file' }, principal);
  await assert.rejects(
    service.resolveFile({ worktreeId: 'authorized-root', path: 'first.mp4' }, principal),
    /publication_changed/,
  );
  f.revoke();
  await assert.rejects(
    service.resolveFile({ worktreeId: 'authorized-root', path: 'second.mp4' }, principal),
    /revoked/,
  );
});
