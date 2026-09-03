import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const { _resetDossierCache } = await import('@cat-cafe/shared/dossier');
const { DossierCapabilityProfileRevisionSource } = await import(
  '../dist/domains/routing-context/DossierCapabilityProfileRevisionSource.js'
);
const { RoutingContextResolver } = await import('../dist/domains/routing-context/RoutingContextResolver.js');

const temporaryRoots = [];

afterEach(() => {
  _resetDossierCache();
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

function candidate(catId, providerId = 'openai') {
  return { v: 1, catId, providerId, provenQuotaPools: [] };
}

function dossier(catId, capability, version = '1.0') {
  return `# Cat Dossier

## ${catId}

\`\`\`yaml
# structured-profile: cat:${catId}
entityId: "cat:${catId}"
oneLiner: "${capability}"
routingSignals:
  peakCapabilities:
    - "${capability}"
  antiSignals:
    - "routine mechanical work"
provenance:
  version: "${version}"
  date: "2026-08-30"
  primarySources:
    - "evidence:${catId}:${version}"
\`\`\`
`;
}

function temporaryDossier(content) {
  const root = mkdtempSync(join(tmpdir(), 'f293-dossier-source-'));
  temporaryRoots.push(root);
  const directory = join(root, 'docs', 'team');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'cat-dossier.md'), content);
  return root;
}

function profileSource(projectRoot, overrides = {}) {
  return new DossierCapabilityProfileRevisionSource({
    projectRoot,
    dossierMode: 'required',
    modelResolver: (catId) => `model:${catId}`,
    pendingProposalReader: { countPending: async () => 0 },
    ...overrides,
  });
}

function fakeResolver(profileRevisionSource) {
  return new RoutingContextResolver({
    signalStore: { getOwnerRevision: async () => 0, listByOwner: async () => [] },
    preferenceStore: { listByOwner: async () => [] },
    profileRevisionSource,
  });
}

describe('DossierCapabilityProfileRevisionSource', () => {
  it('maps only applied structured routing signals with evidence and a content-derived revision', async () => {
    const root = temporaryDossier(dossier('sol', 'state-machine architecture'));
    const result = await profileSource(root, {
      pendingProposalReader: { countPending: async () => 3 },
    }).load({ ownerId: 'owner-1', candidates: [candidate('sol')], intent: 'architecture' });

    assert.equal(result.status, 'fresh');
    assert.deepEqual(result.absentCatIds, []);
    assert.equal(result.profiles[0].catId, 'sol');
    assert.equal(result.profiles[0].modelId, 'model:sol');
    assert.match(result.profiles[0].dossierRevision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.profiles[0].pendingProposalCount, 3);
    assert.deepEqual(
      result.profiles[0].relevantSignals.map((signal) => signal.kind),
      ['strength', 'anti_signal'],
    );
    assert.ok(result.profiles[0].relevantSignals.every((signal) => signal.evidenceRefs.includes('evidence:sol:1.0')));
  });

  it('observes a newly applied dossier revision at the same root and changes the resolver input revision', async () => {
    const root = temporaryDossier(dossier('sol', 'architecture v1', '1.0'));
    const source = profileSource(root);
    const resolver = fakeResolver(source);
    const input = {
      ownerId: 'owner-1',
      observedAt: 10_000,
      catalogRevision: 'catalog:v1',
      intent: 'architecture',
      candidates: [candidate('sol')],
    };
    const first = await resolver.resolve(input);
    assert.equal(first.status, 'fresh');

    writeFileSync(join(root, 'docs', 'team', 'cat-dossier.md'), dossier('sol', 'architecture v2', '2.0'));
    const second = await resolver.resolve(input);
    assert.equal(second.status, 'fresh');
    assert.notEqual(first.inputRevisionRef, second.inputRevisionRef);
    assert.notEqual(
      first.snapshot.candidates[0].profile.revision.dossierRevision,
      second.snapshot.candidates[0].profile.revision.dossierRevision,
    );
  });

  it('degrades for an unavailable dossier but keeps per-candidate profile absence explicit', async () => {
    const missingRoot = mkdtempSync(join(tmpdir(), 'f293-missing-dossier-'));
    temporaryRoots.push(missingRoot);
    const required = await profileSource(missingRoot).load({
      ownerId: 'owner-1',
      candidates: [candidate('sol')],
      intent: 'review',
    });
    assert.deepEqual(required, {
      status: 'degraded',
      reason: 'dossier_unavailable',
      affectedCatIds: ['sol'],
    });

    _resetDossierCache();
    const optional = await profileSource(missingRoot, {
      dossierMode: 'optional',
    }).load({ ownerId: 'owner-1', candidates: [candidate('community-cat')], intent: 'review' });
    assert.deepEqual(optional, { status: 'fresh', profiles: [], absentCatIds: ['community-cat'] });

    _resetDossierCache();
    const partialRoot = temporaryDossier(dossier('terra', 'daily implementation'));
    const missingProfile = await profileSource(partialRoot).load({
      ownerId: 'owner-1',
      candidates: [candidate('sol'), candidate('terra')],
      intent: 'review',
    });
    assert.equal(missingProfile.status, 'fresh');
    assert.deepEqual(missingProfile.absentCatIds, ['sol']);
    assert.deepEqual(
      missingProfile.profiles.map((profile) => profile.catId),
      ['terra'],
    );
  });
});

