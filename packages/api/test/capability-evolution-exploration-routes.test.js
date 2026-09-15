import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explorationHttpFixture as fixture } from './capability-evolution-exploration-http.helper.mjs';

const id = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
const objectRef = { ownerFeatureId: 'F100', ownerStateRef: 'capability:code-behavior' };
const programRef = { ownerFeatureId: 'F311', ownerStateRef: id };
const url = `/api/capability-evolution/programs/${encodeURIComponent(id)}/exploration`;

test('exploration is an authenticated read and never falls back to execution', async () => {
  const { app, counts } = await fixture();
  const response = await app.inject({ url });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    schemaVersion: 1,
    programRef,
    objectRef,
    status: 'unavailable',
    blockers: [{ code: 'owner_version_review_unavailable', ownerRef: objectRef }],
  });
  assert.equal(counts().writes, 0);
  assert.match(response.headers['cache-control'], /no-store/);
});

test('auth and workspace fences precede every exploration owner read', async () => {
  for (const [user, workspace, status] of [
    ['', 'user:test', 401],
    ['test', 'user:another', 404],
  ]) {
    const { app, counts } = await fixture(user, workspace);
    assert.equal((await app.inject({ url })).statusCode, status);
    assert.deepEqual(counts(), { reads: 0, writes: 0 });
  }
});

test('reads the exact owner publication and keeps complete result sets bound to their experiment', async () => {
  const { explorationFixture, experimentRef, nodeRef } = await import('./capability-evolution-exploration.helper.mjs');
  const { app, adapter, counts } = await fixture();
  let received;
  adapter.explorationReview = async (input) => {
    received = input;
    return explorationFixture({ withDetail: true });
  };
  const query = new URLSearchParams({
    selectedNodeRef: JSON.stringify(nodeRef),
    selectedExperimentRef: JSON.stringify(experimentRef),
  });
  const response = await app.inject({ url: `${url}?${query}` });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(received, { programRef, objectRef, selectedNodeRef: nodeRef, selectedExperimentRef: experimentRef });
  assert.equal(response.json().details[0].records[0].output[0].value, '401');
  assert.equal(counts().writes, 0);
});

