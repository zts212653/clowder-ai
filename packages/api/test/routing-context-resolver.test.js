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
const { buildRoutingSignalDecisionProjection } = await import(
  '../dist/domains/routing-context/preflight/RoutingSignalDecisionProjection.js'
);

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
    signalStore: {
      getOwnerRevision: async () => 0,
      readDecisionProjection: async () =>
        buildRoutingSignalDecisionProjection({ ownerId: 'owner-1', revision: 0, events: [] }),
      listByOwner: async () => [],
    },
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
  it('resolves dispatch decisions from the bounded signal projection without loading the immutable ledger', async () => {
    const assertion = {
      v: 1,
      eventId: 'signal:sol:provider-error',
      commandId: 'command:sol:provider-error',
      ownerId: 'owner-1',
      subjectRef: { type: 'cat', catId: 'sol' },
      reasonCode: 'provider_unreachable',
      source: 'provider_error',
      observedAt: 1_000,
      evidenceRef: 'turn:failed',
      eventType: 'asserted',
      state: 'unavailable',
      validUntil: 20_000,
    };
    const recovery = {
      v: 1,
      eventId: 'signal:sol:dispatch-success',
      commandId: 'command:sol:dispatch-success',
      ownerId: 'owner-1',
      subjectRef: { type: 'cat', catId: 'sol' },
      reasonCode: 'dispatch_success_probe',
      source: 'dispatch_success',
      observedAt: 2_000,
      evidenceRef: 'turn:succeeded',
      eventType: 'recovered',
      state: 'available',
      closesSignalIds: [],
      probeStartedAt: 1_500,
    };
    const futureRecovery = {
      ...recovery,
      eventId: 'signal:sol:dispatch-success:future',
      commandId: 'command:sol:dispatch-success:future',
      observedAt: 10_001,
      evidenceRef: 'turn:succeeded:future',
      probeStartedAt: 9_500,
    };
    const decisionProjection = buildRoutingSignalDecisionProjection({
      ownerId: 'owner-1',
      revision: 10_000,
      events: [assertion, recovery, futureRecovery],
    });
    let projectionReads = 0;
    let ledgerReads = 0;
    const resolver = new RoutingContextResolver({
      signalStore: {
        getOwnerRevision: async () => 10_000,
        readDecisionProjection: async () => {
          projectionReads += 1;
          return decisionProjection;
        },
        listByOwner: async () => {
          ledgerReads += 1;
          throw new Error('dispatch resolution must not load the immutable signal ledger');
        },
      },
      preferenceStore: { listByOwner: async () => [] },
      profileRevisionSource: { load: async () => ({ status: 'fresh', profiles: [], absentCatIds: ['sol'] }) },
    });

    const beforeRecovery = await resolver.resolve({
      ownerId: 'owner-1',
      observedAt: 1_500,
      catalogRevision: 'catalog:v1',
      candidates: [candidate('sol')],
    });
    const result = await resolver.resolve({
      ownerId: 'owner-1',
      observedAt: 10_000,
      catalogRevision: 'catalog:v1',
      candidates: [candidate('sol')],
    });

    assert.equal(beforeRecovery.status, 'fresh');
    assert.equal(beforeRecovery.snapshot.candidates[0].availability, 'unavailable');
    assert.equal(result.status, 'fresh');
    assert.equal(result.snapshot.candidates[0].availability, 'available');
    assert.equal(projectionReads, 1);
    assert.equal(ledgerReads, 0);
  });

  it('uses one decision projection for dispatch and the ledger-complete owner read model', async () => {
    const signal = {
      v: 1,
      eventId: 'signal:owner-read',
      commandId: 'command:owner-read',
      ownerId: 'owner-1',
      subjectRef: { type: 'cat', catId: 'sol' },
      reasonCode: 'quota_low',
      source: 'quota_probe',
      observedAt: 1_000,
      evidenceRef: 'quota:1',
      eventType: 'asserted',
      state: 'scarce',
      validUntil: 20_000,
    };
    const historyOnly = {
      v: 1,
      eventId: 'signal:history-only-success',
      commandId: 'command:history-only-success',
      ownerId: 'owner-1',
      subjectRef: { type: 'cat', catId: 'sol' },
      reasonCode: 'dispatch_success_probe',
      source: 'dispatch_success',
      observedAt: 2_000,
      evidenceRef: 'turn:history-only',
      eventType: 'recovered',
      state: 'available',
      closesSignalIds: [],
      probeStartedAt: 1_500,
    };
    const projection = buildRoutingSignalDecisionProjection({
      ownerId: 'owner-1',
      revision: 2,
      events: [signal, historyOnly],
    });
    const resolver = new RoutingContextResolver({
      signalStore: {
        getOwnerRevision: async () => 2,
        readDecisionProjection: async () => projection,
        listByOwner: async () => [signal, historyOnly],
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

    const dispatch = await resolver.resolve(input);
    const ownerRead = await resolver.resolveWithSources(input);

    assert.deepEqual(ownerRead.resolution, dispatch);
    assert.deepEqual(
      ownerRead.signalEvents.map((event) => event.eventId),
      [signal.eventId, historyOnly.eventId],
    );
    assert.deepEqual(dispatch.sourceRefs.signalEventIds, [historyOnly.eventId, signal.eventId].sort());
  });

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

  it('reuses the decision projection by owner revision while recomputing time-sensitive state', async () => {
    let revision = 1;
    let projectionReads = 0;
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
      readDecisionProjection: async () => {
        projectionReads += 1;
        return buildRoutingSignalDecisionProjection({ ownerId: 'owner-1', revision, events });
      },
      listByOwner: async () => events,
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
    assert.equal(projectionReads, 2, 'each process should load an unchanged owner projection once');

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
    assert.equal(projectionReads, 4, 'shared revision changes must invalidate every process cache');
  });

  it('does not reuse a cached projection after the shared owner revision advances', async () => {
    let revision = 1;
    let projectionReads = 0;
    const resolver = new RoutingContextResolver({
      signalStore: {
        getOwnerRevision: async () => revision,
        readDecisionProjection: async () => {
          projectionReads += 1;
          return buildRoutingSignalDecisionProjection({ ownerId: 'owner-1', revision, events: [] });
        },
        listByOwner: async () => [],
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
    revision = 2;
    await resolver.resolve(input);
    await resolver.resolve(input);
    assert.equal(projectionReads, 2);
  });

  it('single-flights a cold projection rebuild for concurrent preflight readers', async () => {
    let projectionReads = 0;
    const projection = buildRoutingSignalDecisionProjection({ ownerId: 'owner-1', revision: 10_000, events: [] });
    const resolver = new RoutingContextResolver({
      signalStore: {
        getOwnerRevision: async () => 10_000,
        readDecisionProjection: async () => {
          projectionReads += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return projection;
        },
        listByOwner: async () => {
          throw new Error('concurrent preflight must not load the ledger');
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

    const results = await Promise.all(Array.from({ length: 20 }, () => resolver.resolve(input)));

    assert.ok(results.every((result) => result.status === 'fresh'));
    assert.equal(projectionReads, 1);
  });
});
