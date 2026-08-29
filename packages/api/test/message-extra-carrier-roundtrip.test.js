import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const MESSAGE_BUNDLE = {
  v: 1,
  sourceThreadId: 'thread-source',
  note: 'bundle-level reason',
  items: [
    { kind: 'message', messageId: 'message-source-1' },
    {
      kind: 'cli_quote',
      messageId: 'message-cli',
      sourceMessageIds: ['message-cli'],
      segmentId: 'stdout',
      selectionStart: 0,
      selectionEnd: 4,
      sourceProjectionVersion: 1,
      sourceProjectionSha256: 'a'.repeat(64),
    },
    {
      kind: 'rich_block',
      messageId: 'message-rich',
      sourceMessageIds: ['message-rich'],
      blockId: 'card-1',
      sourceProjectionVersion: 1,
      sourceProjectionSha256: 'b'.repeat(64),
    },
  ],
};

describe('durable message extra carriers survive Redis round-trips', () => {
  it('F167 preserves a typed local-review verdict for settlement and replay', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    for (const verdict of ['approved', 'changes_requested', 'commented']) {
      const input = {
        localReviewVerdict: {
          verdict,
          clientMessageId: `local-review-verdict-roundtrip-${verdict}`,
          reviewedHeadSha: 'a'.repeat(40),
          carrierlessLeaseFence: { leaseId: 'lease-review-roundtrip-1', generation: 3 },
        },
      };

      assert.deepEqual(safeParseExtra(serializeExtra(input)), input);
    }
  });

  it('F167 drops malformed local-review verdicts without dropping valid sibling metadata', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    for (const localReviewVerdict of [
      { verdict: 'approve', clientMessageId: 'typed-verdict-1' },
      { verdict: 'approved', clientMessageId: '' },
      { verdict: 'approved', clientMessageId: 'x'.repeat(201) },
      { verdict: 'approved', clientMessageId: 'typed-verdict-1', reviewedHeadSha: 'ABC1234' },
      { verdict: 'approved', clientMessageId: 'typed-verdict-1', reviewedHeadSha: 'a'.repeat(39) },
      {
        verdict: 'approved',
        clientMessageId: 'typed-verdict-1',
        carrierlessLeaseFence: { leaseId: '', generation: 1 },
      },
      {
        verdict: 'approved',
        clientMessageId: 'typed-verdict-1',
        carrierlessLeaseFence: { leaseId: 'lease-review-1', generation: 0 },
      },
    ]) {
      const parsed = safeParseExtra(
        serializeExtra({
          localReviewVerdict,
          targetCats: ['opus5'],
        }),
      );

      assert.deepEqual(parsed?.targetCats, ['opus5']);
      assert.equal(parsed?.localReviewVerdict, undefined);
    }
  });

  it('F294 preserves a Message Bundle while tracing metadata is merged', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const hydrated = safeParseExtra(serializeExtra({ messageBundle: MESSAGE_BUNDLE }));
    const input = {
      ...hydrated,
      tracing: {
        traceId: 'aaaa1111bbbb2222cccc3333dddd4444',
        spanId: '1122334455667788',
      },
    };

    assert.deepEqual(safeParseExtra(serializeExtra(input)), input);
  });

  it('F294 drops a malformed Message Bundle without dropping valid sibling metadata', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const parsed = safeParseExtra(
      serializeExtra({
        messageBundle: { ...MESSAGE_BUNDLE, items: [{ kind: 'message', messageId: '' }] },
        targetCats: ['opus'],
      }),
    );

    assert.deepEqual(parsed?.targetCats, ['opus']);
    assert.equal(parsed?.messageBundle, undefined);
  });

  it('preserves the F272, F292, and write-opportunity carriers', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const dynamicScene = {
      v: 1,
      kind: 'memory_write_opportunity',
      surface: 'dynamic_context',
      opportunity: {
        v: 1,
        opportunityId: `write_opp_${'a'.repeat(24)}00000001`,
        reflexId: 'asr-person-memory',
        reflexVersion: 1,
        generation: 1,
        producer: 'meeting_artifact',
        consumer: { kind: 'cat', catId: 'codex-sol' },
        scope: { ownerUserId: 'owner-1', threadId: 'thread-1' },
        observedAt: 1,
        eligibleAt: 2,
        expiresAt: 3,
        sourceCoordinates: [
          {
            kind: 'asr_transcript_segment',
            artifactId: 'intake-1',
            sourceHandle: 'meeting://source-1',
            sourceRevision: `sha256:${'b'.repeat(64)}`,
            segment: { unit: 'utf8_byte', start: 0, end: 4 },
            speaker: {
              externalSpeakerId: 'speaker-1',
              label: 'Owner-confirmed speaker',
              attributionRevision: `sha256:${'c'.repeat(64)}`,
              attributionCeiling: 'owner_confirmed_mapping',
            },
          },
        ],
        epistemicCeiling: 'mechanical_observation',
        destination: { lane: 'person_memory', proposalContract: 'F276.CaptureCandidate.v1' },
        dedupeLineage: `write_lineage_${'a'.repeat(32)}`,
        rearmPredicate: 'next_eligible_owner_context_after_defer',
      },
    };
    const input = {
      proactive: { visitId: 'visit-1', intentId: 'intent-1', source: 'private_time' },
      meetingArtifact: {
        intakeId: 'intake-1',
        sourceHandle: 'meeting://source-1',
        resourceRef: `meeting-artifact://intakes/intake-1?revision=sha256:${'b'.repeat(64)}`,
        sourceRevision: `sha256:${'b'.repeat(64)}`,
        byteLength: 4,
        contentType: 'text/plain',
        trust: 'untrusted_external',
        instructionPolicy: 'data_only',
      },
      dynamicSceneEntries: [dynamicScene],
      writeOpportunityReentry: {
        v: 1,
        sourceMessageRef: { kind: 'message', threadId: 'thread-1', messageId: 'message-source-1' },
        sourceOpportunityId: dynamicScene.opportunity.opportunityId,
        priorGeneration: 1,
        scene: {
          ...dynamicScene,
          opportunity: {
            ...dynamicScene.opportunity,
            opportunityId: `write_opp_${'a'.repeat(24)}00000002`,
            generation: 2,
          },
        },
      },
      writeOpportunityPresentationRetry: {
        v: 1,
        sourceMessageRef: { kind: 'message', threadId: 'thread-1', messageId: 'message-source-1' },
        sourceOpportunityId: dynamicScene.opportunity.opportunityId,
      },
    };

    assert.deepEqual(safeParseExtra(serializeExtra(input)), input);
  });

  it('fails closed on malformed proactive and meeting-artifact carriers', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const parsed = safeParseExtra(
      serializeExtra({
        proactive: { visitId: '', intentId: 'intent-1', source: 'private_time' },
        meetingArtifact: {
          intakeId: 'intake-1',
          sourceHandle: 'meeting://source-1',
          trust: 'trusted',
          instructionPolicy: 'data_only',
        },
        isExplicitPost: true,
      }),
    );

    assert.equal(parsed?.proactive, undefined);
    assert.equal(parsed?.meetingArtifact, undefined);
    assert.equal(parsed?.isExplicitPost, true);
  });
});
