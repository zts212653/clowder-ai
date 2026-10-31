import assert from 'node:assert/strict';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import sharp from 'sharp';
import { VideoProjectAssetIndex } from '../src/domains/video-studio/project/asset-index.js';
import { videoProjectRoutes } from '../src/routes/video-project-routes.js';
import { screeningFixture } from './helpers/video-project-screening.js';

async function appFixture(session = true) {
  const fixture = await screeningFixture();
  const screenings = fixture.make();
  const saved = await screenings.register(fixture.request);
  const app = Fastify();
  if (session)
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = fixture.principal.userId;
    });
  await app.register(videoProjectRoutes, { projects: fixture.projects, screenings, mediaSource: fixture.workspace });
  const url = `/api/video-projects/${encodeURIComponent(saved.screening.input.contentRef)}/screenings/${saved.screening.id}`;
  return {
    ...fixture,
    app,
    url,
    saved,
    cleanup: async () => {
      await app.close();
      await fixture.cleanup();
    },
  };
}

test('authenticated screening GET Range reads direct immutable offsets; HEAD and invalid ranges close without buffering', async (t) => {
  const fixture = await appFixture();
  t.after(fixture.cleanup);
  let bufferedMediaReads = 0;
  let streamsOpened = 0;
  const load = fixture.owner.load.bind(fixture.owner);
  fixture.owner.load = async (contentRef, ownerRevision) => {
    if (contentRef.startsWith('video-project-media:')) bufferedMediaReads++;
    return load(contentRef, ownerRevision);
  };
  const open = fixture.owner.open.bind(fixture.owner);
  fixture.owner.open = async (contentRef, ownerRevision) => {
    const opened = await open(contentRef, ownerRevision);
    const createStream = opened.handle.createReadStream.bind(opened.handle);
    opened.handle.createReadStream = (options) => {
      streamsOpened++;
      return createStream(options);
    };
    return opened;
  };
  const noRange = await fixture.app.inject(`${fixture.url}/media`);
  assert.equal(noRange.statusCode, 200);
  assert.deepEqual(noRange.rawPayload, fixture.bytes);
  assert.equal(noRange.headers['accept-ranges'], 'bytes');
  const partial = await fixture.app.inject({ url: `${fixture.url}/media`, headers: { range: 'bytes=30-49' } });
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.headers['content-range'], `bytes 30-49/${fixture.bytes.length}`);
  assert.equal(partial.headers['content-length'], '20');
  assert.deepEqual(partial.rawPayload, fixture.bytes.subarray(30, 50));
  const suffix = await fixture.app.inject({ url: `${fixture.url}/media`, headers: { range: 'bytes=-7' } });
  assert.equal(suffix.statusCode, 206);
  assert.deepEqual(suffix.rawPayload, fixture.bytes.subarray(-7));
  const beforeHeadStreams = streamsOpened;
  const head = await fixture.app.inject({
    method: 'HEAD',
    url: `${fixture.url}/media`,
    headers: { range: 'bytes=30-49' },
  });
  assert.equal(streamsOpened, beforeHeadStreams, 'HEAD creates no byte stream');
  assert.equal(head.statusCode, 206);
  assert.equal(head.rawPayload.length, 0);
  assert.equal(head.headers['content-length'], '20');
  const invalid = await fixture.app.inject({
    url: `${fixture.url}/media`,
    headers: { range: `bytes=${fixture.bytes.length}-` },
  });
  assert.equal(invalid.statusCode, 416);
  assert.equal(invalid.headers['content-range'], `bytes */${fixture.bytes.length}`);
  const multi = await fixture.app.inject({ url: `${fixture.url}/media`, headers: { range: 'bytes=0-1,3-4' } });
  assert.equal(multi.statusCode, 416);
  const descriptor = await fixture.app.inject(fixture.url);
  assert.equal(descriptor.statusCode, 200);
  assert.equal(descriptor.json().mediaUrl, `${fixture.url}/media`);
  assert.ok(!descriptor.body.includes(fixture.root));
  const list = await fixture.app.inject('/api/video-projects');
  assert.equal(list.json().projects.length, 1);
  assert.equal(bufferedMediaReads, 0, 'Range/HEAD/descriptor never buffer the immutable movie');
});

test('project HTTP facade rejects claimed client actor, header-only identity, callbacks and nonlocal peers', async (t) => {
  const fixture = await appFixture(false);
  t.after(fixture.cleanup);
  assert.equal(
    (await fixture.app.inject({ url: '/api/video-projects', headers: { 'x-cat-cafe-user': 'operator' } })).statusCode,
    401,
  );
  const authenticated = await appFixture();
  t.after(authenticated.cleanup);
  for (const headers of [
    { 'x-invocation-id': 'spoof' },
    { 'x-agent-key-secret': 'spoof' },
    { 'x-forwarded-for': '127.0.0.1' },
  ]) {
    assert.equal((await authenticated.app.inject({ url: authenticated.url, headers })).statusCode, 401);
  }
  const { principal: omitted, contentRef: omittedRef, ...body } = authenticated.request;
  void omitted;
  void omittedRef;
  assert.equal(
    (
      await authenticated.app.inject({
        method: 'POST',
        url: `/api/video-projects/${encodeURIComponent(authenticated.request.contentRef)}/screenings`,
        payload: { ...body, actor: { kind: 'cat', actorId: 'sol' } },
      })
    ).statusCode,
    400,
  );
});

