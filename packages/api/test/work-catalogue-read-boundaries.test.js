import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readIndependentThreadWorks, WorkCatalogue } from '../dist/domains/collaborative-content/works/catalogue.js';
import { MediaOwnerError } from '../dist/domains/video-studio/content-owner/media-errors.js';
import { principal, workCatalogueFixture } from './helpers/work-catalogue-fixture.js';

test('request-local Works retains ten-item pages, current annotations, owner/thread filtering and fresh later requests', async (t) => {
  const f = await workCatalogueFixture(t);
  const expected = [];
  for (let i = 0; i < 12; i++) expected.push((await f.create(`film-${i}`)).reference);
  await f.create('elsewhere', 'another-thread');
  await f.create('foreign', 'selected-thread', 'foreign-owner');
  await f.owner.importContent({
    contentRef: 'prepared-media:non-work',
    bytes: Buffer.from('image'),
    mediaType: 'image/png',
    actor: principal().actor,
    operationId: 'retained-non-work',
    publicationScope: { ownerUserId: 'owner', threadId: 'selected-thread', taskId: 'a-task' },
    sourcePublication: {
      sourceRef: 'message:selected-thread:non-work',
      artifactRef: '/uploads/non-work.png',
      revision: 'exact:non-work',
    },
  });
  let escaped;
  const catalogue = new WorkCatalogue(f.service);
  const firstSnapshot = await catalogue.withRead('owner', async (reader) => {
    escaped = reader;
    const first = await reader.readThread({ ownerUserId: 'owner', threadId: 'selected-thread' });
    assert.equal(first.artifacts.length, 10);
    assert.ok(first.nextCursor);
    const next = await reader.readThread({
      ownerUserId: 'owner',
      threadId: 'selected-thread',
      after: first.nextCursor,
      snapshot: first.snapshot,
    });
    assert.equal(next.artifacts.length, 2);
    assert.equal(next.nextCursor, undefined);
    assert.equal(next.snapshot, first.snapshot);
    assert.deepEqual(
      [...first.artifacts, ...next.artifacts].map((item) => item.ref),
      expected.map((r) => r.contentRef).sort((a, b) => a.localeCompare(b)),
    );
    return first.snapshot;
  });
  await assert.rejects(escaped.readThread({ ownerUserId: 'owner', threadId: 'selected-thread' }), /access_denied/);
  const revised = await f.update(expected[0], 'film-revised');
  const fresh = await readIndependentThreadWorks(catalogue, 'owner', 'selected-thread');
  assert.equal(fresh.find((item) => item.ref === revised.reference.contentRef).work.ownerRevision, 2);
  assert.equal(fresh.find((item) => item.ref === revised.reference.contentRef).name, 'Film film-revised');
  await assert.rejects(f.service.list(principal(), expected[0].contentRef, firstSnapshot), /publication_changed/);
  await catalogue.withRead('owner', (reader) =>
    assert.rejects(reader.readThread({ ownerUserId: 'foreign-owner', threadId: 'selected-thread' }), /access_denied/),
  );
});

test('a changed owner head before return or revoked authority during final validation fails closed', async (t) => {
  const f = await workCatalogueFixture(t);
  const saved = await f.create('first');
  await assert.rejects(
    f.service.withCatalogueRead('owner', async (reader) => {
      await reader.list(principal());
      await f.update(saved.reference, 'new-version');
    }),
    /publication_changed/,
  );
  let revoked = false;
  const original = f.owner.retainedMediaHeads.bind(f.owner);
  let walks = 0;
  f.owner.retainedMediaHeads = async function* (ownerUserId) {
    yield* original(ownerUserId);
    if (++walks === 2) revoked = true;
  };
  f.setAuthorize(async () => {
    if (revoked) throw new MediaOwnerError('access_denied');
  });
  await assert.rejects(f.service.list(principal()), /access_denied/);
});

test('scope admission is refreshed on later pages and principal denial admits no physical owner reads', async (t) => {
  const f = await workCatalogueFixture(t);
  for (let i = 0; i < 11; i++) await f.create(`film-${i}`);
  const counter = f.countReads();
  let denied = false;
  f.setAuthorize(async ({ scope }) => {
    if (denied && scope) throw new MediaOwnerError('access_denied');
  });
  await assert.rejects(
    f.service.withCatalogueRead('owner', async (reader) => {
      const first = await reader.list(principal());
      denied = true;
      await reader.list(principal(), first.nextCursor, first.snapshot);
    }),
    /publication_changed/,
  );
  counter.reset();
  f.setAuthorize(async () => {
    throw new MediaOwnerError('access_denied');
  });
  await assert.rejects(f.service.list(principal()), /access_denied/);
  assert.equal(counter.stats().stateReads, 0);
});

test('missing, malformed or unreadable canonical manifests never become an empty catalogue', async (t) => {
  const f = await workCatalogueFixture(t);
  const saved = await f.create('first');
  const path = f.statePath(saved.reference.contentRef);
  const original = await readFile(path);
  await rm(path);
  await assert.rejects(f.service.list(principal()), /Incomplete content owner manifest/);
  await writeFile(path, '{broken');
  await assert.rejects(f.service.list(principal()), SyntaxError);
  await rm(path);
  await mkdir(path);
  await assert.rejects(f.service.list(principal()), /EISDIR/);
  await rm(path, { recursive: true });
  await writeFile(path, original);
  // A second directory that claims a different ref must not be silently skipped.
  const invalid = join(f.root, 'projects', 'content-owner-v1', 'f'.repeat(64));
  await mkdir(invalid);
  await writeFile(join(invalid, 'state.json'), original);
  await assert.rejects(f.service.list(principal()), /Invalid content owner manifest identity/);
});

test('owner media pagination stays sorted at thirty and a missing version annotation stays unavailable', async (t) => {
  const f = await workCatalogueFixture(t);
  const refs = [];
  for (let i = 0; i < 31; i++) refs.push((await f.create(`film-${i}`)).reference.contentRef);
  const first = await f.owner.listRetainedMedia('owner');
  const second = await f.owner.listRetainedMedia('owner', first.nextCursor);
  assert.equal(first.items.length, 30);
  assert.equal(second.items.length, 1);
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.contentRef),
    refs.sort((a, b) => a.localeCompare(b)),
  );
  f.store.works.get = () => undefined;
  await assert.rejects(f.service.list(principal()), /media_unavailable/);
});
