import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import Fastify from 'fastify';
import sharp from 'sharp';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ArtifactReviewService } from '../src/domains/collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';
import { registerCallbackImageRoutes } from '../src/routes/callback-image-routes.js';
import { createReviewFixture, reviewCat } from './helpers/artifact-review-fixture.js';

let dir: string;
let app: ReturnType<typeof Fastify>;
let registry: InvocationRegistry;
let messages: MessageStore;
let headers: Record<string, string>;
let payload: { imageBase64: string; sourcePath: string; publicationKey: string; title: string; alt: string };
let deleted = false;
let events: unknown[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'member-image-'));
  registry = new InvocationRegistry();
  messages = new MessageStore();
  const auth = await registry.create('operator', 'codex-astra', 'thread-cover');
  headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const png = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#654321' } })
    .png()
    .toBuffer();
  payload = {
    imageBase64: png.toString('base64'),
    sourcePath: '/member/work/cover.png',
    publicationKey: 'v1',
    title: 'Cover',
    alt: 'Geometric fixture',
  };
  deleted = false;
  events = [];
  app = Fastify();
  registerCallbackAuthHook(app, registry);
  registerCallbackImageRoutes(app, {
    registry,
    messageStore: messages,
    threadStore: {
      get: () => ({ id: 'thread-cover', createdBy: 'operator', deletedAt: deleted ? Date.now() : undefined }),
    },
    socketManager: { broadcastAgentMessage: (event: unknown) => events.push(event) },
    uploadDir: dir,
  });
});
afterEach(async () => {
  mock.restoreAll();
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
function send(body: unknown = payload, auth = headers) {
  return app.inject({ method: 'POST', url: '/api/callbacks/publish-image', headers: auth, payload: body });
}

test('publishes exact PNG bytes and a durable current-thread cat message, never a buffered receipt', async () => {
  const response = await send();
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.status, 'published');
  const message = messages.getById(result.messageId);
  assert.ok(message);
  assert.equal(message.userId, 'operator');
  assert.equal(message.threadId, 'thread-cover');
  assert.equal(message.catId, 'codex-astra');
  assert.equal(result.revision, String(message.timestamp));
  assert.equal(message.extra?.rich?.blocks[0]?.kind, 'media_gallery');
  assert.deepEqual(
    await readFile(join(dir, result.url.slice('/uploads/'.length))),
    Buffer.from(payload.imageBase64, 'base64'),
  );
  assert.equal(result.provenance.provider, 'member');
  assert.equal(result.provenance.sourceKind, 'member-local');
  assert.equal(result.provenance.sourcePathTrust, 'client-reported');
  assert.equal(result.provenance.nativeOrigin, undefined);
  assert.ok(events.length > 0);
});

test('the actual MCP handler reads an allowed local PNG and its authenticated callback persists the message', async (t) => {
  const { handlePublishImage } = await import('../../mcp-server/src/tools/member-image-tools.js');
  const { withInvocationCredentials } = await import('../../mcp-server/src/tools/invocation-auth.js');
  const priorApi = process.env.CAT_CAFE_API_URL;
  const priorRoots = process.env.ALLOWED_WORKSPACE_DIRS;
  process.env.CAT_CAFE_API_URL = 'http://member-publication.invalid';
  process.env.ALLOWED_WORKSPACE_DIRS = dir;
  t.after(() => {
    if (priorApi === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = priorApi;
    if (priorRoots === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
    else process.env.ALLOWED_WORKSPACE_DIRS = priorRoots;
  });
  const path = join(dir, 'local.png');
  await writeFile(path, Buffer.from(payload.imageBase64, 'base64'));
  const transport = mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://member-publication.invalid/api/callbacks/publish-image');
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/publish-image',
      headers: Object.fromEntries(new Headers(init?.headers)),
      payload: String(init?.body),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  });
  const output = await withInvocationCredentials(
    { invocationId: headers['x-invocation-id'], callbackToken: headers['x-callback-token'] },
    () => handlePublishImage({ path, publicationKey: 'mcp-fixture' }),
  );
  assert.equal(output.isError, undefined, JSON.stringify(output));
  const result = JSON.parse(output.content[0]?.text ?? '{}');
  assert.ok(messages.getById(result.messageId));
  assert.equal(transport.mock.callCount(), 1);
});

test('concurrent exact retries and a new invocation reuse one durable message and one image', async () => {
  const responses = await Promise.all(Array.from({ length: 5 }, () => send()));
  for (const response of responses) assert.equal(response.statusCode, 200, response.body);
  const first = responses[0]?.json();
  assert.ok(first);
  assert.equal(new Set(responses.map((r) => r.json().messageId)).size, 1);
  const next = await registry.create('operator', 'codex-astra', 'thread-cover');
  const retry = await send(payload, { 'x-invocation-id': next.invocationId, 'x-callback-token': next.callbackToken });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().messageId, first.messageId);
  assert.equal(retry.json().revision, first.revision);
  assert.equal(messages.getByThread('thread-cover').length, 1);
  assert.equal((await readdir(dir)).length, 1);
});