test('ordinary import/source selection and exact historical input are available through the session facade', async (t) => {
  const fixture = await appFixture();
  t.after(fixture.cleanup);
  const source = await fixture.app.inject({
    method: 'POST',
    url: '/api/video-projects/media-source',
    payload: { locator: fixture.request.source.locator },
  });
  assert.equal(source.statusCode, 200);
  assert.equal(source.json().revision, fixture.request.source.expectedSourceRevision);
  assert.equal(source.json().media.kind, 'video');
  const historical = await fixture.app.inject(
    `/api/video-projects/${encodeURIComponent(fixture.request.contentRef)}?ownerRevision=1`,
  );
  assert.equal(historical.statusCode, 200);
  assert.equal(historical.json().ownerRevision, 1);
  assert.equal(historical.json().document.screenings, undefined);
  assert.equal(
    (await fixture.app.inject(`/api/video-projects/${encodeURIComponent(fixture.request.contentRef)}?ownerRevision=0`))
      .statusCode,
    400,
  );
  const document = (await fixture.projects.load({ ...fixture.request, ownerRevision: 1 })).document;
  const created = await fixture.app.inject({
    method: 'POST',
    url: '/api/video-projects',
    payload: { operationId: 'import-from-workspace-ui', document },
  });
  assert.equal(created.statusCode, 200);
  assert.ok(created.json().contentRef.startsWith('video-project:'));
  const forged = await fixture.app.inject({
    method: 'POST',
    url: '/api/video-projects',
    payload: { operationId: 'forged-facts', document: { ...document, screenings: [fixture.saved.screening] } },
  });
  assert.equal(forged.statusCode, 400);
});

test('indexed artwork facade pins exact input and reports missing/changed without newer-version substitution', async (t) => {
  const fixture = await appFixture();
  t.after(fixture.cleanup);
  const path = join(fixture.root, 'artwork.png');
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f5edda' } })
    .png()
    .toBuffer();
  await writeFile(path, bytes);
  const index = new VideoProjectAssetIndex({
    resolveRoot: async () => ({ root: fixture.root, canonicalWorktreeId: 'root' }),
  });
  const observed = await index.inspect({ kind: 'workspace', rootId: 'root', path: 'artwork.png' });
  const base = await fixture.projects.load(fixture.request);
  const version = {
    id: 'art-v1',
    ...observed,
    mediaType: 'image/png',
    width: 8,
    height: 8,
    recordedAt: '2026-10-10T00:00:00.000Z',
    origin: base.document.origin,
  };
  const document = { ...base.document, assets: [{ id: 'art', name: 'artwork', kind: 'image', versions: [version] }] };
  await fixture.projects.save({ ...fixture.request, expectedOwnerRevision: 2, operationId: 'index-art', document });
  const url = `/api/video-projects/${encodeURIComponent(fixture.request.contentRef)}/assets/art-v1?ownerRevision=3`;
  const image = await fixture.app.inject(url);
  assert.equal(image.statusCode, 200);
  assert.deepEqual(image.rawPayload, bytes);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.equal(image.headers['cache-control'], 'private, no-store');
  assert.equal((await fixture.app.inject(url.replace('ownerRevision=3', 'ownerRevision=1'))).statusCode, 404);
  const mp4 = {
    ...version,
    id: 'movie-asset',
    mediaType: 'video/mp4',
    width: 160,
    height: 96,
    locator: { kind: 'workspace' as const, rootId: 'root', path: 'movie.mp4' },
    sha256: fixture.request.source.expectedSourceRevision,
    byteLength: fixture.bytes.length,
  };
  await fixture.projects.save({
    ...fixture.request,
    expectedOwnerRevision: 3,
    operationId: 'index-mp4',
    document: {
      ...document,
      assets: [...document.assets, { id: 'movie-asset', name: 'movie', kind: 'video', versions: [mp4] }],
    },
  });
  let bufferedAssetReads = 0;
  const readAsset = fixture.projects.readAsset.bind(fixture.projects);
  fixture.projects.readAsset = async (input) => {
    bufferedAssetReads++;
    return readAsset(input);
  };
  const movie = await fixture.app.inject(
    `/api/video-projects/${encodeURIComponent(fixture.request.contentRef)}/assets/movie-asset?ownerRevision=4`,
  );
  assert.equal(movie.statusCode, 415);
  assert.equal(bufferedAssetReads, 0, 'the image facade never buffers a general MP4 asset');
  await writeFile(path, 'different bytes');
  const changed = await fixture.app.inject(url);
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error, 'asset_changed');
  await unlink(path);
  const missing = await fixture.app.inject(url);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'asset_missing');
  const receipt = await fixture.app.inject(
    `/api/video-projects/${encodeURIComponent(fixture.request.contentRef)}/operations/${fixture.request.operationId}`,
  );
  assert.equal(receipt.statusCode, 200);
  assert.equal(receipt.json().receipt.ownerRevision, 2);
  const unknown = await fixture.app.inject(
    `/api/video-projects/${encodeURIComponent(fixture.request.contentRef)}/operations/never-settled`,
  );
  assert.deepEqual(unknown.json(), { receipt: null });
});
