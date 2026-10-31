import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import Fastify from 'fastify';
import { capabilityEvolutionProgramRoutes } from '../dist/routes/capability-evolution-program-routes.js';

const id = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
const ref = (name) => ({ ownerFeatureId: 'fixture-owner', ownerStateRef: `source:${name}` });
const programRef = { ownerFeatureId: 'F311', ownerStateRef: id };
const objectRef = ref('object');
const url = `/api/capability-evolution/programs/${encodeURIComponent(id)}/preparation-review`;
const videoBytes = Buffer.from('exact published mp4 bytes');
const videoSha256 = createHash('sha256').update(videoBytes).digest('hex');
const videoRef = {
  ownerFeatureId: 'fixture-owner',
  ownerStateRef: `preparation-media:sha256:${videoSha256}`,
  version: videoSha256,
};
const mediaUrl = `/api/capability-evolution/programs/${encodeURIComponent(id)}/preparation-media/${videoSha256}`;
const blocker = { code: 'publication_missing', ownerRef: objectRef };
const resolved = () => ({
  schemaVersion: 1,
  status: 'resolved',
  programRef,
  objectRef,
  sourceRef: ref('catalog'),
  readAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-06T23:59:00.000Z',
  groups: [
    {
      groupRef: ref('environment'),
      title: '基础环境',
      items: [
        {
          materialRef: ref('environment-v1'),
          title: '公开评估环境',
          summary: '环境已经发布；独立验证尚未完成。',
          status: 'available',
          resources: [
            { label: '环境来源', sourceRef: ref('environment-v1'), ownerHref: '/workspace/environment' },
            {
              label: '真实回放',
              sourceRef: videoRef,
              media: { mediaRef: videoRef, contentType: 'video/mp4', durationSeconds: 2.4 },
            },
          ],
        },
      ],
    },
  ],
  blockers: [],
});
const apps = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appFor({
  user = 'test',
  workspace = 'user:test',
  read = async () => resolved(),
  readMedia = async ({ mediaRef }) => ({
    status: 'resolved',
    mediaRef,
    kind: 'video',
    contentType: 'video/mp4',
    bytes: videoBytes,
  }),
} = {}) {
  const calls = [];
  const mediaCalls = [];
  const projection = {
    program: { programId: id, workspaceId: workspace, objectRef, stage: 'constituting', cycle: 1, sequence: 3 },
    observation: { connectedEyes: [] },
    lineage: { cycles: [] },
  };
  const before = structuredClone(projection);
  const app = Fastify();
  if (user)
    app.addHook('preHandler', (request, _reply, done) => {
      request.sessionUserId = user;
      done();
    });
  const adapter = {
    preparationReview: async (input) => {
      calls.push(input);
      return read(input);
    },
    preparationMedia: async (input) => {
      mediaCalls.push(input);
      return readMedia(input);
    },
  };
  const adapterRegistry = { resolve: () => ({ status: 'resolved', adapter }) };
  await app.register(capabilityEvolutionProgramRoutes, {
    service: { get: async () => projection },
    adapterRegistry,
  });
  apps.push(app);
  return { app, calls, mediaCalls, adapter, adapterRegistry, projection, before };
}

test('unconstituted Program reads published preparation with empty EYES and lineage, without any write', async () => {
  const { app, calls, projection, before } = await appFor();
  const response = await app.inject({ url });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().groups[0].items[0].title, '公开评估环境');
  assert.match(response.headers['cache-control'], /private, no-store/);
  assert.deepEqual(calls, [{ programRef, objectRef }]);
  assert.deepEqual(projection, before);
});

test('authentication and exact workspace isolation run before the owner reader', async () => {
  for (const [options, code] of [
    [{ user: '' }, 401],
    [{ workspace: 'user:other' }, 404],
  ]) {
    const { app, calls } = await appFor(options);
    assert.equal((await app.inject({ url })).statusCode, code);
    assert.deepEqual(calls, []);
  }
});

