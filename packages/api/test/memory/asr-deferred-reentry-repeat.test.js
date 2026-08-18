import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeOpportunityGenerationId } from '@cat-cafe/shared';

describe('F276 repeated deferred write-opportunity re-entry', () => {
  it('reconstructs generation 2 from the stable owner scene before minting generation 3', async () => {
    const { createDeferredPersonMemoryDailyTaskSpec } = await import(
      '../../dist/domains/memory/DeferredPersonMemoryDailyTaskSpec.js'
    );
    const dedupeLineage = `write_lineage_${'a'.repeat(32)}`;
    const sourceRefs = [
      {
        artifactId: 'meeting-intake-1',
        sourceRevision: `sha256:${'b'.repeat(64)}`,
        attributionRevision: `sha256:${'d'.repeat(64)}`,
        segmentStart: 0,
        segmentEnd: 128,
      },
    ];
    const originalOpportunity = {
      v: 1,
      opportunityId: writeOpportunityGenerationId(dedupeLineage, 1),
      reflexId: 'asr-person-memory',
      reflexVersion: 1,
      generation: 1,
      producer: 'meeting_artifact',
      consumer: { kind: 'cat', catId: 'codex-sol' },
      scope: { ownerUserId: 'owner-1', threadId: 'thread_current' },
      observedAt: 100,
      eligibleAt: 100,
      expiresAt: 10_000,
      sourceCoordinates: [
        {
          kind: 'asr_transcript_segment',
          artifactId: 'meeting-intake-1',
          sourceHandle: 'lark://minutes/1',
          sourceRevision: sourceRefs[0].sourceRevision,
          segment: { unit: 'utf8_byte', start: 0, end: 128 },
          speaker: {
            externalSpeakerId: 'speaker-1',
            label: 'Speaker 1',
            attributionRevision: sourceRefs[0].attributionRevision,
            attributionCeiling: 'owner_confirmed_mapping',
          },
        },
      ],
      epistemicCeiling: 'mechanical_observation',
      destination: { lane: 'person_memory', proposalContract: 'F276.CaptureCandidate.v1' },
      dedupeLineage,
      rearmPredicate: 'next_eligible_owner_context_after_defer',
    };
    const generation = 2;
    const opportunityId = writeOpportunityGenerationId(dedupeLineage, generation);
    const lineage = {
      reflexId: 'asr-person-memory',
      reflexVersion: 1,
      opportunityId,
      dedupeLineage,
      generation,
    };
    const receiptId = `deferred_person_${'e'.repeat(32)}`;
    const receipt = {
      receiptId,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      invocationId: 'invocation-2',
      originMessageRef: { kind: 'message', threadId: 'thread_current', messageId: 'message_origin' },
      subject: 'Alden',
      normalizedSubject: 'alden',
      registryBinding: { kind: 'registered_person', ref: 'person_alden' },
      sourceCoordinates: [
        {
          kind: 'message',
          sourceRef: { kind: 'message', threadId: 'thread_history', messageId: 'message_fact' },
          resolvedDigest: 'b'.repeat(64),
        },
      ],
      sourceBundleDigest: 'c'.repeat(64),
      dedupeHash: 'd'.repeat(64),
      state: 'deferred',
      retention: 'owner_controlled_no_ttl',
      writeOpportunityLineage: lineage,
      writeOpportunityReceipt: {
        v: 1,
        receiptId,
        ...lineage,
        sourceRefs,
        eligibleAt: 501,
        expiresAt: originalOpportunity.expiresAt,
        rearmPredicate: 'next_eligible_owner_context_after_defer',
        destinationProposalContract: 'F276.CaptureCandidate.v1',
        state: 'deferred',
      },
      createdAt: 100,
      updatedAt: 500,
    };
    const spec = createDeferredPersonMemoryDailyTaskSpec({
      receiptStore: {
        async listReady() {
          return [receipt];
        },
        async claim(input) {
          return {
            outcome: 'claimed',
            receipt: { ...receipt, state: 'claimed', claimId: input.claimId, claimUntil: input.now + input.leaseMs },
          };
        },
        async release() {
          return true;
        },
        async hardForget() {
          return { outcome: 'purged' };
        },
      },
      messageStore: {
        async getById() {
          return {
            id: 'message_origin',
            userId: 'owner-1',
            catId: null,
            threadId: 'thread_current',
            content: 'meeting attachment',
            mentions: [],
            timestamp: 100,
            extra: {
              dynamicSceneEntries: [
                {
                  v: 1,
                  kind: 'memory_write_opportunity',
                  surface: 'dynamic_context',
                  opportunity: originalOpportunity,
                },
              ],
            },
          };
        },
      },
      writeOpportunityTerminalLedger: {
        async readLineageStates() {
          return new Map([
            [
              dedupeLineage,
              {
                terminalGenerations: new Map([
                  [1, 'defer'],
                  [2, 'defer'],
                ]),
              },
            ],
          ]);
        },
        async recordTerminal() {},
        async recordInvalidated() {},
      },
      writeOpportunityDeliveryStore: {
        async purgeLineage() {
          return 0;
        },
      },
      ownerUserId: 'owner-1',
      now: () => 1_000,
      randomId: () => 'claim-generation-3',
    });

    const admission = await spec.admission.gate({});

    assert.equal(admission.run, true);
    assert.equal(admission.workItems[0].signal.writeOpportunityReentry.scene.opportunity.generation, 3);
    assert.equal(
      admission.workItems[0].signal.writeOpportunityReentry.scene.opportunity.opportunityId,
      writeOpportunityGenerationId(dedupeLineage, 3),
    );
  });
});
