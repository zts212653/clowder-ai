import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { MessageMediaPublicationSource } from '@cat-cafe/shared';
import Fastify from 'fastify';
import sharp from 'sharp';
import { threadsRoutes } from '../src/routes/threads.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'f309-global-artifact-lineage-'));
  const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#f5b942' } })
    .png()
    .toBuffer();
  await writeFile(join(root, 'review-input.png'), png);
  const f = await createLiveReviewFixture(root);
  const app = Fastify();
  await app.register(threadsRoutes, {
    threadStore: f.threads,
    presenceSource: { getPresence: async () => new Map() },
    messageStore: f.messages,
    taskStore: f.tasks,
    artifactWorkLineage: { current: f.globalArtifactWorkLineage },
  });
  t.after(async () => {
    await app.close();
    await f.dispatch.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = () =>
    app.inject({ method: 'GET', url: '/api/artifacts', headers: { 'x-cat-cafe-user': 'operator' } });
  const threadRequest = () =>
    app.inject({
      method: 'GET',
      url: `/api/threads/${f.thread.id}/artifacts`,
      headers: { 'x-cat-cafe-user': 'operator' },
    });
  const originalSource: MessageMediaPublicationSource = {
    kind: 'message',
    threadId: f.thread.id,
    messageId: f.publication.id,
    messageRevision: String(f.publication.timestamp),
    expectedUrl: '/uploads/review-input.png',
    item: { kind: 'media-gallery', blockId: 'review-input.png', itemIndex: 0 },
  };
  return { ...f, root, png, request, threadRequest, originalSource };
}

function statePath(root: string, contentRef: string): string {
  return join(
    root,
    'projects',
    'content-owner-v1',
    createHash('sha256').update(contentRef).digest('hex'),
    'state.json',
  );
}

async function removeManifestRevisions(root: string, contentRef: string): Promise<void> {
  const path = statePath(root, contentRef);
  const state = JSON.parse(await readFile(path, 'utf8')) as { revisions: unknown[] };
  state.revisions = [];
  await writeFile(path, JSON.stringify(state), 'utf8');
}

test('owner GET /api/artifacts walks the real F309 publication path and returns its exact work coordinate', async (t) => {
  const f = await fixture(t);
  const retained = await f.media.prepare({ ...f.prepare, principal: f.human });

  const response = await f.request();

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.workLineage, 'resolved');
  const projected = body.artifacts.find(
    (candidate: { sourceMessageId?: string }) => candidate.sourceMessageId === f.publication.id,
  );
  assert.deepEqual(projected?.work, {
    contentRef: retained.contentRef,
    ownerRevision: retained.ownerRevision,
    currentOwnerRevision: retained.ownerRevision,
  });
});

test('thread GET reads the existing F309 owner version without importing or modifying its manifest', async (t) => {
  const f = await fixture(t);
  const retained = await f.media.prepare({ ...f.prepare, principal: f.human });
  const path = statePath(f.root, retained.contentRef);
  const before = await readFile(path);
  let prepareCalls = 0;
  f.media.prepare = async () => {
    prepareCalls += 1;
    throw new Error('Card reads cannot prepare or import a publication');
  };

  const response = await f.threadRequest();
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.threadId, f.thread.id);
  assert.equal(body.workLineage, 'resolved');
  const projected = body.artifacts.find(
    (candidate: { sourceMessageId?: string }) => candidate.sourceMessageId === f.publication.id,
  );
  assert.deepEqual(projected?.work, {
    contentRef: retained.contentRef,
    ownerRevision: retained.ownerRevision,
    currentOwnerRevision: retained.ownerRevision,
  });
  assert.equal(prepareCalls, 0);
  assert.deepEqual(await readFile(path), before);
});

test('thread GET leaves an unprepared publication version absent and never calls prepare', async (t) => {
  const f = await fixture(t);
  let prepareCalls = 0;
  f.media.prepare = async () => {
    prepareCalls += 1;
    throw new Error('Card reads cannot create a missing landing');
  };
  const response = await f.threadRequest();
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.workLineage, 'resolved');
  assert.ok(body.artifacts.length > 0);
  assert.ok(body.artifacts.every((artifact: { work?: unknown }) => artifact.work === undefined));
  assert.equal(prepareCalls, 0);
});

test('a revoked current source prevents an older readable revision from exposing the canonical current coordinate', async (t) => {
  const f = await fixture(t);
  const first = await f.media.prepare({ source: f.originalSource, operationId: 'source-v1', principal: f.human });
  const currentMessage = f.publish('version-2.png');
  await f.owner.settle({
    contentRef: first.contentRef,
    expectedOwnerRevision: 1,
    bytes: f.png,
    operationId: 'return-v2',
    actor: f.cat.actor,
    sourcePublication: {
      artifactRef: '/uploads/version-2.png',
      sourceRef: `message:${f.thread.id}:${currentMessage.id}`,
      revision: String(currentMessage.timestamp),
    },
  });
  assert.equal(await f.media.currentRevision(first.contentRef, f.human), 2);
  currentMessage.recall = { version: 1, exposure: 'seen', recalledAt: Date.now() };
  await assert.rejects(f.media.currentRevision(first.contentRef, f.human), /access_denied/);
  assert.equal((await f.media.read(first.contentRef, 1, f.human)).ownerRevision, 1);

  const response = await f.request();

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.workLineage, 'resolved');
  assert.ok(body.artifacts.every((artifact: { work?: unknown }) => artifact.work === undefined));
});

test('a matching manifest without its declared current revision makes the whole HTTP lineage unavailable', async (t) => {
  const f = await fixture(t);
  const retained = await f.media.prepare({ ...f.prepare, principal: f.human });
  const before = (await f.request()).json();
  assert.ok(
    before.artifacts.some(
      (artifact: { work?: { contentRef: string } }) => artifact.work?.contentRef === retained.contentRef,
    ),
  );
  await removeManifestRevisions(f.root, retained.contentRef);

  const response = await f.request();

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.workLineage, 'unavailable');
  assert.ok(body.artifacts.every((artifact: { work?: unknown }) => artifact.work === undefined));
});

test('one unrelated incomplete manifest suppresses every otherwise valid work coordinate', async (t) => {
  const f = await fixture(t);
  const retained = await f.media.prepare({ ...f.prepare, principal: f.human });
  const corruptRef = 'project:lineage-integrity/unrelated.docx';
  await f.owner.importContent({
    contentRef: corruptRef,
    bytes: Buffer.from('unrelated'),
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    operationId: 'unrelated-import',
    actor: { kind: 'human', actorId: 'operator' },
  });
  await removeManifestRevisions(f.root, corruptRef);

  const response = await f.request();

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.workLineage, 'unavailable');
  assert.equal(
    body.artifacts.some(
      (artifact: { work?: { contentRef: string } }) => artifact.work?.contentRef === retained.contentRef,
    ),
    false,
  );
});
