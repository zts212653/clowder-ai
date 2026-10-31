import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Fastify from 'fastify';
import { capabilityEvolutionProgramRoutes } from '../dist/routes/capability-evolution-program-routes.js';

const id = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';
const ref = (name, ownerFeatureId = 'F202') => ({ ownerFeatureId, ownerStateRef: `source:${name}` });
const asset = (version) => ({ ...ref('skill'), assetKind: 'skill', assetId: 'review-method', version });
const objectRef = ref('object');
const programRef = { ownerFeatureId: 'F311', ownerStateRef: id };
const url = `/api/capability-evolution/programs/${encodeURIComponent(id)}/asset-review`;
const resolved = (version = 'v1') => ({
  schemaVersion: 1,
  status: 'resolved',
  programRef,
  objectRef,
  sourceRef: ref('owner-read'),
  readAt: '2026-09-05T00:00:00.000Z',
  currentVersionRefs: [asset(version)],
  currentProofRef: ref('current-proof'),
  versions: [
    { versionRef: asset('v1'), parentEdges: [] },
    { versionRef: asset('v2'), parentEdges: [{ parentVersionRef: asset('v1'), edgeRef: ref('edge-v2') }] },
  ],
  selected: {
    versionRef: asset(version),
    diff: {
      status: 'available',
      comparedToVersionRef: asset(version),
      summary: '澄清审阅范围',
      rawDiffRef: ref('diff'),
    },
    evidence: [],
    uses: [],
  },
  blockers: [],
});
const apps = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appFor({ user = 'test', workspace = 'user:test', read = async () => resolved() } = {}) {
  const calls = [];
  const app = Fastify();
  if (user)
    app.addHook('preHandler', (request, _reply, done) => {
      request.sessionUserId = user;
      done();
    });
  const adapter = {
    versionReview: async (input) => {
      calls.push(input);
      return read(input);
    },
  };
  await app.register(capabilityEvolutionProgramRoutes, {
    service: {
      get: async () => ({ program: { programId: id, workspaceId: workspace, objectRef, cycle: 1, sequence: 3 } }),
    },
    adapterRegistry: { resolve: () => ({ status: 'resolved', adapter }) },
  });
  apps.push(app);
  return { app, calls, adapter };
}

test('asset review is authenticated and owner-workspace scoped before any resolver call', async () => {
  for (const [options, code] of [
    [{ user: '' }, 401],
    [{ workspace: 'user:other' }, 404],
  ]) {
    const { app, calls } = await appFor(options);
    assert.equal((await app.inject({ url })).statusCode, code);
    assert.equal(calls.length, 0);
  }
});
test('reads owner current truth every time, independently of the Program sequence', async () => {
  let version = 'v1';
  const { app, calls } = await appFor({ read: async () => resolved(version) });
  assert.equal((await app.inject({ url })).json().currentVersionRefs[0].version, 'v1');
  version = 'v2';
  const second = await app.inject({ url });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().currentVersionRefs[0].version, 'v2');
  assert.match(second.headers['cache-control'], /no-store/);
  assert.equal(calls.length, 2);
});
test('keeps exact source selection and refuses a resolver result for another version or object', async () => {
  const { app, calls } = await appFor();
  const response = await app.inject({
    url: `${url}?selectedVersionRef=${encodeURIComponent(JSON.stringify(asset('v2')))}`,
  });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().blockers[0].code, 'owner_review_identity_mismatch');
  assert.deepEqual(calls[0].selectedVersionRef, asset('v2'));
  const other = await appFor({ read: async () => ({ ...resolved(), objectRef: ref('other') }) });
  assert.equal((await other.app.inject({ url })).statusCode, 422);
});
test('rejects malformed queries and evidence or use attached to a different asset version', async () => {
  const { app } = await appFor();
  assert.equal((await app.inject({ url: `${url}?selectedVersionRef=bad` })).statusCode, 400);
  const other = await appFor({
    read: async () => ({
      ...resolved(),
      selected: {
        ...resolved().selected,
        evidence: [
          {
            role: 'post_adoption_observation',
            assetVersionRef: asset('v2'),
            evidenceRef: ref('evidence'),
            proofRef: ref('proof'),
            status: 'verified',
          },
        ],
      },
    }),
  });
  assert.equal((await other.app.inject({ url })).statusCode, 422);
});
test('returns a typed owner blocker when a read capability is absent; no execution fallback', async () => {
  const { app, adapter } = await appFor();
  delete adapter.versionReview;
  const response = await app.inject({ url });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().status, 'unavailable');
  assert.equal(response.json().blockers[0].code, 'owner_version_review_unavailable');
});

test('federates owner-issued evidence roles and applied-use receipts only for the exact selection', async () => {
  const binding = {
    assetVersionRef: asset('v1'),
    evidenceRef: ref('evidence', 'F267'),
    proofRef: ref('binding', 'F267'),
    status: 'verified',
  };
  const use = {
    receiptRef: ref('use'),
    assetVersionRef: asset('v1'),
    invocationRef: { ownerFeatureId: 'F299', ownerStateRef: 'inv:later-task' },
    consumerRef: ref('consumer'),
    use: 'applied',
    occurredAt: '2026-09-05T08:00:00.000Z',
  };
  const value = resolved();
  value.selected.evidence = [
    'comparison_baseline',
    'candidate_independent_verification',
    'post_adoption_observation',
  ].map((role) => ({ ...binding, role }));
  value.selected.uses = [use];
  const { app } = await appFor({ read: async () => value });
  const response = await app.inject({ url });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().selected.evidence.length, 3);
  assert.deepEqual(response.json().selected.uses[0], use);
  value.selected.uses[0] = { ...use, assetVersionRef: asset('v2') };
  assert.equal((await app.inject({ url })).statusCode, 422);
});

test('does not accept caller-supplied owner identities, live adoption or effect claims', async () => {
  const { app, calls } = await appFor();
  for (const query of ['workspaceId=user:other', 'objectRef=forged', 'currentVersionRef=v2', 'use=applied']) {
    assert.equal((await app.inject({ url: `${url}?${query}` })).statusCode, 400);
  }
  assert.equal(calls.length, 0);
});

test('requires an exact diff comparison against the live adopted version of the same asset', async () => {
  const value = resolved();
  delete value.selected.diff.comparedToVersionRef;
  const { app } = await appFor({ read: async () => value });
  assert.equal((await app.inject({ url })).statusCode, 422);
  value.selected.diff.comparedToVersionRef = asset('v2');
  assert.equal((await app.inject({ url })).statusCode, 422);
  value.selected.diff.comparedToVersionRef = asset('v1');
  assert.equal((await app.inject({ url })).statusCode, 200);
});

test('rejects executable or malformed source links and invalid invocation coordinates', async () => {
  const value = resolved();
  const { app } = await appFor({ read: async () => value });
  for (const ownerHref of ['javascript:alert(1)', '//external.invalid', '/\\external.invalid', 'https://']) {
    value.selected.diff.ownerHref = ownerHref;
    assert.equal((await app.inject({ url })).statusCode, 422);
  }
  delete value.selected.diff.ownerHref;
  value.selected.uses = [
    {
      receiptRef: ref('use'),
      assetVersionRef: asset('v1'),
      invocationRef: ref('not-an-invocation', 'F299'),
      consumerRef: ref('consumer'),
      use: 'applied',
      occurredAt: '2026-09-05T00:00:00.000Z',
    },
  ];
  assert.equal((await app.inject({ url })).statusCode, 422);
});
