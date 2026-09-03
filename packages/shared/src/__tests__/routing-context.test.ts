import { describe, expect, it } from 'vitest';
import {
  capabilityProfileRevisionRefV1Schema,
  routingCandidateBindingV1Schema,
  routingContextSnapshotV1Schema,
  routingPreferenceRevisionV1Schema,
  routingPreflightDecisionV1Schema,
  routingSignalEventV1Schema,
} from '../types/routing-context.js';

const subject = { type: 'cat', catId: 'codex-sol' } as const;

const signalBase = {
  v: 1,
  eventId: 'route-signal-1',
  commandId: 'route-command-1',
  ownerId: 'owner-1',
  subjectRef: subject,
  reasonCode: 'quota_low',
  source: 'quota_probe',
  observedAt: 1_000,
  evidenceRef: 'telemetry:quota-probe:1',
} as const;

const preferenceBase = {
  v: 1,
  preferenceId: 'route-preference-1',
  revisionId: 'route-preference-1:v1',
  commandId: 'route-preference-command-1',
  ownerId: 'owner-1',
  appliesWhen: { intent: 'review', requireEligible: [subject] },
  prefer: [subject],
  over: [{ type: 'cat', catId: 'fable-5' }],
  rationale: 'Prefer the exact-HEAD reviewer for this review task.',
  evidenceRefs: ['message:preference-source-1'],
  version: 1,
  validFrom: 1_000,
} as const;

