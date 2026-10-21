import assert from 'node:assert/strict';
import { unlink, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { createWorkAuthorizer, workMediaPrincipal } from '../src/domains/collaborative-content/works/access.js';
import { createWorkContextSource } from '../src/domains/collaborative-content/works/context-source.js';
import { LivingWorkService } from '../src/domains/collaborative-content/works/service.js';
import { WorkVideoContextService } from '../src/domains/collaborative-content/works/video-context.js';
import { createWorkWorkspaceSource } from '../src/domains/collaborative-content/works/workspace-source.js';
import { VideoProjectAssetIndex } from '../src/domains/video-studio/project/asset-index.js';
import { registerLivingWorkRoutes } from '../src/routes/living-work-routes.js';
import { registerPublishedContentRoutes } from '../src/routes/published-content-routes.js';
import { registerWorkVideoAssetRoutes } from '../src/routes/work-video-asset-routes.js';
import { createReviewFixture } from './helpers/artifact-review-fixture.js';
import { screeningFixture } from './helpers/video-project-screening.js';

test('common HTTP/callback entry retains real video, authenticates production, and serves an exact Range after source deletion', async (t) => {
  const film = await screeningFixture();
  t.after(film.cleanup);
  const store = new ArtifactReviewStore(`${film.root}/work-review.sqlite`);
  const f = createReviewFixture(film.dataDir, film.root, store);
  f.task.current = null;
  f.messages.clear();
  const registry = new InvocationRegistry();
  const createInvocation = (cat = 'codex-astra', strict = true, readOnly = false) =>
    registry.create(
      'operator',
      createCatId(cat),
      'thread-cover',
      undefined,
      undefined,
      readOnly ? { mode: 'read_only', replayDeniedToolNames: [] } : undefined,
      undefined,
      strict ? 'strict' : 'unknown',
    );
  const credentials = await createInvocation();
  const unknown = await createInvocation('codex-sol', false);
  const readOnly = await createInvocation('kimi', true, true);
  const otherCat = await createInvocation('codex61-sol');
  const service = new LivingWorkService({
    owner: f.owner,
    versions: store.works,
    source: createWorkWorkspaceSource(film.workspace),
    authorize: createWorkAuthorizer({
      ownerUserId: 'operator',
      access: f.access,
      invocation: (id) => registry.peekRecord(id),
    }),
  });
  const app = Fastify();
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId =
      typeof request.headers['x-fixture-user'] === 'string' ? request.headers['x-fixture-user'] : null;
  });
  const contexts = new WorkVideoContextService({
    store: store.works.contexts,
    contextSource: createWorkContextSource(film.workspace),
    authorize: (reference, principal, permission) => service.authorizeVersion(reference, principal, permission),
    media: async (reference, principal) => {
      const asset = await f.media.read(reference.contentRef, reference.ownerRevision, workMediaPrincipal(principal));
      assert.equal(asset.media.kind, 'video');
      if (asset.media.kind !== 'video') throw new Error('video required');
      return asset.media;
    },
  });
  await registerLivingWorkRoutes(app, { service, registry, contexts });
  registerWorkVideoAssetRoutes(app, {
    contexts,
    assets: new VideoProjectAssetIndex({
      resolveRoot: async (rootId) => {
        assert.equal(rootId, 'root');
        return { canonicalWorktreeId: 'root', root: film.root };
      },
    }),
  });
  registerPublishedContentRoutes(app, { media: f.media });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const headers = (value = credentials) => ({
    'x-invocation-id': value.invocationId,
    'x-callback-token': value.callbackToken,
  });
  const call = (command: unknown, auth = headers(), extra = {}) =>
    app.inject({ method: 'POST', url: '/api/callbacks/work', headers: auth, payload: { command, ...extra } });
  const inspected = await call({ action: 'inspect-source', locator: { worktreeId: 'root', path: 'movie.mp4' } });
  assert.equal(inspected.statusCode, 200, inspected.body);
  const inspection = JSON.parse(inspected.json().json);
  const source = inspection.source;
  assert.equal(
    inspection.media?.kind,
    'video',
    'the director needs the frozen new source clock before mapping a result position',
  );
  const command = {
    action: 'create',
    operationId: 'deliver-first-cut',
    title: '真实独立作品',
    changeSummary: '首次交片',
    source,
  };
  assert.equal((await call(command, {})).statusCode, 401);
  assert.equal((await call(command, headers(unknown))).statusCode, 403);
  assert.equal((await call(command, headers(readOnly))).statusCode, 403);
  assert.equal((await call(command, headers(), { threadId: 'other-thread' })).statusCode, 403);
  assert.equal((await call({ ...command, actor: { kind: 'human', actorId: 'operator' } })).statusCode, 400);
  const created = await call(command);
  assert.equal(created.statusCode, 200, created.body);
  assert.ok(created.body.length <= 12000);
  const saved = JSON.parse(created.json().json);
  assert.equal(saved.reference.ownerRevision, 1);
  const retained = await f.media.read(saved.reference.contentRef, 1, {
    userId: 'operator',
    actor: { kind: 'human', actorId: 'operator' },
  });
  assert.deepEqual(inspection.media, retained.media, 'inspection and publication describe the same exact source bytes');
  const delivered = await call({ action: 'publish-reference', reference: saved.reference });
  assert.equal(delivered.statusCode, 200, delivered.body);
  assert.deepEqual(JSON.parse(delivered.json().json).block.meta.reference, saved.reference);
  assert.equal(f.task.current, null);
  assert.equal(f.messages.size, 0);
  const human = await app.inject({
    method: 'POST',
    url: '/api/works/command',
    headers: { 'x-fixture-user': 'operator' },
    payload: { threadId: 'thread-cover', command: { ...command, operationId: 'human-original' } },
  });
  assert.equal(human.statusCode, 200, human.body);
  assert.notEqual(human.json().reference.contentRef, saved.reference.contentRef);
  const indexedAsset = {
    id: 'sample',
    name: '原片参考',
    kind: '视频',
    versions: [
      {
        id: 'release',
        mediaType: 'video/mp4',
        byteLength: film.bytes.length,
        sha256: source.expectedSourceRevision,
        locator: { kind: 'workspace', rootId: 'root', path: 'movie.mp4' },
        recordedAt: '2026-10-20T00:00:00.000Z',
        origin: { kind: 'imported', actor: null, at: '2026-10-20T00:00:00.000Z', refs: ['fixture'] },
      },
    ],
  };
  const indexed = await call({
    action: 'set-context',
    reference: saved.reference,
    expectedMetadataRevision: 0,
    operationId: 'metadata-v1',
    context: {
      format: 'video',
      extractorVersion: 'fixture-v1',
      provenance: [{ ref: 'fixture', digest: source.expectedSourceRevision }],
      story: [],
      assets: [
        { asset: indexedAsset, versionId: 'release', uses: ['原片参考'] },
        // Header admission is independent from codec decoding. All rows deliberately
        // use the same immutable fixture bytes to exercise only the MIME boundary.
        ...['video/webm', 'image/svg+xml'].map((mediaType, i) => ({
          asset: { ...indexedAsset, id: `mime-${i}`, versions: [{ ...indexedAsset.versions[0], mediaType }] },
          versionId: 'release',
          uses: ['素材 MIME 准入'],
        })),
      ],
    },
  });
  assert.equal(indexed.statusCode, 200, indexed.body);
  const assetRoute = `/api/works/${encodeURIComponent(saved.reference.contentRef)}/video-assets/1/1/sample?threadId=thread-cover`;
  assert.equal((await app.inject({ method: 'GET', url: assetRoute })).statusCode, 401);
  const indexedRange = await app.inject({
    method: 'GET',
    url: assetRoute,
    headers: { 'x-fixture-user': 'operator', range: 'bytes=16-31' },
  });
  assert.equal(indexedRange.statusCode, 206, indexedRange.body);
  assert.deepEqual(indexedRange.rawPayload, film.bytes.subarray(16, 32));
  for (const [i, expected] of ['video/webm', 'application/octet-stream'].entries()) {
    const response = await app.inject({
      method: 'GET',
      url: assetRoute.replace('/sample?', `/mime-${i}?`),
      headers: { 'x-fixture-user': 'operator', range: 'bytes=16-31' },
    });
    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-type'], expected);
    assert.equal(response.headers['content-disposition'], i === 0 ? 'inline' : 'attachment');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(response.rawPayload, film.bytes.subarray(16, 32));
  }
  assert.equal((await call({ action: 'read-context', reference: saved.reference })).statusCode, 200);
  // Real indices exceed a locator-sized command (voices + images + paragraphs).
  // Keep the command limit; load only this authorized, digest-bound JSON snapshot.
  const indexContext = {
    format: 'video',
    extractorVersion: 'actual-large-index',
    provenance: [{ ref: 'timeline.json', digest: source.expectedSourceRevision }],
    story: Array.from({ length: 100 }, (_, i) => ({
      id: `line-${i}`,
      title: '原话',
      text: '原文不截断'.repeat(100),
      streamId: 'video:0',
      startPts: 0,
      endPts: 1,
    })),
    assets: [],
  };
  const asset = await f.media.read(saved.reference.contentRef, 1, {
    userId: 'operator',
    actor: { kind: 'human', actorId: 'operator' },
  });
  assert.equal(asset.media.kind, 'video');
  if (asset.media.kind !== 'video') throw new Error('video required');
  for (const line of indexContext.story) {
    line.streamId = asset.media.streamId;
    line.startPts = asset.media.startTick;
    line.endPts = asset.media.startTick + 1;
  }
  const indexText = JSON.stringify(indexContext);
  assert.ok(Buffer.byteLength(indexText) > 32 * 1024);
  await writeFile(`${film.root}/work-index.json`, indexText);
  const indexSource = await film.workspace.describe({
    principal: { userId: 'operator' },
    locator: { worktreeId: 'root', path: 'work-index.json' },
  });
  const importIndex = {
    action: 'import-context',
    reference: saved.reference,
    operationId: 'large-index',
    expectedMetadataRevision: 1,
    source: { worktreeId: 'root', path: 'work-index.json', expectedSourceRevision: indexSource.revision },
  };
  const imported = await call(importIndex);
  assert.equal(imported.statusCode, 200, imported.body);
  let indexJson = imported.json().json;
  let cursor = imported.json().nextCursor;
  while (cursor !== null) {
    const page = await call(importIndex, headers(), { cursor, expectedSnapshot: imported.json().snapshot });
    assert.equal(page.statusCode, 200, page.body);
    indexJson += page.json().json;
    cursor = page.json().nextCursor;
  }
  const readIndex = JSON.parse(indexJson);
  assert.equal(readIndex.metadataRevision, 2);
  assert.equal(readIndex.context.story.length, 100);
  assert.equal((await call(importIndex, headers(readOnly))).statusCode, 403);
  await unlink(`${film.root}/work-index.json`);
  assert.deepEqual(
    (await call(importIndex)).json(),
    imported.json(),
    'same receipt replays without reopening a removed source',
  );
  const oversizedCommand = await call({
    action: 'set-context',
    reference: saved.reference,
    operationId: 'inline-is-still-bounded',
    expectedMetadataRevision: 2,
    context: indexContext,
  });
  assert.equal(oversizedCommand.statusCode, 413, 'No global command-body increase');
  assert.equal(
    (
      await call(
        {
          ...command,
          action: 'submit',
          contentRef: saved.reference.contentRef,
          expectedOwnerRevision: 1,
          operationId: 'unauthorized-edit',
        },
        headers(otherCat),
      )
    ).statusCode,
    403,
  );
  await unlink(film.path);
  const replay = await call(command);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(JSON.parse(replay.json().json), saved);
  const media = await app.inject({
    method: 'GET',
    url: `/api/content-publications/${encodeURIComponent(saved.reference.contentRef)}/media/1`,
    headers: { 'x-fixture-user': 'operator', range: 'bytes=16-31' },
  });
  assert.equal(media.statusCode, 206, media.body);
  assert.deepEqual(media.rawPayload, film.bytes.subarray(16, 32));
  assert.equal(media.headers['content-range'], `bytes 16-31/${film.bytes.length}`);
  const humanCreated = await app.inject({
    method: 'POST',
    url: '/api/works/command',
    headers: { 'x-fixture-user': 'operator' },
    payload: { threadId: 'thread-cover', command: { ...command, operationId: 'separate-human-work' } },
  });
  assert.equal(humanCreated.statusCode, 404, 'new import cannot read the deleted original');
  f.thread.current = null;
  assert.equal((await call({ action: 'read', reference: saved.reference })).statusCode, 403);
});