test('same key with different bytes or display metadata conflicts without returning the old image as new', async () => {
  const first = await send();
  assert.equal(first.statusCode, 200);
  const other = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff0000' } })
    .png()
    .toBuffer();
  for (const changed of [
    { ...payload, imageBase64: other.toString('base64') },
    { ...payload, title: 'Different' },
  ]) {
    const response = await send(changed);
    assert.equal(response.statusCode, 409, response.body);
  }
  assert.equal(messages.getByThread('thread-cover').length, 1);
  assert.deepEqual(await readFile(join(dir, first.json().url.slice(9))), Buffer.from(payload.imageBase64, 'base64'));
});

test('a recalled publication cannot be returned as a fresh readable receipt on retry', async () => {
  const first = await send();
  const message = messages.getById(first.json().messageId);
  assert.ok(message);
  message.recall = { recalledBy: 'operator', recalledAt: Date.now() };
  const retry = await send();
  assert.equal(retry.statusCode, 409, retry.body);
  assert.equal(messages.getByThread('thread-cover').length, 1);
});

for (const mode of ['softDelete', 'tombstone']) {
  test(`a ${mode} publication cannot be returned as a readable receipt`, async () => {
    const first = await send();
    const id = first.json().messageId;
    const message = messages.getById(id);
    assert.ok(message);
    if (mode === 'softDelete') assert.ok(messages.softDelete(id, 'operator')?.deletedAt);
    else message._tombstone = true;
    const retry = await send();
    assert.equal(retry.statusCode, 409, retry.body);
  });
}

test('in-memory hard deletion releases the key, so an explicit retry creates a new receipt', async () => {
  const first = await send();
  assert.ok(messages.hardDelete(first.json().messageId, 'operator')?._tombstone);
  const retry = await send();
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().status, 'published');
  assert.notEqual(retry.json().messageId, first.json().messageId);
});

test('an append crash leaves a recoverable immutable file, and conflicting retries cannot claim it', async () => {
  const append = messages.appendIdempotent.bind(messages);
  let crash = true;
  messages.appendIdempotent = (message) => {
    if (crash) {
      crash = false;
      throw new Error('injected append crash');
    }
    return append(message);
  };
  assert.equal((await send()).statusCode, 500);
  assert.equal(messages.getByThread('thread-cover').length, 0);
  assert.equal((await readdir(dir)).length, 1);
  const changed = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  assert.equal((await send({ ...payload, imageBase64: changed.toString('base64') })).statusCode, 409);
  const recovered = await send();
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().status, 'published');
  assert.equal(messages.getByThread('thread-cover').length, 1);
  assert.equal((await readdir(dir)).length, 1);
});

