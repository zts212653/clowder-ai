import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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

test('owner manifests reject incomplete revision, receipt, and operation truth', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'f309-owner-manifest-integrity-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const owner = new ProjectContentOwnerService({ dataDir });
  const contentRef = 'project:integrity/document.docx';
  const mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  await owner.importContent({
    contentRef,
    bytes: Buffer.from('v1'),
    mediaType,
    actor,
    operationId: 'integrity-v1',
  });
  await owner.settle({
    contentRef,
    expectedOwnerRevision: 1,
    bytes: Buffer.from('v2'),
    actor: { kind: 'cat', actorId: 'codex-sol' },
    operationId: 'integrity-v2',
  });
  const path = join(
    dataDir,
    'projects',
    'content-owner-v1',
    createHash('sha256').update(contentRef).digest('hex'),
    'state.json',
  );
  type MutableManifest = {
    currentOwnerRevision: number;
    revisions: Array<{ ownerRevision: number; parentRevision: number | null }>;
    receipts: Array<{ operationId: string; receiptId: string }>;
    operations: Record<string, { fingerprint: string; receiptId: string }>;
  };
  const original = JSON.parse(await readFile(path, 'utf8')) as MutableManifest;
  const corruptions: Array<[string, (state: typeof original) => void]> = [
    ['non-positive current revision', (state) => (state.currentOwnerRevision = 0)],
    ['missing current revision', (state) => state.revisions.pop()],
    ['duplicate revision', (state) => (state.revisions[1].ownerRevision = 1)],
    ['broken parent link', (state) => (state.revisions[1].parentRevision = null)],
    ['missing receipt', (state) => state.receipts.pop()],
    ['receipt/revision mismatch', (state) => (state.receipts[1].operationId = 'wrong-operation')],
    ['missing operation', (state) => delete state.operations['integrity-v2']],
    ['operation/receipt mismatch', (state) => (state.operations['integrity-v2'].receiptId = 'wrong-receipt')],
    [
      'extra operation',
      (state) =>
        (state.operations.extra = {
          fingerprint: `sha256:${'f'.repeat(64)}`,
          receiptId: state.receipts[0].receiptId,
        }),
    ],
  ];
  for (const [label, corrupt] of corruptions) {
    const state = structuredClone(original);
    corrupt(state);
    await writeFile(path, JSON.stringify(state), 'utf8');
    await assert.rejects(new ProjectContentOwnerService({ dataDir }).describe(contentRef), /Corrupt/, label);
  }
  await writeFile(path, JSON.stringify(original), 'utf8');
  assert.equal((await new ProjectContentOwnerService({ dataDir }).describe(contentRef)).currentOwnerRevision, 2);
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
