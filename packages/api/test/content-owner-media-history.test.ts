import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ContentOwnerIdempotencyError,
  ContentOwnerNotFoundError,
  ProjectContentOwnerService,
} from '../src/domains/video-studio/content-owner/service.js';
import { digestBytes, ProjectContentOwnerStore } from '../src/domains/video-studio/content-owner/store.js';

const actor = { kind: 'human', actorId: 'operator' } as const;
const publicationScope = { ownerUserId: 'operator', threadId: 'thread-cover', taskId: 'task-cover' };
const sourcePublication = {
  artifactRef: '/uploads/cover-1.png',
  sourceRef: 'message:thread-cover:message-cover-1',
  revision: '1788782540000',
};

test('historical media bytes and their publication scope survive a new revision and restart', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f309-media-history-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const owner = new ProjectContentOwnerService({ dataDir });
  await owner.importContent({
    contentRef: 'prepared-media:cover',
    bytes: Buffer.from('first-image'),
    mediaType: 'image/png',
    actor,
    operationId: 'prepare-cover',
    publicationScope,
    sourcePublication,
  });
  await owner.settle({
    contentRef: 'prepared-media:cover',
    expectedOwnerRevision: 1,
    bytes: Buffer.from('new-image'),
    actor: { kind: 'cat', actorId: 'codex-astra' },
    operationId: 'new-cover',
    sourcePublication: {
      ...sourcePublication,
      artifactRef: '/uploads/cover-2.png',
      sourceRef: 'message:thread-cover:message-cover-2',
    },
  });
  const restarted = new ProjectContentOwnerService({ dataDir });
  const historical = await restarted.load('prepared-media:cover', 1);
  assert.equal(historical.ownerRevision, 1, 'an old annotation must still read its original revision');
  assert.equal(historical.bytes.toString(), 'first-image');
  assert.deepEqual(historical.publicationScope, publicationScope);
  assert.deepEqual(historical.sourcePublication, sourcePublication);
  assert.equal(historical.currentOwnerRevision, 2);
  assert.equal((await restarted.load('prepared-media:cover')).bytes.toString(), 'new-image');
  await assert.rejects(restarted.load('prepared-media:cover', 3), ContentOwnerNotFoundError);
  await assert.rejects(restarted.load('prepared-media:cover', -1), TypeError);
});

test('an import operation cannot replay into another Task or publication identity', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f309-media-scope-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const owner = new ProjectContentOwnerService({ dataDir });
  const request = {
    contentRef: 'prepared-media:cover',
    bytes: Buffer.from('image'),
    mediaType: 'image/png',
    actor,
    operationId: 'prepare',
    publicationScope,
    sourcePublication,
  };
  const receipt = await owner.importContent(request);
  assert.deepEqual(await owner.importContent(request), receipt);
  await assert.rejects(
    owner.importContent({ ...request, publicationScope: { ...publicationScope, taskId: 'other-task' } }),
    ContentOwnerIdempotencyError,
  );
  await assert.rejects(
    owner.importContent({
      ...request,
      sourcePublication: { ...sourcePublication, artifactRef: '/uploads/forged.png' },
    }),
    ContentOwnerIdempotencyError,
  );
  assert.equal((await owner.listOutbox(request.contentRef)).length, 1);
});

test('verified media handles support repeated bounded ranges and close after streaming', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-media-stream-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectContentOwnerStore(root);
  const bytes = Buffer.from('a verifiable media sample '.repeat(10000));
  const digest = digestBytes(bytes);
  await store.writeBlob('streaming-media', digest, bytes);
  const opened = await Promise.all([
    store.openBlob('streaming-media', digest),
    store.openBlob('streaming-media', digest),
  ]);
  for (const { handle, byteLength } of opened) {
    assert.equal(byteLength, bytes.length);
    const stream = handle.createReadStream({ start: 4096, end: 4112, autoClose: true });
    const closed = once(stream, 'close');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    await closed;
    assert.deepEqual(Buffer.concat(chunks), bytes.subarray(4096, 4113));
    await assert.rejects(handle.stat(), /closed/);
  }
  const warm = await store.openBlob('streaming-media', digest);
  const stream = warm.handle.createReadStream({ autoClose: true });
  const closed = once(stream, 'close');
  stream.destroy();
  await closed;
  await assert.rejects(warm.handle.stat(), /closed/);
});

test('cached media verification still rejects same-size corruption, restart corruption and symlink substitution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-media-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectContentOwnerStore(root);
  const ref = 'immutable-media',
    bytes = Buffer.from('original immutable bytes'),
    digest = digestBytes(bytes);
  await store.writeBlob(ref, digest, bytes);
  await (await store.openBlob(ref, digest)).handle.close();
  const blob = join(
    root,
    'projects',
    'content-owner-v1',
    createHash('sha256').update(ref).digest('hex'),
    'blobs',
    digest.slice(7),
  );
  const corrupt = Buffer.from(bytes);
  corrupt[0] ^= 1;
  await writeFile(blob, corrupt);
  await assert.rejects(store.openBlob(ref, digest), /digest mismatch/);
  await assert.rejects(new ProjectContentOwnerStore(root).openBlob(ref, digest), /digest mismatch/);
  await writeFile(blob, bytes);
  await (await store.openBlob(ref, digest)).handle.close();
  const other = join(root, 'same-bytes');
  await writeFile(other, bytes);
  await unlink(blob);
  await symlink(other, blob);
  await assert.rejects(store.openBlob(ref, digest), { code: 'ELOOP' });
});