describe('F293 routing context V1 contracts', () => {
  it('accepts bounded immutable signal variants with explicit causal validity and closure', () => {
    expect(
      routingSignalEventV1Schema.parse({
        ...signalBase,
        eventType: 'asserted',
        state: 'scarce',
        validUntil: 2_000,
      }),
    ).toMatchObject({ eventType: 'asserted', state: 'scarce' });

    expect(
      routingSignalEventV1Schema.parse({
        ...signalBase,
        eventId: 'route-signal-2',
        commandId: 'route-command-2',
        eventType: 'recovered',
        state: 'available',
        closesSignalIds: ['route-signal-1'],
      }),
    ).toMatchObject({ eventType: 'recovered', closesSignalIds: ['route-signal-1'] });
  });

  it('rejects assertions without a future validity boundary and close events without exact causes', () => {
    expect(
      routingSignalEventV1Schema.safeParse({
        ...signalBase,
        eventType: 'asserted',
        state: 'degraded',
      }).success,
    ).toBe(false);
    expect(
      routingSignalEventV1Schema.safeParse({
        ...signalBase,
        eventType: 'asserted',
        state: 'unavailable',
        resetAt: 999,
      }).success,
    ).toBe(false);
    expect(
      routingSignalEventV1Schema.safeParse({
        ...signalBase,
        eventType: 'retracted',
        closesSignalIds: [],
      }).success,
    ).toBe(false);
  });

  it('requires proof-bearing, unique quota-pool bindings instead of inferred account scope', () => {
    const candidate = {
      v: 1,
      catId: 'codex-sol',
      providerId: 'openai',
      provenQuotaPools: [{ poolId: 'team-openai', evidenceRef: 'catalog:binding:1' }],
    } as const;
    expect(routingCandidateBindingV1Schema.parse(candidate)).toEqual(candidate);
    expect(
      routingCandidateBindingV1Schema.safeParse({
        ...candidate,
        provenQuotaPools: [{ poolId: 'team-openai' }],
      }).success,
    ).toBe(false);
    expect(
      routingCandidateBindingV1Schema.safeParse({
        ...candidate,
        provenQuotaPools: [candidate.provenQuotaPools[0], candidate.provenQuotaPools[0]],
      }).success,
    ).toBe(false);
  });

  it('separates stable preference identity from immutable revision identity', () => {
    expect(
      routingPreferenceRevisionV1Schema.parse({
        ...preferenceBase,
        lifecycle: 'active',
        reviewAfter: 2_000,
      }),
    ).toMatchObject({ preferenceId: 'route-preference-1', revisionId: 'route-preference-1:v1' });

    const { preferenceId: _preferenceId, ...ambiguousIdentity } = preferenceBase;
    expect(
      routingPreferenceRevisionV1Schema.safeParse({
        ...ambiguousIdentity,
        id: 'route-preference-1',
        lifecycle: 'active',
      }).success,
    ).toBe(false);
  });

  it('enforces monotonic supersedes relations and terminal retirement evidence', () => {
    expect(
      routingPreferenceRevisionV1Schema.safeParse({
        ...preferenceBase,
        lifecycle: 'active',
        supersedesRevisionId: 'route-preference-1:v0',
      }).success,
    ).toBe(false);
    expect(
      routingPreferenceRevisionV1Schema.safeParse({
        ...preferenceBase,
        revisionId: 'route-preference-1:v2',
        version: 2,
        lifecycle: 'active',
      }).success,
    ).toBe(false);
    expect(
      routingPreferenceRevisionV1Schema.safeParse({
        ...preferenceBase,
        revisionId: 'route-preference-1:v2',
        version: 2,
        lifecycle: 'retired',
        supersedesRevisionId: 'route-preference-1:v1',
        retiredAt: 2_000,
      }).success,
    ).toBe(false);
    expect(
      routingPreferenceRevisionV1Schema.parse({
        ...preferenceBase,
        revisionId: 'route-preference-1:v2',
        commandId: 'route-preference-command-2',
        version: 2,
        lifecycle: 'retired',
        supersedesRevisionId: 'route-preference-1:v1',
        retiredAt: 2_000,
        retirementReason: 'The reviewer rotation changed.',
      }),
    ).toMatchObject({ lifecycle: 'retired', version: 2 });
  });

  it('keeps applied capability provenance and pending proposal visibility distinct', () => {
    expect(
      capabilityProfileRevisionRefV1Schema.parse({
        v: 1,
        catId: 'codex-sol',
        modelId: 'gpt-5.6-sol',
        dossierRevision: 'sha256:dossier-1',
        updatedAt: 1_000,
        relevantSignals: [
          {
            kind: 'strength',
            summary: 'Evidence-driven architecture work',
            evidenceRefs: ['docs:team/cat-dossier.md#codex-sol'],
          },
        ],
        pendingProposalCount: 2,
      }),
    ).toMatchObject({ dossierRevision: 'sha256:dossier-1', pendingProposalCount: 2 });
  });

  it('accepts explainable pure snapshot and preflight projections without opaque scores', () => {
    const reason = {
      code: 'active_signal',
      summary: 'A current quota signal is advisory.',
      sourceRefs: ['route-signal-1'],
    } as const;
    const snapshot = {
      v: 1,
      ownerId: 'owner-1',
      observedAt: 1_500,
      catalogRevision: 'catalog-v1',
      candidates: [
        {
          binding: { v: 1, catId: 'codex-sol', providerId: 'openai', provenQuotaPools: [] },
          profile: { state: 'absent' },
          availability: 'scarce',
          freshness: 'fresh',
          reasons: [reason],
          matchedPreferences: [{ revisionId: 'route-preference-1:v1', lifecycle: 'active' }],
          effect: 'advisory',
        },
      ],
    } as const;
    expect(routingContextSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);

    const decision = {
      v: 1,
      ownerId: 'owner-1',
      observedAt: 1_500,
      resolverState: 'fresh',
      snapshotRef: 'routing-snapshot:catalog-v1:1500',
      targets: [
        {
          targetCatId: 'codex-sol',
          disposition: 'warned',
          reasons: [reason],
          alternatives: [{ catId: 'fable-5', reasonRefs: ['route-preference-1:v1'] }],
        },
      ],
    } as const;
    expect(routingPreflightDecisionV1Schema.parse(decision)).toEqual(decision);
    expect(routingContextSnapshotV1Schema.safeParse({ ...snapshot, score: 0.8 }).success).toBe(false);
  });

  it('is exported through the shared type barrel', async () => {
    const mod = await import('../types/index.js');
    expect(mod.routingSignalEventV1Schema).toBe(routingSignalEventV1Schema);
    expect(mod.routingPreflightDecisionV1Schema).toBe(routingPreflightDecisionV1Schema);
  });
});
