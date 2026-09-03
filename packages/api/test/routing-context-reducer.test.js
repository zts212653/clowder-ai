import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { reduceRoutingContext } = await import('../dist/domains/routing-context/routing-context-reducer.js');

const NOW = 10_000;

function candidate(catId, providerId, pools = []) {
  return {
    v: 1,
    catId,
    providerId,
    provenQuotaPools: pools.map((poolId) => ({ poolId, evidenceRef: `catalog:${catId}:${poolId}` })),
  };
}

function asserted({
  eventId,
  subjectRef,
  state,
  observedAt = 1_000,
  validUntil = 20_000,
  reasonCode = `${state}_evidence`,
}) {
  return {
    v: 1,
    eventId,
    commandId: `command:${eventId}`,
    ownerId: 'owner-1',
    subjectRef,
    reasonCode,
    source: 'health_probe',
    observedAt,
    evidenceRef: `evidence:${eventId}`,
    eventType: 'asserted',
    state,
    validUntil,
  };
}

function closed(eventType, eventId, closesSignalIds, observedAt = 5_000) {
  return {
    v: 1,
    eventId,
    commandId: `command:${eventId}`,
    ownerId: 'owner-1',
    subjectRef: { type: 'cat', catId: 'sol' },
    reasonCode: eventType === 'recovered' ? 'probe_succeeded' : 'manual_retraction',
    source: eventType === 'recovered' ? 'health_probe' : 'manual_cvo',
    observedAt,
    evidenceRef: `evidence:${eventId}`,
    eventType,
    ...(eventType === 'recovered' ? { state: 'available' } : {}),
    closesSignalIds,
  };
}

function profile(catId, dossierRevision, pendingProposalCount = 0) {
  return {
    v: 1,
    catId,
    modelId: `model:${catId}`,
    dossierRevision,
    updatedAt: 2_000,
    relevantSignals: [
      {
        kind: 'strength',
        summary: `${catId} is strong at architecture`,
        evidenceRefs: [`dossier:${dossierRevision}`],
      },
    ],
    pendingProposalCount,
  };
}

function preference({
  preferenceId = 'preference:reviewer',
  revisionId = `${preferenceId}:v1`,
  version = 1,
  lifecycle = 'active',
  prefer = [{ type: 'cat', catId: 'terra' }],
  over = [{ type: 'cat', catId: 'sol' }],
  reviewAfter = 20_000,
  supersedesRevisionId,
  retiredAt,
}) {
  return {
    v: 1,
    preferenceId,
    revisionId,
    commandId: `command:${revisionId}`,
    ownerId: 'owner-1',
    appliesWhen: { intent: 'review', requireEligible: [...prefer, ...over] },
    prefer,
    over,
    rationale: 'Prefer Terra for review while both candidates are eligible.',
    evidenceRefs: [`evidence:${revisionId}`],
    version,
    validFrom: 500,
    lifecycle,
    ...(lifecycle === 'active' ? { reviewAfter, supersedesRevisionId } : {}),
    ...(lifecycle === 'retired'
      ? {
          retiredAt,
          retirementReason: 'The rotation changed.',
          supersedesRevisionId,
        }
      : {}),
  };
}

function reduce(overrides = {}) {
  return reduceRoutingContext({
    ownerId: 'owner-1',
    observedAt: NOW,
    catalogRevision: 'catalog:v1',
    intent: 'review',
    candidates: [candidate('sol', 'openai', ['pool-a']), candidate('terra', 'openai', ['pool-b'])],
    profiles: [],
    signalEvents: [],
    preferenceRevisions: [],
    ...overrides,
  });
}

function byCat(snapshot, catId) {
  return snapshot.candidates.find((entry) => entry.binding.catId === catId);
}

