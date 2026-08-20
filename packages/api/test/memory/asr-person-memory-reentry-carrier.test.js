import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

const LINEAGE = `write_lineage_${'a'.repeat(32)}`;
const ORIGINAL_ID = `write_opp_${'a'.repeat(24)}00000001`;

function scene(generation = 1) {
  return {
    v: 1,
    kind: 'memory_write_opportunity',
    surface: 'dynamic_context',
    opportunity: {
      v: 1,
      opportunityId: `write_opp_${'a'.repeat(24)}${generation.toString(16).padStart(8, '0')}`,
      reflexId: 'asr-person-memory',
      reflexVersion: 1,
      generation,
      producer: 'meeting_artifact',
      consumer: { kind: 'cat', catId: 'codex-sol' },
      scope: { ownerUserId: 'owner-1', threadId: 'thread-1' },
      observedAt: 1,
      eligibleAt: generation,
      expiresAt: 10_000,
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
      dedupeLineage: LINEAGE,
      rearmPredicate: 'next_eligible_owner_context_after_defer',
    },
  };
}

describe('F276 scheduler re-entry carrier', () => {
  let bind;

  before(async () => {
    ({ bindAsrPersonMemoryReentryFromSchedulerMessage: bind } = await import(
      '../../dist/domains/memory/people/AsrPersonMemoryReentryCarrier.js'
    ));
  });

  function messages(overrides = {}) {
    const source = {
      id: 'owner-message-1',
      userId: 'owner-1',
      catId: null,
      content: 'meeting attachment',
      mentions: [],
      timestamp: 1,
      threadId: 'thread-1',
      extra: { dynamicSceneEntries: [scene(1)] },
      ...overrides.source,
    };
    const trigger = {
      id: 'scheduler-message-1',
      userId: 'scheduler',
      catId: null,
      content: 'daily clerk',
      mentions: [],
      timestamp: 2,
      threadId: 'thread-1',
      source: { connector: 'scheduler', label: '定时任务', icon: 'scheduler' },
      extra: {
        scheduler: { hiddenTrigger: true },
        writeOpportunityReentry: {
          v: 1,
          sourceMessageRef: { kind: 'message', threadId: 'thread-1', messageId: source.id },
          sourceOpportunityId: ORIGINAL_ID,
          priorGeneration: 1,
          scene: scene(2),
        },
      },
      ...overrides.trigger,
    };
    return { source, trigger };
  }

  async function resolve(overrides = {}) {
    const { source, trigger } = messages(overrides);
    return bind({
      triggerMessage: trigger,
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      messageStore: { getById: async () => source },
    });
  }

  it('binds generation+1 only after re-reading the exact live owner source', async () => {
    const result = await resolve();
    assert.equal(result.length, 1);
    assert.equal(result[0].scene.opportunity.generation, 2);
    assert.equal(result[0].scene.opportunity.dedupeLineage, LINEAGE);
    assert.deepEqual(result[0].source, {
      kind: 'message',
      threadId: 'thread-1',
      sourceMessageId: 'owner-message-1',
      authorUserId: 'owner-1',
      authorRole: 'owner',
      visibility: 'verified_live_owner_message',
    });
  });

  it('binds a later generation against the stable generation-1 owner scene', async () => {
    const result = await resolve({
      trigger: {
        extra: {
          scheduler: { hiddenTrigger: true },
          writeOpportunityReentry: {
            v: 1,
            sourceMessageRef: { kind: 'message', threadId: 'thread-1', messageId: 'owner-message-1' },
            sourceOpportunityId: ORIGINAL_ID,
            priorGeneration: 2,
            scene: scene(3),
          },
        },
      },
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].scene.opportunity.generation, 3);
  });

  it('fails closed on source deletion, source revision drift, or a forged generation', async () => {
    assert.deepEqual(await resolve({ source: { deletedAt: 3 } }), []);
    assert.deepEqual(await resolve({ source: { extra: { dynamicSceneEntries: [] } } }), []);
    const forged = scene(2);
    forged.opportunity.generation = 3;
    assert.deepEqual(
      await resolve({
        trigger: {
          extra: {
            scheduler: { hiddenTrigger: true },
            writeOpportunityReentry: {
              v: 1,
              sourceMessageRef: { kind: 'message', threadId: 'thread-1', messageId: 'owner-message-1' },
              sourceOpportunityId: ORIGINAL_ID,
              priorGeneration: 1,
              scene: forged,
            },
          },
        },
      }),
      [],
    );
  });

  it('does not accept an owner-authored or visible scheduler lookalike as authority', async () => {
    assert.deepEqual(await resolve({ trigger: { userId: 'owner-1' } }), []);
    assert.deepEqual(
      await resolve({
        trigger: {
          extra: {
            ...messages().trigger.extra,
            scheduler: { hiddenTrigger: false },
          },
        },
      }),
      [],
    );
  });
});