describe('RoutingContextResolver', () => {
  it('returns typed dossier degradation instead of inventing a capability snapshot', async () => {
    const resolver = fakeResolver({
      load: async () => ({ status: 'degraded', reason: 'model_missing', affectedCatIds: ['sol'] }),
    });
    assert.deepEqual(
      await resolver.resolve({
        ownerId: 'owner-1',
        observedAt: 10_000,
        catalogRevision: 'catalog:v1',
        intent: 'review',
        candidates: [candidate('sol')],
      }),
      { status: 'degraded', reason: 'model_missing', affectedCatIds: ['sol'] },
    );
  });

  it('projects pending proposal count for visibility without changing route effect or order', async () => {
    let pendingProposalCount = 0;
    const root = temporaryDossier(`${dossier('sol', 'architecture')}\n${dossier('terra', 'implementation')}`);
    const source = profileSource(root, {
      pendingProposalReader: { countPending: async () => pendingProposalCount },
    });
    const resolver = fakeResolver(source);
    const input = {
      ownerId: 'owner-1',
      observedAt: 10_000,
      catalogRevision: 'catalog:v1',
      intent: 'review',
      candidates: [candidate('terra'), candidate('sol')],
    };
    const withoutPending = await resolver.resolve(input);
    pendingProposalCount = 99;
    const withPending = await resolver.resolve(input);
    assert.equal(withoutPending.status, 'fresh');
    assert.equal(withPending.status, 'fresh');
    assert.deepEqual(
      withoutPending.snapshot.candidates.map((entry) => [entry.binding.catId, entry.effect]),
      withPending.snapshot.candidates.map((entry) => [entry.binding.catId, entry.effect]),
    );
    assert.ok(withPending.snapshot.candidates.every((entry) => entry.profile.revision.pendingProposalCount === 99));
  });

  it('reuses immutable signal timelines by owner revision while recomputing time-sensitive projection', async () => {
    let revision = 1;
    let listCalls = 0;
    const assertion = {
      v: 1,
      eventId: 'signal:sol:unavailable',
      commandId: 'command:sol:unavailable',
      ownerId: 'owner-1',
      subjectRef: { type: 'cat', catId: 'sol' },
      reasonCode: 'provider_unreachable',
      source: 'health_probe',
      observedAt: 1_000,
      evidenceRef: 'health:sol:1',
      eventType: 'asserted',
      state: 'unavailable',
      validUntil: 6_000,
    };
    let events = [assertion];
    const signalStore = {
      getOwnerRevision: async () => revision,
      listByOwner: async () => {
        listCalls += 1;
        return events;
      },
    };
    const makeResolver = () =>
      new RoutingContextResolver({
        signalStore,
        preferenceStore: { listByOwner: async () => [] },
        profileRevisionSource: { load: async () => ({ status: 'fresh', profiles: [], absentCatIds: ['sol'] }) },
      });
    const firstProcess = makeResolver();
    const secondProcess = makeResolver();
    const input = (observedAt) => ({
      ownerId: 'owner-1',
      observedAt,
      catalogRevision: 'catalog:v1',
      candidates: [candidate('sol')],
    });

    assert.equal((await firstProcess.resolve(input(5_000))).snapshot.candidates[0].availability, 'unavailable');
    assert.equal((await firstProcess.resolve(input(7_000))).snapshot.candidates[0].availability, 'unknown');
    assert.equal((await secondProcess.resolve(input(7_000))).snapshot.candidates[0].availability, 'unknown');
    assert.equal((await secondProcess.resolve(input(8_000))).snapshot.candidates[0].availability, 'unknown');
    assert.equal(listCalls, 2, 'each process should load an unchanged owner timeline once');

    revision = 2;
    events = [
      assertion,
      {
        v: 1,
        eventId: 'signal:sol:recovered',
        commandId: 'command:sol:recovered',
        ownerId: 'owner-1',
        subjectRef: { type: 'cat', catId: 'sol' },
        reasonCode: 'probe_succeeded',
        source: 'health_probe',
        observedAt: 9_000,
        evidenceRef: 'health:sol:2',
        eventType: 'recovered',
        state: 'available',
        closesSignalIds: [assertion.eventId],
      },
    ];

    assert.equal((await firstProcess.resolve(input(10_000))).snapshot.candidates[0].availability, 'available');
    assert.equal((await secondProcess.resolve(input(10_000))).snapshot.candidates[0].availability, 'available');
    assert.equal(listCalls, 4, 'shared revision changes must invalidate every process cache');
  });

  it('does not cache a timeline when the shared revision changes during its read', async () => {
    let revisionCalls = 0;
    let listCalls = 0;
    const resolver = new RoutingContextResolver({
      signalStore: {
        getOwnerRevision: async () => {
          revisionCalls += 1;
          return revisionCalls === 1 ? 1 : 2;
        },
        listByOwner: async () => {
          listCalls += 1;
          return [];
        },
      },
      preferenceStore: { listByOwner: async () => [] },
      profileRevisionSource: { load: async () => ({ status: 'fresh', profiles: [], absentCatIds: ['sol'] }) },
    });
    const input = {
      ownerId: 'owner-1',
      observedAt: 10_000,
      catalogRevision: 'catalog:v1',
      candidates: [candidate('sol')],
    };

    await resolver.resolve(input);
    await resolver.resolve(input);
    assert.equal(listCalls, 2);
  });
});