describe('F293 pure routing-context reducer', () => {
  it('applies cat, provider and proven-pool evidence only to their exact candidate scopes', () => {
    const cases = [
      {
        subjectRef: { type: 'cat', catId: 'sol' },
        affected: ['sol'],
        unaffected: ['terra'],
      },
      {
        subjectRef: { type: 'provider', providerId: 'openai' },
        affected: ['sol', 'terra'],
        unaffected: [],
      },
      {
        subjectRef: { type: 'quota_pool', poolId: 'pool-a' },
        affected: ['sol'],
        unaffected: ['terra'],
      },
      {
        subjectRef: { type: 'quota_pool', poolId: 'hidden-private-pool' },
        affected: [],
        unaffected: ['sol', 'terra'],
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const snapshot = reduce({
        signalEvents: [
          asserted({
            eventId: `signal:scope:${index}`,
            subjectRef: testCase.subjectRef,
            state: 'unavailable',
          }),
        ],
      });
      for (const catId of testCase.affected) {
        assert.equal(byCat(snapshot, catId).availability, 'unavailable');
        assert.equal(byCat(snapshot, catId).effect, 'blocked');
      }
      for (const catId of testCase.unaffected) {
        assert.equal(byCat(snapshot, catId).availability, 'available');
        assert.equal(byCat(snapshot, catId).effect, 'eligible');
      }
    }
  });

  it('preserves all overlapping reasons and chooses the strongest active state', () => {
    const events = [
      asserted({ eventId: 'signal:cat', subjectRef: { type: 'cat', catId: 'sol' }, state: 'scarce' }),
      asserted({
        eventId: 'signal:pool',
        subjectRef: { type: 'quota_pool', poolId: 'pool-a' },
        state: 'degraded',
      }),
      asserted({
        eventId: 'signal:provider',
        subjectRef: { type: 'provider', providerId: 'openai' },
        state: 'unavailable',
      }),
    ];
    const sol = byCat(reduce({ signalEvents: events }), 'sol');
    assert.equal(sol.availability, 'unavailable');
    assert.equal(sol.effect, 'blocked');
    assert.deepEqual(
      sol.reasons.map((reason) => reason.sourceRefs[0]),
      ['signal:provider', 'signal:pool', 'signal:cat'],
    );
  });

  it('turns expired or retracted negative evidence into unknown, never synthetic available', () => {
    const expiring = asserted({
      eventId: 'signal:expired',
      subjectRef: { type: 'cat', catId: 'sol' },
      state: 'scarce',
      validUntil: NOW,
    });
    const expired = byCat(reduce({ signalEvents: [expiring] }), 'sol');
    assert.equal(expired.availability, 'unknown');
    assert.equal(expired.freshness, 'stale');
    assert.equal(expired.effect, 'advisory');

    const retracted = byCat(
      reduce({ signalEvents: [expiring, closed('retracted', 'signal:retracted', ['signal:expired'])] }),
      'sol',
    );
    assert.equal(retracted.availability, 'unknown');
    assert.equal(retracted.effect, 'advisory');
    assert.match(retracted.reasons[0].code, /retracted/);
  });

  it('accepts explicit causal recovery as available without clearing unrelated signals', () => {
    const scarce = asserted({
      eventId: 'signal:scarce',
      subjectRef: { type: 'cat', catId: 'sol' },
      state: 'scarce',
    });
    const poolUnavailable = asserted({
      eventId: 'signal:pool-unavailable',
      subjectRef: { type: 'quota_pool', poolId: 'pool-a' },
      state: 'unavailable',
    });
    const recovered = closed('recovered', 'signal:recovered', ['signal:scarce']);
    const sol = byCat(reduce({ signalEvents: [recovered, poolUnavailable, scarce] }), 'sol');
    assert.equal(sol.availability, 'unavailable');
    assert.ok(sol.reasons.some((reason) => reason.sourceRefs.includes('signal:pool-unavailable')));
    assert.ok(!sol.reasons.some((reason) => reason.sourceRefs.includes('signal:scarce')));

    const onlyRecovered = byCat(reduce({ signalEvents: [scarce, recovered] }), 'sol');
    assert.equal(onlyRecovered.availability, 'available');
    assert.equal(onlyRecovered.freshness, 'fresh');
    assert.equal(onlyRecovered.effect, 'eligible');
  });

  it('is deterministic across event order and equal timestamps', () => {
    const events = [
      asserted({
        eventId: 'signal:b',
        subjectRef: { type: 'cat', catId: 'sol' },
        state: 'degraded',
        observedAt: 3_000,
      }),
      asserted({
        eventId: 'signal:a',
        subjectRef: { type: 'cat', catId: 'sol' },
        state: 'degraded',
        observedAt: 3_000,
      }),
    ];
    assert.deepEqual(reduce({ signalEvents: events }), reduce({ signalEvents: [...events].reverse() }));
    assert.deepEqual(
      byCat(reduce({ signalEvents: events }), 'sol').reasons.map((reason) => reason.sourceRefs[0]),
      ['signal:a'],
    );
    assert.deepEqual(byCat(reduce({ signalEvents: events }), 'sol').reasons[0].sourceRefs, [
      'signal:a',
      'evidence:signal:a',
      'signal:b',
      'evidence:signal:b',
    ]);
  });

  it('orders by active preferences but stops ordering at review_due or retired heads', () => {
    const active = reduce({ preferenceRevisions: [preference({})] });
    assert.deepEqual(
      active.candidates.map((entry) => entry.binding.catId),
      ['terra', 'sol'],
    );
    assert.deepEqual(byCat(active, 'terra').matchedPreferences, [
      { revisionId: 'preference:reviewer:v1', lifecycle: 'active' },
    ]);

    const reviewDue = reduce({ preferenceRevisions: [preference({ reviewAfter: NOW })] });
    assert.deepEqual(
      reviewDue.candidates.map((entry) => entry.binding.catId),
      ['sol', 'terra'],
    );
    assert.deepEqual(byCat(reviewDue, 'terra').matchedPreferences, [
      { revisionId: 'preference:reviewer:v1', lifecycle: 'review_due' },
    ]);

    const retiredHead = preference({
      revisionId: 'preference:reviewer:v2',
      version: 2,
      lifecycle: 'retired',
      supersedesRevisionId: 'preference:reviewer:v1',
      retiredAt: 9_000,
    });
    const retired = reduce({ preferenceRevisions: [preference({}), retiredHead] });
    assert.deepEqual(
      retired.candidates.map((entry) => entry.binding.catId),
      ['sol', 'terra'],
    );
    assert.deepEqual(byCat(retired, 'terra').matchedPreferences, []);
  });

  it('requires all preference eligibility guards before reordering', () => {
    const unavailableTerra = asserted({
      eventId: 'signal:terra-unavailable',
      subjectRef: { type: 'cat', catId: 'terra' },
      state: 'unavailable',
    });
    const snapshot = reduce({ signalEvents: [unavailableTerra], preferenceRevisions: [preference({})] });
    assert.deepEqual(
      snapshot.candidates.map((entry) => entry.binding.catId),
      ['sol', 'terra'],
    );
    assert.deepEqual(byCat(snapshot, 'terra').matchedPreferences, []);
  });

  it('projects only applied dossier revisions; pending proposal noise cannot change effect or order', () => {
    const revisionOne = reduce({
      profiles: [profile('sol', 'dossier:v1', 0), profile('terra', 'dossier:terra-v1', 0)],
    });
    const revisionTwoWithPending = reduce({
      profiles: [profile('sol', 'dossier:v2', 99), profile('terra', 'dossier:terra-v1', 50)],
    });

    assert.equal(byCat(revisionOne, 'sol').profile.revision.dossierRevision, 'dossier:v1');
    assert.equal(byCat(revisionTwoWithPending, 'sol').profile.revision.dossierRevision, 'dossier:v2');
    assert.equal(byCat(revisionTwoWithPending, 'sol').profile.revision.pendingProposalCount, 99);
    assert.deepEqual(
      revisionOne.candidates.map((entry) => [entry.binding.catId, entry.effect]),
      revisionTwoWithPending.candidates.map((entry) => [entry.binding.catId, entry.effect]),
    );
  });
});
