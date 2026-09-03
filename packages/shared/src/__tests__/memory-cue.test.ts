import { describe, expect, it } from 'vitest';

import {
  cueEnvelopeV1Schema,
  deliveryDecisionCueCarrierV1Schema,
  isRecallOpportunityV1,
  memoryCueDrillFamilyForResolver,
  RECALL_OPPORTUNITY_CATALOG_VERSION,
  RECALL_OPPORTUNITY_V1_PAIRS,
  recallOpportunityV1Schema,
} from '../types/memory-cue.js';

const scope = {
  ownerUserId: 'owner-1',
  threadId: 'thread-1',
  invocationId: 'invocation-1',
};

const fixtures = {
  subject_seen: {
    v: 1,
    kind: 'subject_seen',
    opportunityId: 'opportunity-subject-1',
    producer: 'entity_nudge',
    consumer: 'agent_route',
    scope,
    occurredAt: 1_785_600_000_000,
    payload: {
      entityId: 'entity-alden',
      matchedAlias: 'Alden',
      sourceMessageId: 'message-1',
    },
  },
  delivery_decision: {
    v: 1,
    kind: 'delivery_decision',
    opportunityId: 'opportunity-delivery-1',
    producer: 'github_ci',
    consumer: 'agent_route',
    scope,
    occurredAt: 1_785_600_000_001,
    payload: {
      repoFullName: 'zts212653/cat-cafe',
      prNumber: 3366,
      headSha: 'b83ce623eff16b0085be39801844e9b6b04c9313',
      phase: 'merge_gate',
      gateOutcome: 'source_evidence_complete',
      externalCondition: 'billing_spending_limit_zero_step',
      candidateAction: 'merge',
      sourceMessageId: 'message-2',
    },
  },
  judgment_surface_entered: {
    v: 1,
    kind: 'judgment_surface_entered',
    opportunityId: 'opportunity-judgment-1',
    producer: 'workflow_sop',
    consumer: 'agent_route',
    scope,
    occurredAt: 1_785_600_000_002,
    payload: {
      stage: 'review',
      selectedSkill: 'request-review',
      selectionSource: 'override',
      featureId: 'F287',
    },
  },
  approved_taste_invoked: {
    v: 1,
    kind: 'approved_taste_invoked',
    opportunityId: 'opportunity-taste-1',
    producer: 'owner_message',
    consumer: 'agent_route',
    scope,
    occurredAt: 1_785_600_000_003,
    payload: {
      triggerKey: 'ELI5',
      sourceMessageId: 'message-3',
    },
  },
  profile_revision_available: {
    v: 1,
    kind: 'profile_revision_available',
    opportunityId: 'opportunity-profile-1',
    producer: 'profile_repository',
    consumer: 'agent_route',
    scope,
    occurredAt: 1_785_600_000_004,
    payload: {
      profileUri: 'cat-cafe-profile://relationship/current',
      sourceRevision: 'sha256:profile-revision-1',
    },
  },
  recent_event_available: {
    v: 1,
    kind: 'recent_event_available',
    opportunityId: 'opportunity-event-1',
    producer: 'event_memory',
    consumer: 'agent_route',
    scope,
    occurredAt: 1_785_600_000_005,
    payload: {
      eventId: 'evt_1',
      subjectThreadId: scope.threadId,
      sourceRevision: 'sha256:event-revision-1',
    },
  },
} as const;