test('rejects owner data from another Program, node, window or measurement and cyclic lineage', async () => {
  const { explorationFixture, experimentRef, source, nodeRef } = await import(
    './capability-evolution-exploration.helper.mjs'
  );
  const mutations = [
    (value) => {
      value.programRef = source('other-program');
    },
    (value) => {
      value.objectRef = source('other-object');
    },
    (value) => {
      value.details[0].records[0].nodeRef = source('other-version');
    },
    (value) => {
      value.details[0].records[0].windowRef = source('other-window');
    },
    (value) => {
      value.details[0].records[0].measurementRef = source('other-ruler');
    },
    (value) => {
      value.details[0].records = [];
    },
    (value) => {
      value.nodes[0].parentEdges = [{ parentNodeRef: nodeRef, sourceRef: source('cycle') }];
    },
    (value) => {
      value.nodes[0].kind = 'public_archive';
    },
    (value) => {
      value.currentVersionRefs = [source('forged-adoption')];
    },
    (value) => {
      value.experiments[0].recordCount = 2;
      value.details[0].records.push({ ...value.details[0].records[0], recordRef: source('another-row') });
    },
  ];
  for (const mutate of mutations) {
    const value = explorationFixture({ withDetail: true });
    mutate(value);
    const { app, adapter, counts } = await fixture();
    adapter.explorationReview = async () => value;
    const response = await app.inject({
      url: `${url}?selectedExperimentRef=${encodeURIComponent(JSON.stringify(experimentRef))}`,
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(counts().writes, 0);
  }
});

test('does not consume a valid response for a different selection or caller-supplied authority', async () => {
  const { explorationFixture, source } = await import('./capability-evolution-exploration.helper.mjs');
  const { app, adapter } = await fixture();
  let reads = 0;
  adapter.explorationReview = async () => {
    reads++;
    return explorationFixture();
  };
  for (const query of [
    'workspaceId=user:other',
    'objectRef=forged',
    'currentVersionRef=adopted',
    'selectedNodeRef=bad',
  ])
    assert.equal((await app.inject({ url: `${url}?${query}` })).statusCode, 400);
  assert.equal(reads, 0);
  assert.equal(
    (await app.inject({ url: `${url}?selectedNodeRef=${encodeURIComponent(JSON.stringify(source('not-published')))}` }))
      .statusCode,
    422,
  );
});

test('existing version-only owners remain usable and explicitly untested, with no invented outcomes', async () => {
  const { versionRef, source } = await import('./capability-evolution-exploration.helper.mjs');
  const { app, adapter } = await fixture();
  adapter.versionReview = async () => ({
    schemaVersion: 1,
    programRef,
    objectRef,
    status: 'resolved',
    sourceRef: source('publication'),
    readAt: '2026-09-09T14:00:00.000Z',
    versions: [{ versionRef, parentEdges: [] }],
    currentVersionRefs: [versionRef],
    currentProofRef: source('current-proof'),
    blockers: [],
  });
  const response = await app.inject({ url });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().nodes[0].kind, 'owner_version');
  assert.deepEqual(response.json().experiments, []);
  assert.equal('currentVersionRefs' in response.json(), false);
});

test('serves only a currently published media record and verifies the exact bytes', async () => {
  const { createHash } = await import('node:crypto');
  const { explorationFixture, experimentRef, source } = await import('./capability-evolution-exploration.helper.mjs');
  const bytes = Buffer.from('isolated-video-bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const mediaRef = source(`video-${sha256}`, sha256);
  const media = {
    mediaRef,
    kind: 'video',
    contentType: 'video/mp4',
    label: '本次运行',
    provenance: 'original',
    sourceRecordRef: source('actual-response'),
  };
  const { app, adapter, counts } = await fixture();
  let published = true;
  let served = bytes;
  adapter.explorationReview = async () =>
    explorationFixture({ withDetail: true, media: published ? media : undefined });
  adapter.explorationMedia = async (input) => ({
    status: 'resolved',
    mediaRef: input.mediaRef,
    kind: 'video',
    contentType: 'video/mp4',
    bytes: served,
  });
  const mediaUrl = `${url}-media/${sha256}?${new URLSearchParams({ experimentRef: JSON.stringify(experimentRef), recordRef: JSON.stringify(source('record')) })}`;
  const response = await app.inject({ url: mediaUrl });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.rawPayload, bytes);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(response.headers['cache-control'], /no-store/);
  served = Buffer.from('tampered');
  assert.equal((await app.inject({ url: mediaUrl })).statusCode, 422);
  served = bytes;
  const verifiedMedia = adapter.explorationMedia;
  adapter.explorationMedia = async () => ({ status: 'unavailable', reason: '来源暂不可读' });
  assert.equal((await app.inject({ url: mediaUrl })).statusCode, 503);
  adapter.explorationMedia = verifiedMedia;
  published = false;
  assert.equal((await app.inject({ url: mediaUrl })).statusCode, 404);
  assert.equal(counts().writes, 0);
});

test('version-only owners preserve distinct asset identities from the same owner revision', async () => {
  const { source, versionRef } = await import('./capability-evolution-exploration.helper.mjs');
  const { app, adapter } = await fixture();
  const other = { ...versionRef, assetId: 'another-file' };
  adapter.versionReview = async () => ({
    schemaVersion: 1,
    programRef,
    objectRef,
    status: 'resolved',
    sourceRef: source('catalog'),
    readAt: '2026-09-09T14:00:00.000Z',
    versions: [
      { versionRef, parentEdges: [] },
      { versionRef: other, parentEdges: [] },
    ],
    currentVersionRefs: [],
    currentProofRef: source('current-proof'),
    blockers: [],
  });
  const response = await app.inject({ url });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().nodes.length, 2);
  assert.notDeepEqual(response.json().nodes[0].nodeRef, response.json().nodes[1].nodeRef);
});

test('a data-derived trajectory remains tied to the exact record and includes its physical units', async () => {
  const { explorationFixture, experimentRef, source } = await import('./capability-evolution-exploration.helper.mjs');
  const value = explorationFixture({ withDetail: true });
  value.details[0].records[0].trace = {
    sourceRef: source('actual-response'),
    label: '实际躯干轨迹',
    definition: '依原顺序抽取真实 XY；不平滑',
    xLabel: '世界 X',
    yLabel: '世界 Y',
    unit: 'm',
    points: [
      { x: 0, y: 0, seconds: 0 },
      { x: 0.2, y: 0.1, seconds: 1 },
    ],
  };
  const { app, adapter } = await fixture();
  adapter.explorationReview = async () => value;
  const path = `${url}?selectedExperimentRef=${encodeURIComponent(JSON.stringify(experimentRef))}`;
  assert.equal((await app.inject({ url: path })).statusCode, 200);
  value.details[0].records[0].trace.sourceRef = source('another-capture');
  assert.equal((await app.inject({ url: path })).statusCode, 422);
});