test('distinguishes unknown reader, owner unpublished, successful empty, partial and read failure', async () => {
  const { app, adapter } = await appFor();
  delete adapter.preparationReview;
  assert.equal((await app.inject({ url })).json().status, 'unknown');
  const { groups: _groups, ...base } = resolved();
  adapter.preparationReview = async () => ({ ...base, status: 'unpublished', blockers: [blocker] });
  assert.equal((await app.inject({ url })).json().status, 'unpublished');
  adapter.preparationReview = async () => ({ ...resolved(), groups: [] });
  assert.deepEqual((await app.inject({ url })).json().groups, []);
  adapter.preparationReview = async () => ({ ...resolved(), blockers: [blocker] });
  const partial = (await app.inject({ url })).json();
  assert.equal(partial.status, 'resolved');
  assert.equal(partial.groups[0].items.length, 1);
  assert.equal(partial.blockers.length, 1);
  adapter.preparationReview = async () => {
    throw new Error('private owner error');
  };
  const failed = await app.inject({ url });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().status, 'unavailable');
  assert.equal(failed.body.includes('private owner error'), false);
});

test('reads fresh owner publication without a Program sequence change', async () => {
  let value = resolved();
  const { app, calls } = await appFor({ read: async () => value });
  await app.inject({ url });
  value = { ...value, readAt: '2026-09-07T01:00:00.000Z', groups: [] };
  assert.deepEqual((await app.inject({ url })).json().groups, []);
  assert.equal(calls.length, 2);
});

test('serves only a currently published exact video through the authenticated owner port', async () => {
  const { app, calls, mediaCalls } = await appFor();
  const response = await app.inject({ url: mediaUrl });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'video/mp4');
  assert.match(response.headers['cache-control'], /private, no-store/u);
  assert.deepEqual(response.rawPayload, videoBytes);
  assert.deepEqual(calls, [{ programRef, objectRef }]);
  assert.deepEqual(mediaCalls, [{ programRef, objectRef, mediaRef: videoRef }]);
});

test('media auth, workspace and current-publication fences run before owner bytes', async () => {
  for (const [options, code] of [
    [{ user: '' }, 401],
    [{ workspace: 'user:other' }, 404],
  ]) {
    const { app, calls, mediaCalls } = await appFor(options);
    assert.equal((await app.inject({ url: mediaUrl })).statusCode, code);
    assert.deepEqual(calls, []);
    assert.deepEqual(mediaCalls, []);
  }

  const { app, mediaCalls } = await appFor({ read: async () => ({ ...resolved(), groups: [] }) });
  assert.equal((await app.inject({ url: mediaUrl })).statusCode, 404);
  assert.deepEqual(mediaCalls, []);
  assert.equal((await app.inject({ url: mediaUrl.replace(videoSha256, '0'.repeat(64)) })).statusCode, 404);
  assert.deepEqual(mediaCalls, []);
});

test('keeps unknown owners hidden while publication-reader failures remain retryable', async () => {
  const unknown = await appFor();
  unknown.adapterRegistry.resolve = () => ({ status: 'blocked', code: 'owner_adapter_missing', targetRef: objectRef });
  const hidden = await unknown.app.inject({ url: mediaUrl });
  assert.equal(hidden.statusCode, 404);
  assert.equal(hidden.json().error, 'not_found');
  assert.deepEqual(unknown.calls, []);
  assert.deepEqual(unknown.mediaCalls, []);

  const missing = await appFor();
  delete missing.adapter.preparationReview;
  const noReader = await missing.app.inject({ url: mediaUrl });
  assert.equal(noReader.statusCode, 503);
  assert.equal(noReader.json().error, 'owner_preparation_unavailable');
  assert.deepEqual(missing.calls, []);
  assert.deepEqual(missing.mediaCalls, []);

  for (const read of [
    async () => {
      throw new Error('private publication transport failure');
    },
    async () => ({
      schemaVersion: 1,
      status: 'unavailable',
      programRef,
      objectRef,
      blockers: [{ code: 'owner_preparation_invalid', ownerRef: objectRef }],
    }),
  ]) {
    const unavailable = await appFor({ read });
    const response = await unavailable.app.inject({ url: mediaUrl });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'owner_preparation_unavailable');
    assert.deepEqual(unavailable.mediaCalls, []);
    assert.equal(response.body.includes('private publication'), false);
    assert.equal(response.body.includes('owner_preparation_invalid'), false);
  }

  const malformed = await appFor({ read: async () => ({ ...resolved(), groups: 'invalid' }) });
  const invalid = await malformed.app.inject({ url: mediaUrl });
  assert.equal(invalid.statusCode, 422);
  assert.equal(invalid.json().error, 'owner_preparation_invalid');
  assert.deepEqual(malformed.mediaCalls, []);
});