describe('F287 memory cue shared contract', () => {
  it('keeps resolver and drill family vocabularies on one canonical mapping', () => {
    expect([
      memoryCueDrillFamilyForResolver('person_entity'),
      memoryCueDrillFamilyForResolver('operational_precedent'),
      memoryCueDrillFamilyForResolver('taste'),
      memoryCueDrillFamilyForResolver('profile'),
      memoryCueDrillFamilyForResolver('event'),
      memoryCueDrillFamilyForResolver('project_knowledge'),
    ]).toEqual(['person_memory', 'evidence', 'taste', 'profile', 'event', null]);
  });

  it('admits only the six versioned producer/kind pairs after the Phase C vertical slices', () => {
    expect(RECALL_OPPORTUNITY_CATALOG_VERSION).toBe(3);
    expect(RECALL_OPPORTUNITY_V1_PAIRS).toEqual([
      { kind: 'subject_seen', producer: 'entity_nudge' },
      { kind: 'delivery_decision', producer: 'github_ci' },
      { kind: 'judgment_surface_entered', producer: 'workflow_sop' },
      { kind: 'approved_taste_invoked', producer: 'owner_message' },
      { kind: 'profile_revision_available', producer: 'profile_repository' },
      { kind: 'recent_event_available', producer: 'event_memory' },
    ]);

    for (const fixture of Object.values(fixtures)) {
      expect(recallOpportunityV1Schema.parse(fixture)).toEqual(fixture);
      expect(isRecallOpportunityV1(fixture)).toBe(true);
    }
  });

  it('keeps explicit Taste invocation strict and closed', () => {
    expect(recallOpportunityV1Schema.parse(fixtures.approved_taste_invoked)).toEqual(fixtures.approved_taste_invoked);
    expect(
      recallOpportunityV1Schema.safeParse({
        ...fixtures.approved_taste_invoked,
        payload: { ...fixtures.approved_taste_invoked.payload, triggerKey: 'unknown-taste' },
      }).success,
    ).toBe(false);
    expect(
      recallOpportunityV1Schema.safeParse({
        ...fixtures.approved_taste_invoked,
        payload: { ...fixtures.approved_taste_invoked.payload, rawQuery: 'search Taste' },
      }).success,
    ).toBe(false);
    expect(
      recallOpportunityV1Schema.safeParse({
        ...fixtures.approved_taste_invoked,
        producer: 'workflow_sop',
      }).success,
    ).toBe(false);
  });

  it.each([
    ['unknown kind', { ...fixtures.subject_seen, kind: 'raw_query' }],
    ['mismatched producer', { ...fixtures.subject_seen, producer: 'github_ci' }],
    ['free-text producer', { ...fixtures.subject_seen, producer: 'please remember this' }],
    ['raw query', { ...fixtures.subject_seen, rawQuery: 'search every memory' }],
    ['global score', { ...fixtures.subject_seen, globalScore: 0.99 }],
    ['whole-library payload', { ...fixtures.subject_seen, memoryLibrary: ['all', 'memory'] }],
    ['future trigger tags', { ...fixtures.subject_seen, futureTriggerTags: ['when Alden appears'] }],
    ['client scope', { ...fixtures.subject_seen, clientScope: scope }],
    ['top-level owner override', { ...fixtures.subject_seen, ownerUserId: 'attacker' }],
  ])('rejects forbidden opportunity structure: %s', (_label, candidate) => {
    expect(recallOpportunityV1Schema.safeParse(candidate).success).toBe(false);
    expect(isRecallOpportunityV1(candidate)).toBe(false);
  });

  it('keeps the cue envelope bounded and conclusion-free', () => {
    const cue = {
      v: 1,
      cueId: 'cue-1',
      opportunityId: fixtures.subject_seen.opportunityId,
      catalogVersion: 3,
      resolverFamily: 'person_entity',
      resolverVersion: 1,
      whyNow: 'A named subject is present in the current decision frame.',
      title: 'Known person context is available',
      summary: 'One owner-visible relationship memory can be drilled.',
      source: {
        anchor: 'person:alden',
        revision: 'revision-1',
        asOf: 1_700_000_000_000,
        visibility: 'owner_private',
      },
      drill: {
        family: 'person_memory',
        handle: 'opaque-handle-1',
      },
      scope,
      invalidators: ['source_corrected', 'source_forgotten', 'scope_revoked', 'superseded', 'expired'],
    } as const;

    expect(cueEnvelopeV1Schema.parse(cue)).toEqual(cue);
    expect(cueEnvelopeV1Schema.safeParse({ ...cue, conclusion: 'Always do this.' }).success).toBe(false);
    expect(cueEnvelopeV1Schema.safeParse({ ...cue, globalScore: 0.9 }).success).toBe(false);
    expect(cueEnvelopeV1Schema.safeParse({ ...cue, sourceBody: 'private reasoning' }).success).toBe(false);
  });

  it('keeps the GitHub carrier server-private, scope-free, and strict', () => {
    const carrier = {
      v: 1,
      producer: 'github_ci',
      producerProvenance: 'server_github_ci',
      repoFullName: 'zts212653/cat-cafe',
      prNumber: 3366,
      headSha: 'b83ce623eff16b0085be39801844e9b6b04c9313',
      phase: 'merge_gate',
      gateOutcome: 'source_evidence_complete',
      externalCondition: 'billing_spending_limit_zero_step',
      candidateAction: 'merge',
      occurredAt: 1_785_600_000_001,
    } as const;
    expect(deliveryDecisionCueCarrierV1Schema.parse(carrier)).toEqual(carrier);
    expect(deliveryDecisionCueCarrierV1Schema.safeParse({ ...carrier, ownerUserId: 'attacker' }).success).toBe(false);
    expect(deliveryDecisionCueCarrierV1Schema.safeParse({ ...carrier, trackingInstructions: 'merge' }).success).toBe(
      false,
    );
  });
});