test('concurrent different bytes have one immutable winner, not two successful publications', async () => {
  const changed = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  const results = await Promise.all([send(), send({ ...payload, imageBase64: changed.toString('base64') })]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(messages.getByThread('thread-cover').length, 1);
  assert.equal((await readdir(dir)).length, 1);
});

test('missing, forged, stale, restricted and deleted-thread credentials cannot publish', async () => {
  for (const auth of [{}, { ...headers, 'x-callback-token': 'forged' }])
    assert.equal((await send(payload, auth)).statusCode, 401);
  deleted = true;
  assert.equal((await send()).statusCode, 410);
  deleted = false;
  const restricted = await registry.create('operator', 'codex-astra', 'thread-cover', undefined, undefined, {
    mode: 'read_only',
    replayDeniedToolNames: [],
  });
  assert.equal(
    (await send(payload, { 'x-invocation-id': restricted.invocationId, 'x-callback-token': restricted.callbackToken }))
      .statusCode,
    403,
  );
  assert.notEqual((await send()).statusCode, 200);
  assert.equal(messages.getByThread('thread-cover').length, 0);
  assert.equal((await readdir(dir)).length, 0);
});

test('rejects identity selectors and malformed or non-PNG bytes before publication', async () => {
  for (const body of [
    { ...payload, threadId: 'another-thread' },
    { ...payload, catId: 'sonnet' },
    { ...payload, userId: 'another-owner' },
    { ...payload, imageBase64: 'not-base64' },
    { ...payload, imageBase64: Buffer.from('PNG pretender').toString('base64') },
  ]) {
    assert.equal((await send(body)).statusCode, 400);
  }
  assert.equal(messages.getByThread('thread-cover').length, 0);
  assert.equal((await readdir(dir)).length, 0);
});

test('two actual published messages enter F232/F138 and the existing review on one Task/content lineage', async (t) => {
  const response = await send();
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  const message = messages.getById(result.messageId);
  assert.ok(message);
  const fixture = createReviewFixture(join(dir, 'content-owner'), dir);
  fixture.messages.clear();
  fixture.messages.set(message.id, message);
  assert.ok(fixture.task.current?.entrustedWork);
  fixture.task.current.entrustedWork.artifactRefs = [result.url];
  const prepared = await fixture.media.prepare({
    ...fixture.prepare,
    artifactRef: result.url,
    expectedArtifactRevision: result.revision,
    principal: reviewCat,
  });
  assert.equal(prepared.ownerRevision, 1);
  const retained = await fixture.media.bytes(prepared.contentRef, prepared.ownerRevision, reviewCat);
  assert.deepEqual(retained, Buffer.from(payload.imageBase64, 'base64'));
  const store = new ArtifactReviewStore(join(dir, 'review.sqlite'));
  t.after(() => store.close());
  const service = new ArtifactReviewService({ store, media: fixture.media });
  let view = await service.prepare(
    {
      taskId: 'task-cover',
      expectedTaskRevision: 1,
      artifactRef: result.url,
      expectedArtifactRevision: result.revision,
      operationId: 'review-v1',
    },
    reviewCat,
  );
  fixture.task.current.entrustedWork.artifactRefs = [`content:${prepared.contentRef}`];
  fixture.task.current.entrustedWork.revision = 2;
  view = await service.read(view.review.reviewId, reviewCat);
  const nextBytes = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#123456' } })
    .png()
    .toBuffer();
  const second = await send({ ...payload, publicationKey: 'v2', imageBase64: nextBytes.toString('base64') });
  assert.equal(second.statusCode, 200, second.body);
  const next = second.json();
  const secondMessage = messages.getById(next.messageId);
  assert.ok(secondMessage);
  fixture.messages.set(secondMessage.id, secondMessage);
  const changed = await service.respond(
    {
      reviewId: view.review.reviewId,
      expectedRevision: view.review.revision,
      expectedTaskRevision: 2,
      expectedOwnerRevision: prepared.ownerRevision,
      operationId: 'review-v2',
      artifactRef: next.url,
      expectedArtifactRevision: next.revision,
      responses: [],
    },
    reviewCat,
  );
  assert.equal(changed.view.review.contentRef, prepared.contentRef);
  assert.equal(changed.view.review.rounds.length, 2);
  assert.deepEqual(await fixture.media.bytes(prepared.contentRef, 2, reviewCat), nextBytes);
  assert.deepEqual(
    await fixture.media.bytes(prepared.contentRef, 1, reviewCat),
    Buffer.from(payload.imageBase64, 'base64'),
  );
  assert.deepEqual(fixture.task.current.entrustedWork.artifactRefs, [`content:${prepared.contentRef}`]);
  assert.equal(fixture.task.current.ownerCatId, 'codex-astra');
  assert.equal(fixture.task.current.status, 'doing');
});