test('distinguishes an absent published hash from a published media entry with no byte reader', async () => {
  const { app, adapter, mediaCalls } = await appFor();
  delete adapter.preparationMedia;
  const missingReader = await app.inject({ url: mediaUrl });
  assert.equal(missingReader.statusCode, 503);
  assert.equal(missingReader.json().error, 'owner_preparation_media_unavailable');
  assert.deepEqual(mediaCalls, []);

  const absent = await app.inject({ url: mediaUrl.replace(videoSha256, '0'.repeat(64)) });
  assert.equal(absent.statusCode, 404);
  assert.equal(absent.json().error, 'not_found');
  assert.deepEqual(mediaCalls, []);
});

test('maps explicit owner media states without conflating availability, absence and integrity', async () => {
  const cases = [
    {
      readMedia: async () => {
        throw new Error('private filesystem detail');
      },
      statusCode: 503,
      error: 'owner_preparation_media_unavailable',
    },
    {
      readMedia: async () => ({ status: 'unavailable', reason: 'private owner outage' }),
      statusCode: 503,
      error: 'owner_preparation_media_unavailable',
    },
    {
      readMedia: async () => ({ status: 'blocked', code: 'preparation_media_unavailable' }),
      statusCode: 503,
      error: 'owner_preparation_media_unavailable',
    },
    {
      readMedia: async () => ({ status: 'not_found', reason: 'withdrawn at owner' }),
      statusCode: 404,
      error: 'not_found',
    },
    {
      readMedia: async () => ({ status: 'invalid', reason: 'owner integrity failure' }),
      statusCode: 422,
      error: 'owner_preparation_media_invalid',
    },
    {
      readMedia: async () => ({ status: 'blocked', code: 'artifact_hash_mismatch' }),
      statusCode: 422,
      error: 'owner_preparation_media_invalid',
    },
    {
      readMedia: async () => ({
        status: 'resolved',
        mediaRef: videoRef,
        kind: 'video',
        contentType: 'text/html',
        bytes: videoBytes,
      }),
      statusCode: 422,
      error: 'owner_preparation_media_invalid',
    },
    {
      readMedia: async () => ({
        status: 'resolved',
        mediaRef: videoRef,
        kind: 'video',
        contentType: 'video/mp4',
        bytes: Buffer.from('wrong bytes'),
      }),
      statusCode: 422,
      error: 'owner_preparation_media_invalid',
    },
  ];
  for (const { readMedia, statusCode, error } of cases) {
    const { app } = await appFor({ readMedia });
    const response = await app.inject({ url: mediaUrl });
    assert.equal(response.statusCode, statusCode, response.body);
    assert.equal(response.json().error, error);
    assert.equal(response.rawPayload.includes(videoBytes), false);
    assert.equal(response.body.includes('private filesystem detail'), false);
    assert.equal(response.body.includes('private owner outage'), false);
    assert.equal(response.body.includes('withdrawn at owner'), false);
    assert.equal(response.body.includes('owner integrity failure'), false);
  }
});

test('rejects identity drift, malformed owner data and unsafe resource links', async () => {
  let value = resolved();
  const { app } = await appFor({ read: async () => value });
  for (const delta of [{ objectRef: ref('another') }, { programRef: ref('another-program') }, { groups: 'bad' }]) {
    value = { ...resolved(), ...delta };
    const result = await app.inject({ url });
    assert.equal(result.statusCode, 422);
    assert.equal(result.json().status, 'unavailable');
  }
  for (const href of ['javascript:alert(1)', '//outside.invalid', '/\\outside.invalid', 'https://']) {
    value = resolved();
    value.groups[0].items[0].resources[0].ownerHref = href;
    assert.equal((await app.inject({ url })).statusCode, 422);
  }
});

test('browser cannot replace owner identity or send an adoption claim through the read route', async () => {
  const { app, calls } = await appFor();
  for (const query of ['objectRef=forged', 'workspaceId=user:other', 'adopt=true', 'selectedVersionRef=forged']) {
    assert.equal((await app.inject({ url: `${url}?${query}` })).statusCode, 400);
  }
  assert.deepEqual(calls, []);
});
