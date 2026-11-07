import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { createWorkAuthorizer, workMediaPrincipal } from '../src/domains/collaborative-content/works/access.js';
import { WorkCoverService } from '../src/domains/collaborative-content/works/cover/cover-service.js';
import { locateUploadedFile } from '../src/domains/collaborative-content/works/cover/cover-upload-locator.js';
import { LivingWorkService } from '../src/domains/collaborative-content/works/service.js';
import { WorkVideoContextService } from '../src/domains/collaborative-content/works/video-context.js';
import { createWorkWorkspaceSource } from '../src/domains/collaborative-content/works/workspace-source.js';
import { readPublishedMessageItem } from '../src/domains/video-studio/content-owner/published-message-media.js';
import { VideoProjectAssetIndex } from '../src/domains/video-studio/project/asset-index.js';
import { registerLivingWorkRoutes } from '../src/routes/living-work-routes.js';
import { registerPublishedContentRoutes } from '../src/routes/published-content-routes.js';
import { registerWorkCoverRoutes } from '../src/routes/work-cover-routes.js';
import { registerWorkVideoAssetRoutes } from '../src/routes/work-video-asset-routes.js';
import { createReviewFixture } from './helpers/artifact-review-fixture.js';
import { screeningFixture } from './helpers/video-project-screening.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const png = (mark: string) => Buffer.concat([PNG, Buffer.from(mark)]);
const sha = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function coverJourney(t: import('node:test').TestContext) {
  const film = await screeningFixture();
  t.after(film.cleanup);
  const previousUploadDir = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = film.root;
  t.after(() => {
    if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUploadDir;
  });
  const store = new ArtifactReviewStore(`${film.root}/work-review.sqlite`);
  const f = createReviewFixture(film.dataDir, film.root, store);
  f.task.current = null;
  const registry = new InvocationRegistry();
  const invocation = (cat: string, readOnly = false) =>
    registry.create(
      'operator',
      createCatId(cat),
      'thread-cover',
      undefined,
      undefined,
      readOnly ? { mode: 'read_only', replayDeniedToolNames: [] } : undefined,
      undefined,
      'strict',
    );
  const producer = await invocation('codex-astra');
  const otherCat = await invocation('codex61-sol');
  const readOnly = await invocation('kimi', true);
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
  const human = (
    principal: Parameters<typeof service.authorizeVersion>[1],
    ref: { contentRef: string; ownerRevision: number },
  ) =>
    principal.actor.kind === 'human' && !principal.threadId
      ? { ...principal, threadId: store.works.get(principal.userId, ref.contentRef, ref.ownerRevision)?.threadId ?? '' }
      : principal;
  const contexts = new WorkVideoContextService({
    store: store.works.contexts,
    authorize: (reference, principal, permission) =>
      service.authorizeVersion(reference, human(principal, reference), permission),
    media: async (reference, principal) => {
      const asset = await f.media.read(reference.contentRef, reference.ownerRevision, workMediaPrincipal(principal));
      if (asset.media.kind !== 'video') throw new Error('video required');
      return asset.media;
    },
  });
  const assets = new VideoProjectAssetIndex({
    resolveRoot: async (rootId) => {
      assert.equal(rootId, 'root');
      return { canonicalWorktreeId: 'root', root: film.root };
    },
  });
  const opened: string[] = [];
  const covers = new WorkCoverService({
    store: store.works.covers,
    authorize: (reference, principal, permission) =>
      service.authorizeVersion(reference, human(principal, reference), permission),
    mediaType: async (reference, principal) =>
      (await service.read(reference, human(principal, reference))).description.mediaType,
    readContext: (reference, principal, revision) => contexts.read(reference, principal, revision),
    authorizeThread: (threadId, principal) => f.access.authorizeThread(threadId, workMediaPrincipal(principal)),
    readMessageItem: (source, principal) =>
      readPublishedMessageItem(f.messageStore, source, workMediaPrincipal(principal)),
    locateUpload: (fileName) =>
      locateUploadedFile(fileName, {
        uploadDir: film.root,
        roots: async () => [{ id: 'root', root: film.root }],
        resolve: async (locator) => locator,
      }),
    inspect: (locator) => assets.inspect(locator),
    threadOf: (reference, principal) => human(principal, reference).threadId,
    open: (version) => {
      opened.push(version.locator.path);
      return assets.open(version);
    },
  });
  service.attachCovers(covers);
  const app = Fastify();
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId =
      typeof request.headers['x-fixture-user'] === 'string' ? request.headers['x-fixture-user'] : null;
  });
  await registerLivingWorkRoutes(app, { service, registry, contexts, covers });
  await registerWorkCoverRoutes(app, { covers });
  registerWorkVideoAssetRoutes(app, { contexts, assets });
  registerPublishedContentRoutes(app, { media: f.media });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const headers = (value = producer) => ({
    'x-invocation-id': value.invocationId,
    'x-callback-token': value.callbackToken,
  });
  const call = async (command: unknown, auth = headers()) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/work',
      headers: auth,
      payload: { command },
    });
    return {
      status: response.statusCode,
      body: response.statusCode === 200 ? JSON.parse(response.json().json) : response.json(),
    };
  };
  const person = { 'x-fixture-user': 'operator' };
  const setByPerson = (command: unknown) =>
    app.inject({ method: 'POST', url: '/api/works/cover', headers: person, payload: { command } });
  const readByPerson = (reference: { contentRef: string; ownerRevision: number }) =>
    app.inject({
      method: 'GET',
      url: `/api/works/cover?contentRef=${encodeURIComponent(reference.contentRef)}&ownerRevision=${reference.ownerRevision}`,
      headers: person,
    });
  const inspected = await call({ action: 'inspect-source', locator: { worktreeId: 'root', path: 'movie.mp4' } });
  assert.equal(inspected.status, 200);
  const created = await call({
    action: 'create',
    operationId: 'first-cut',
    title: '寄自猫猫星球',
    changeSummary: '第一版',
    source: inspected.body.source,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return {
    film,
    f,
    store,
    call,
    headers,
    otherCat,
    readOnly,
    setByPerson,
    readByPerson,
    person,
    app,
    opened,
    covers,
    r1: created.body.reference,
  };
}

async function newCut(j: Awaited<ReturnType<typeof coverJourney>>, name: string, color: string) {
  await promisify(execFile)(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=160x96:r=30:d=1`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(j.film.root, name),
    ],
    { timeout: 15000 },
  );
  return (await j.call({ action: 'inspect-source', locator: { worktreeId: 'root', path: name } })).body.source;
}

const chatPick = (j: Awaited<ReturnType<typeof coverJourney>>) => ({
  kind: 'thread-image',
  threadId: 'thread-cover',
  messageId: j.f.publication.id,
  messageRevision: String(j.f.publication.timestamp),
  item: { kind: 'media-gallery', blockId: 'image', itemIndex: 0 },
  expectedUrl: '/uploads/cover.png',
});
const recall = (j: Awaited<ReturnType<typeof coverJourney>>) => {
  j.f.publication.recall = { recalledAt: 12345, recalledBy: 'operator' } as typeof j.f.publication.recall;
};

async function registerCoverAssets(j: Awaited<ReturnType<typeof coverJourney>>) {
  const at = '2026-11-02T00:00:00.000Z';
  const files = { 'cover-b.png': png('B horizontal'), 'cover-b-vertical.png': png('B vertical') };
  const versions = await Promise.all(
    Object.entries(files).map(async ([path, bytes]) => {
      await writeFile(join(j.film.root, path), bytes);
      return {
        id: `${path}@1`,
        mediaType: 'image/png',
        byteLength: bytes.length,
        sha256: sha(bytes),
        locator: { kind: 'workspace', rootId: 'root', path },
        recordedAt: at,
        origin: { kind: 'imported', actor: null, at, refs: [`films:${path}`] },
      };
    }),
  );
  const saved = await j.call({
    action: 'set-context',
    reference: j.r1,
    operationId: 'register-covers',
    expectedMetadataRevision: 0,
    context: {
      format: 'video',
      extractorVersion: 'cover-test',
      provenance: [{ ref: 'films:e8fdf26', digest: sha(files['cover-b.png']) }],
      story: [],
      assets: versions.map((version, index) => ({
        asset: {
          id: index ? 'cover-b-vertical' : 'cover-b',
          name: index ? '封面 B 竖版' : '封面 B 横版',
          kind: 'cover',
          versions: [version],
        },
        versionId: version.id,
        uses: ['release-cover'],
      })),
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return files;
}

test('people and cats adopt, change, undo and clear one exact cover without touching the film', async (t) => {
  const j = await coverJourney(t);
  const files = await registerCoverAssets(j);
  const before = await j.call({ action: 'read-cover', reference: j.r1 });
  assert.deepEqual(before.body, { reference: j.r1, coverRevision: 0, state: 'none' });
  const adopt = {
    action: 'set-cover',
    reference: j.r1,
    operationId: 'cat-adopts-b',
    expectedCoverRevision: 0,
    choice: { mode: 'image', pick: { kind: 'work-asset', ownerRevision: 1, metadataRevision: 1, assetId: 'cover-b' } },
  };
  assert.equal((await j.call(adopt, j.headers(j.otherCat))).status, 403, 'reading a work never grants its cover');
  assert.equal((await j.call(adopt, j.headers(j.readOnly))).status, 403);
  const adopted = await j.call(adopt);
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  assert.equal(adopted.body.record.coverRevision, 1);
  assert.equal(adopted.body.cover.state, 'image');
  assert.equal(adopted.body.cover.image.sha256, sha(files['cover-b.png']));
  assert.deepEqual((await j.call(adopt)).body.record, adopted.body.record, 'same operation returns the same receipt');
  assert.equal(
    (await j.call({ ...adopt, choice: { mode: 'frame' } })).status,
    409,
    'a reused operation id cannot carry another intent',
  );
  assert.equal((await j.call({ ...adopt, operationId: 'stale' })).status, 409, 'stale cover revision is rejected');

  const seen = await j.readByPerson(j.r1);
  assert.equal(seen.statusCode, 200, seen.body);
  assert.equal(seen.json().coverRevision, 1);
  assert.equal(seen.json().state, 'image');
  const bytes = await j.app.inject({ method: 'GET', url: seen.json().image.url, headers: j.person });
  assert.equal(bytes.statusCode, 200, bytes.body);
  assert.deepEqual(bytes.rawPayload, files['cover-b.png']);
  assert.equal(
    bytes.headers['cache-control'],
    'private, no-store',
    'fixed cover bytes still depend on revocable source authority',
  );
  assert.equal((await j.app.inject({ method: 'GET', url: seen.json().image.url })).statusCode, 401);

  const film = await j.app.inject({
    method: 'GET',
    url: `/api/content-publications/${encodeURIComponent(j.r1.contentRef)}/media/1`,
    headers: j.person,
  });
  assert.deepEqual(film.rawPayload, j.film.bytes, 'the adopted cover leaves the video bytes unchanged');
  assert.equal((await j.call({ action: 'read', reference: j.r1 })).body.currentOwnerRevision, 1);

  await writeFile(join(j.film.root, 'cover.png'), png('chat picture'));
  const chat = j.f.publication;
  const fromChat = await j.setByPerson({
    action: 'set-cover',
    reference: j.r1,
    operationId: 'person-uses-chat-picture',
    expectedCoverRevision: 1,
    choice: {
      mode: 'image',
      pick: {
        kind: 'thread-image',
        threadId: 'thread-cover',
        messageId: chat.id,
        messageRevision: String(chat.timestamp),
        item: { kind: 'media-gallery', blockId: 'image', itemIndex: 0 },
        expectedUrl: '/uploads/cover.png',
      },
    },
  });
  assert.equal(fromChat.statusCode, 200, fromChat.body);
  assert.equal(fromChat.json().cover.image.origin.kind, 'thread-image');
  const forged = await j.setByPerson({
    action: 'set-cover',
    reference: j.r1,
    operationId: 'forged-url',
    expectedCoverRevision: 2,
    choice: {
      mode: 'image',
      pick: {
        kind: 'thread-image',
        threadId: 'thread-cover',
        messageId: chat.id,
        messageRevision: String(chat.timestamp),
        item: { kind: 'media-gallery', blockId: 'image', itemIndex: 0 },
        expectedUrl: '/uploads/cover-b-vertical.png',
      },
    },
  });
  assert.equal(forged.statusCode, 409, 'a URL never stands in for the persisted message item');

  const undo = await j.setByPerson({
    action: 'set-cover',
    reference: j.r1,
    operationId: 'person-undo',
    expectedCoverRevision: 2,
    choice: { mode: 'restore', coverRevision: 1 },
  });
  assert.equal(undo.statusCode, 200, undo.body);
  assert.equal(undo.json().record.coverRevision, 3);
  assert.equal(undo.json().cover.image.sha256, sha(files['cover-b.png']));
  const lateUndo = await j.setByPerson({
    action: 'set-cover',
    reference: j.r1,
    operationId: 'late-undo',
    expectedCoverRevision: 2,
    choice: { mode: 'restore', coverRevision: 1 },
  });
  assert.equal(lateUndo.statusCode, 409, 'an undo never overwrites a newer choice');
  const cleared = await j.setByPerson({
    action: 'set-cover',
    reference: j.r1,
    operationId: 'person-clears',
    expectedCoverRevision: 3,
    choice: { mode: 'frame' },
  });
  assert.equal(cleared.json().cover.state, 'frame');
  assert.equal((await j.readByPerson(j.r1)).json().coverRevision, 4);
  const vertical = await j.call({
    ...adopt,
    operationId: 'cat-picks-vertical',
    expectedCoverRevision: 4,
    choice: {
      mode: 'image',
      pick: { kind: 'work-asset', ownerRevision: 1, metadataRevision: 1, assetId: 'cover-b-vertical' },
    },
  });
  assert.equal(vertical.body.cover.image.name, '封面 B 竖版', 'only the explicitly picked file becomes the cover');
  j.f.thread.current = null;
  assert.equal((await j.readByPerson(j.r1)).statusCode, 403, 'withdrawn work access blocks the cover read');
});

test('uploads, lost sources and later index updates keep the choice honest', async (t) => {
  const j = await coverJourney(t);
  const files = await registerCoverAssets(j);
  const form = (bytes: Buffer, type: string) => {
    const boundary = '----cover';
    return {
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\nContent-Type: ${type}\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { ...j.person, 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  };
  const rejected = await j.app.inject({
    method: 'POST',
    url: '/api/uploads/work-cover',
    ...form(Buffer.from('<svg/>'), 'image/png'),
  });
  assert.equal(rejected.statusCode, 415);
  const uploaded = await j.app.inject({
    method: 'POST',
    url: '/api/uploads/work-cover',
    ...form(png('uploaded'), 'image/png'),
  });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const uploadUrl = uploaded.json().url as string;
  const pick = { kind: 'upload', uploadUrl };
  const setUpload = {
    action: 'set-cover',
    reference: j.r1,
    operationId: 'upload-cover',
    expectedCoverRevision: 0,
    choice: { mode: 'image', pick },
  };
  assert.equal((await j.call(setUpload)).status, 403, 'a cat cannot adopt a person upload by URL');
  const set = await j.setByPerson(setUpload);
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().cover.image.origin.kind, 'upload');
  assert.deepEqual(await readFile(join(j.film.root, uploadUrl.slice('/uploads/'.length))), png('uploaded'));
  const listed = await j.app.inject({
    method: 'GET',
    url: `/api/works/cover/candidates?contentRef=${encodeURIComponent(j.r1.contentRef)}&ownerRevision=1`,
    headers: j.person,
  });
  assert.equal(listed.statusCode, 200, listed.body);
  const candidates = listed.json().candidates as { name: string; source: string; pick: unknown; previewUrl: string }[];
  assert.deepEqual(
    candidates.map((item) => [item.source, item.name]),
    [
      ['work-asset', '封面 B 横版'],
      ['work-asset', '封面 B 竖版'],
      ['upload', uploadUrl.slice('/uploads/'.length)],
    ],
    'registered assets first, then pictures this work adopted before',
  );
  assert.deepEqual(candidates[2]?.pick, pick);
  const preview = await j.app.inject({ method: 'GET', url: candidates[0]!.previewUrl, headers: j.person });
  assert.deepEqual(preview.rawPayload, files['cover-b.png']);

  const b = await j.setByPerson({
    ...setUpload,
    operationId: 'adopt-b',
    expectedCoverRevision: 1,
    choice: { mode: 'image', pick: { kind: 'work-asset', ownerRevision: 1, metadataRevision: 1, assetId: 'cover-b' } },
  });
  assert.equal(b.json().cover.state, 'image');
  const reindexed = await j.call({
    action: 'set-context',
    reference: j.r1,
    operationId: 'reindex-story',
    expectedMetadataRevision: 1,
    context: {
      format: 'video',
      extractorVersion: 'cover-test-2',
      provenance: [{ ref: 'films:e8fdf26', digest: sha(files['cover-b.png']) }],
      story: [],
      assets: [],
    },
  });
  assert.equal(reindexed.status, 200);
  const kept = await j.readByPerson(j.r1);
  assert.equal(kept.json().coverRevision, 2, 'a later index import never erases the adopted cover');
  assert.equal(kept.json().state, 'image', 'the cover keeps citing its retained metadata revision');

  await unlink(join(j.film.root, 'cover-b.png'));
  const lost = await j.readByPerson(j.r1);
  assert.equal(lost.json().state, 'unavailable');
  assert.equal(lost.json().coverRevision, 2, 'a lost source keeps the choice and never substitutes another picture');
  assert.equal(lost.json().image.name, '封面 B 横版');
  const before = j.opened.length;
  const image = await j.app.inject({ method: 'GET', url: lost.json().image.url, headers: j.person });
  assert.equal(image.statusCode, 404);
  assert.equal(j.opened.length, before, 'unreadable source is refused before bytes are opened');
});

test('a new version freezes the inherited cover at submit and a retry never reads later edits', async (t) => {
  const j = await coverJourney(t);
  await registerCoverAssets(j);
  const adopt = (operationId: string, expectedCoverRevision: number, assetId: string) =>
    j.call({
      action: 'set-cover',
      reference: j.r1,
      operationId,
      expectedCoverRevision,
      choice: { mode: 'image', pick: { kind: 'work-asset', ownerRevision: 1, metadataRevision: 1, assetId } },
    });
  assert.equal((await adopt('r1-b', 0, 'cover-b')).status, 200);
  await promisify(execFile)(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x96:r=30:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(j.film.root, 'movie-v2.mp4'),
    ],
    { timeout: 15000 },
  );
  const next = await j.call({ action: 'inspect-source', locator: { worktreeId: 'root', path: 'movie-v2.mp4' } });
  const submit = {
    action: 'submit',
    contentRef: j.r1.contentRef,
    expectedOwnerRevision: 1,
    operationId: 'second-cut',
    title: '寄自猫猫星球',
    changeSummary: '第二版',
    source: next.body.source,
  };
  const projection = t.mock.method(j.store.works.covers, 'projectSubmission', () => {
    throw new Error('annotation disk unavailable');
  });
  const pending = await j.call(submit);
  assert.equal(pending.status, 503, 'the film is saved while its annotations are pending');
  assert.equal(pending.body.status, 'version_saved');
  const r2 = pending.body.reference;
  assert.equal((await j.readByPerson(r2)).json().state, 'none');
  projection.mock.restore();
  // Someone changes r1 before the identical retry restores r2's annotations.
  assert.equal((await adopt('r1-vertical', 1, 'cover-b-vertical')).status, 200);
  const replay = await j.call(submit);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body.reference, r2);
  const afterEdit = (await j.readByPerson(r2)).json();
  assert.equal(afterEdit.state, 'image');
  assert.deepEqual(afterEdit.basis, { kind: 'inherited', fromOwnerRevision: 1, fromCoverRevision: 1 });
  assert.equal(afterEdit.image.name, '封面 B 横版', 'changing r1 later never reaches the frozen r2 choice');
  assert.equal(afterEdit.coverRevision, 1);
  assert.equal((await j.readByPerson(j.r1)).json().image.name, '封面 B 竖版', 'r1 keeps its own cover');

  const frameSubmit = await j.call({
    ...submit,
    operationId: 'third-cut-video-frame',
    expectedOwnerRevision: 2,
    source: (await j.call({ action: 'inspect-source', locator: { worktreeId: 'root', path: 'movie.mp4' } })).body
      .source,
    cover: { mode: 'frame' },
  });
  assert.equal(frameSubmit.status, 200, JSON.stringify(frameSubmit.body));
  const explicitFrame = (await j.readByPerson(frameSubmit.body.reference)).json();
  assert.equal(explicitFrame.state, 'frame', 'an explicit video frame is not the same as never choosing');
  assert.deepEqual(explicitFrame.basis, { kind: 'submitted' });
});

test('submit keeps never chosen, explicit frame and an inherited clearing apart', async (t) => {
  const j = await coverJourney(t);
  const submit = (operationId: string, expectedOwnerRevision: number, source: unknown, cover?: unknown) =>
    j.call({
      action: 'submit',
      contentRef: j.r1.contentRef,
      expectedOwnerRevision,
      operationId,
      title: '寄自猫猫星球',
      changeSummary: operationId,
      source,
      ...(cover ? { cover } : {}),
    });
  const r2 = await submit('r2-from-none', 1, await newCut(j, 'blue.mp4', 'blue'));
  assert.deepEqual((await j.readByPerson(r2.body.reference)).json().state, 'none', 'nothing was ever chosen');
  const r3 = await submit('r3-frame', 2, await newCut(j, 'green.mp4', 'green'), { mode: 'frame' });
  assert.equal((await j.readByPerson(r3.body.reference)).json().state, 'frame');
  const r4 = await submit('r4-inherits-frame', 3, await newCut(j, 'yellow.mp4', 'yellow'));
  const inherited = (await j.readByPerson(r4.body.reference)).json();
  assert.equal(inherited.state, 'frame', 'inheriting a cleared choice keeps the video frame, never a demo poster');
  assert.deepEqual(inherited.basis, { kind: 'inherited', fromOwnerRevision: 3, fromCoverRevision: 1 });
});

test('source authority is checked again for bytes, restore and replay', async (t) => {
  const j = await coverJourney(t);
  await writeFile(join(j.film.root, 'cover.png'), png('chat picture'));
  const adopt = {
    action: 'set-cover',
    reference: j.r1,
    operationId: 'adopt-chat-picture',
    expectedCoverRevision: 0,
    choice: { mode: 'image', pick: chatPick(j) },
  };
  const adopted = await j.setByPerson(adopt);
  assert.equal(adopted.statusCode, 200, adopted.body);
  const url = adopted.json().cover.image.url;

  let cleaned = 0;
  const open = j.covers.deps.open;
  const during = t.mock.method(j.covers.deps, 'open', async (version: Parameters<typeof open>[0]) => {
    const snapshot = await open(version);
    recall(j); // the source is withdrawn while the byte snapshot is being made
    return {
      ...snapshot,
      cleanup: async () => {
        cleaned++;
        await snapshot.cleanup();
      },
    };
  });
  const bytes = await j.app.inject({ method: 'GET', url, headers: j.person });
  assert.equal(bytes.statusCode, 404, 'a source withdrawn during the snapshot is refused before delivery');
  assert.equal(cleaned, 1, 'the refused snapshot is cleaned up');
  during.mock.restore();
  j.f.publication.recall = undefined;

  const cleared = await j.setByPerson({
    ...adopt,
    operationId: 'clear',
    expectedCoverRevision: 1,
    choice: { mode: 'frame' },
  });
  assert.equal(cleared.statusCode, 200);
  recall(j);
  const restore = await j.setByPerson({
    ...adopt,
    operationId: 'restore-recalled',
    expectedCoverRevision: 2,
    choice: { mode: 'restore', coverRevision: 1 },
  });
  assert.equal(restore.statusCode, 404, 'restoring re-adopts the file, so its source must still be readable');
  const replay = await j.setByPerson(adopt);
  assert.equal(replay.statusCode, 404, 'a replay rechecks the source like the original adoption');
  const kept = (await j.readByPerson(j.r1)).json();
  assert.equal(kept.coverRevision, 2, 'refused writes add no revision');
  assert.equal(kept.state, 'frame');
  assert.equal((await j.app.inject({ method: 'GET', url, headers: j.person })).statusCode, 404);
  const listed = await j.app.inject({
    method: 'GET',
    url: `/api/works/cover/candidates?contentRef=${encodeURIComponent(j.r1.contentRef)}&ownerRevision=1`,
    headers: j.person,
  });
  assert.deepEqual(listed.json().candidates, [], 'a withdrawn picture is not offered again');

  j.f.publication.recall = undefined;
  const submit = {
    action: 'submit',
    contentRef: j.r1.contentRef,
    expectedOwnerRevision: 1,
    operationId: 'r2-with-chat-picture',
    title: '寄自猫猫星球',
    changeSummary: '第二版带对话里的图',
    source: await newCut(j, 'blue.mp4', 'blue'),
    cover: { mode: 'image', pick: chatPick(j) },
  };
  const settle = t.mock.method(j.f.owner, 'settleStream', async () => {
    throw new Error('owner briefly unavailable');
  });
  assert.notEqual((await j.call(submit)).status, 200, 'the cover was frozen but the film was not saved');
  settle.mock.restore();
  recall(j);
  const retried = await j.call(submit);
  assert.equal(retried.status, 503, 'a retried explicit picture is checked again before the film is saved');
  assert.equal((await j.call({ action: 'read', reference: j.r1 })).body.currentOwnerRevision, 1);
});

test('a first submit refuses its explicit picture when the source is withdrawn before the owner effect', async (t) => {
  const j = await coverJourney(t);
  await writeFile(join(j.film.root, 'cover.png'), png('chat picture'));
  const settleStream = j.f.owner.settleStream.bind(j.f.owner);
  // The cover is frozen first; the picture is withdrawn while the owner is about to save the film.
  t.mock.method(j.f.owner, 'settleStream', async (input: Parameters<typeof settleStream>[0]) => {
    recall(j);
    return settleStream(input);
  });
  const submitted = await j.call({
    action: 'submit',
    contentRef: j.r1.contentRef,
    expectedOwnerRevision: 1,
    operationId: 'r2-picture-withdrawn-mid-save',
    title: '寄自猫猫星球',
    changeSummary: '第二版带对话里的图',
    source: await newCut(j, 'blue.mp4', 'blue'),
    cover: { mode: 'image', pick: chatPick(j) },
  });
  assert.equal(submitted.status, 503, 'the newly adopted picture is refused at the owner effect');
  assert.equal(
    (await j.call({ action: 'read', reference: j.r1 })).body.currentOwnerRevision,
    1,
    'the film head does not move for a refused adoption',
  );
});
