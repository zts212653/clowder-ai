import { describe, expect, it } from 'vitest';
import {
  ASR_PERSON_MEMORY_REFLEX_ENTRY_V1,
  asrPersonMemoryDynamicSceneEntryV1Schema,
  deferredWriteOpportunityReceiptV1Schema,
  writeOpportunityDispositionV1Schema,
  writeOpportunityGenerationId,
} from '../types/memory-write-opportunity.js';

const opportunity = {
  v: 1 as const,
  opportunityId: `write_opp_${'a'.repeat(32)}`,
  reflexId: 'asr-person-memory',
  reflexVersion: 1 as const,
  generation: 1,
  producer: 'meeting_artifact',
  consumer: { kind: 'cat' as const, catId: 'codex-sol' },
  scope: { ownerUserId: 'owner-1', threadId: 'thread-1' },
  observedAt: 1_000,
  eligibleAt: 1_000,
  expiresAt: 2_000,
  sourceCoordinates: [
    {
      kind: 'asr_transcript_segment' as const,
      artifactId: 'meeting-intake-1',
      sourceHandle: 'lark://minutes/1',
      sourceRevision: `sha256:${'b'.repeat(64)}`,
      segment: { unit: 'utf8_byte' as const, start: 0, end: 128 },
      speaker: {
        externalSpeakerId: 'speaker-1',
        label: 'Alden',
        attributionRevision: `sha256:${'d'.repeat(64)}`,
        attributionCeiling: 'owner_confirmed_mapping' as const,
      },
    },
  ],
  epistemicCeiling: 'mechanical_observation' as const,
  destination: {
    lane: 'person_memory' as const,
    proposalContract: 'F276.CaptureCandidate.v1' as const,
  },
  dedupeLineage: `write_lineage_${'c'.repeat(32)}`,
  rearmPredicate: 'next_eligible_owner_context_after_defer' as const,
};

describe('ASR → F276 standing reflex contract', () => {
  it('mints stable generation-scoped opportunity IDs in the shared contract', () => {
    const first = writeOpportunityGenerationId(opportunity.dedupeLineage, 1);
    expect(first).toMatch(/^write_opp_[a-f0-9]{32}$/);
    expect(writeOpportunityGenerationId(opportunity.dedupeLineage, 1)).toBe(first);
    expect(writeOpportunityGenerationId(opportunity.dedupeLineage, 2)).not.toBe(first);
  });

  it('is dynamic-only and sends immediate/deferred paths to one F276 proposal contract', () => {
    expect(ASR_PERSON_MEMORY_REFLEX_ENTRY_V1).toMatchObject({
      reflexId: 'asr-person-memory',
      eligibleSurfaces: ['dynamic_context'],
      allowedDispositions: ['propose', 'defer', 'abstain'],
      immediateTargetByLane: { person_memory: 'F276.CaptureCandidate.v1' },
      deferredTargetByLane: { person_memory: 'F276.CaptureCandidate.v1' },
    });
    expect(ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.eligibleSurfaces).not.toContain('native_l0');
    expect(ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.eligibleSurfaces).not.toContain('staging');
  });

  it('accepts source-only mechanical observations and rejects judgment fields', () => {
    const scene = {
      v: 1 as const,
      kind: 'memory_write_opportunity' as const,
      surface: 'dynamic_context' as const,
      opportunity,
    };
    expect(asrPersonMemoryDynamicSceneEntryV1Schema.parse(scene)).toEqual(scene);

    for (const forbidden of [
      { transcript: 'private transcript body' },
      { intent: 'You wants us to remember this' },
      { importance: 'high' },
      { truth: true },
      { candidatePayload: { fact: 'secret' } },
    ]) {
      expect(
        asrPersonMemoryDynamicSceneEntryV1Schema.safeParse({
          ...scene,
          opportunity: { ...opportunity, ...forbidden },
        }).success,
      ).toBe(false);
    }
  });

  it('keeps defer receipts content-free while preserving re-entry lineage', () => {
    const receipt = {
      v: 1 as const,
      receiptId: `deferred_person_${'d'.repeat(32)}`,
      opportunityId: opportunity.opportunityId,
      reflexId: opportunity.reflexId,
      reflexVersion: opportunity.reflexVersion,
      generation: opportunity.generation,
      dedupeLineage: opportunity.dedupeLineage,
      sourceRefs: [
        {
          artifactId: 'meeting-intake-1',
          sourceRevision: `sha256:${'b'.repeat(64)}`,
          attributionRevision: `sha256:${'d'.repeat(64)}`,
          segmentStart: 0,
          segmentEnd: 128,
        },
      ],
      eligibleAt: 1_500,
      expiresAt: opportunity.expiresAt,
      rearmPredicate: opportunity.rearmPredicate,
      destinationProposalContract: opportunity.destination.proposalContract,
      state: 'deferred' as const,
    };
    expect(deferredWriteOpportunityReceiptV1Schema.parse(receipt)).toEqual(receipt);
    expect(deferredWriteOpportunityReceiptV1Schema.safeParse({ ...receipt, transcript: 'secret body' }).success).toBe(
      false,
    );
    expect(deferredWriteOpportunityReceiptV1Schema.safeParse({ ...receipt, rationale: 'important' }).success).toBe(
      false,
    );
  });

  it('requires exactly one typed disposition and exact destination lineage', () => {
    expect(
      writeOpportunityDispositionV1Schema.parse({
        v: 1,
        opportunityId: opportunity.opportunityId,
        generation: 1,
        disposition: 'propose',
        recordedAt: 1_200,
        destination: {
          proposalContract: 'F276.CaptureCandidate.v1',
          proposalId: 'person_candidate_1',
        },
      }),
    ).toMatchObject({ disposition: 'propose' });
    expect(
      writeOpportunityDispositionV1Schema.safeParse({
        v: 1,
        opportunityId: opportunity.opportunityId,
        generation: 1,
        disposition: 'abstain',
        recordedAt: 1_200,
        reasonCode: 'not_continuity_valued',
        proposalId: 'person_candidate_1',
      }).success,
    ).toBe(false);
  });
});
