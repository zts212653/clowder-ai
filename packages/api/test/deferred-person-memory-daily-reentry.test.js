import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeOpportunityGenerationId } from '@cat-cafe/shared';

describe('F276 deferred person-memory daily clerk re-entry', () => {
  it('surfaces write-opportunity re-entry when the receipt carries lineage', async () => {
    // SR:174-176: the trial must empirically show a deferred opportunity re-entering a later
    // eligible context and still landing on the same F276 destination. The clerk is that context,
    // so the woken cat has to be told which opportunity generation it is re-judging.
    const { createDeferredPersonMemoryDailyTaskSpec } = await import(
      '../dist/domains/memory/DeferredPersonMemoryDailyTaskSpec.js'
    );
    const opportunity = {
      v: 1,
      opportunityId: writeOpportunityGenerationId(`write_lineage_${'a'.repeat(32)}`, 1),
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
          sourceRevision: `sha256:${'b'.repeat(64)}`,
          segment: { unit: 'utf8_byte', start: 0, end: 128 },
          speaker: {
            externalSpeakerId: 'speaker-1',
            label: 'Speaker 1',
            attributionRevision: `sha256:${'d'.repeat(64)}`,
            attributionCeiling: 'owner_confirmed_mapping',
          },
        },
      ],
      epistemicCeiling: 'mechanical_observation',
      destination: { lane: 'person_memory', proposalContract: 'F276.CaptureCandidate.v1' },
      dedupeLineage: `write_lineage_${'a'.repeat(32)}`,
      rearmPredicate: 'next_eligible_owner_context_after_defer',
    };
    const lineage = {
      reflexId: 'asr-person-memory',
      reflexVersion: 1,
      opportunityId: opportunity.opportunityId,
      dedupeLineage: opportunity.dedupeLineage,
      generation: 1,
    };
    const writeOpportunityReceipt = {
      v: 1,
      receiptId: `deferred_person_${'e'.repeat(32)}`,
      ...lineage,
      sourceRefs: [
        {
          artifactId: 'meeting-intake-1',
          sourceRevision: `sha256:${'b'.repeat(64)}`,
          attributionRevision: `sha256:${'d'.repeat(64)}`,
          segmentStart: 0,
          segmentEnd: 128,
        },
      ],
      eligibleAt: 101,
      expiresAt: 10_000,
      rearmPredicate: 'next_eligible_owner_context_after_defer',
      destinationProposalContract: 'F276.CaptureCandidate.v1',
      state: 'deferred',
    };
    const receipt = {
      receiptId: `deferred_person_${'e'.repeat(32)}`,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      invocationId: 'invocation-1',
      originMessageRef: { kind: 'message', threadId: 'thread_current', messageId: 'message_origin' },
      subject: '黄挺',
      normalizedSubject: '黄挺',
      registryBinding: { kind: 'registered_person', ref: 'person_huang_ting' },
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
      writeOpportunityReceipt,
      createdAt: 100,
      updatedAt: 100,
    };
    const delivered = [];
    const messageStore = {
      async getById(messageId) {
        assert.equal(messageId, 'message_origin');
        return {
          id: 'message_origin',
          userId: 'owner-1',
          catId: null,
          threadId: 'thread_current',
          content: 'meeting attachment',
          mentions: [],
          timestamp: 100,
          extra: {
            meetingArtifact: {
              intakeId: 'intake-1',
              sourceHandle: 'lark://minutes/1',
              trust: 'untrusted_external',
              instructionPolicy: 'data_only',
            },
            dynamicSceneEntries: [{ v: 1, kind: 'memory_write_opportunity', surface: 'dynamic_context', opportunity }],
          },
        };
      },
    };
    const spec = createDeferredPersonMemoryDailyTaskSpec({
      receiptStore: {
        async listReady() {
          return [receipt];
        },
        async get() {
          return receipt;
        },
        async claim(input) {
          return {
            outcome: 'claimed',
            receipt: {
              ...receipt,
              state: 'claimed',
              claimId: input.claimId,
              claimUntil: input.now + input.leaseMs,
              processorCatId: input.processorCatId,
              processingThreadId: input.processingThreadId,
            },
          };
        },
        async bindProcessingMessage(input) {
          return { outcome: 'bound', receipt: { receiptId: input.receiptId } };
        },
        async release() {
          return true;
        },
        async hardForget() {
          return { outcome: 'purged' };
        },
      },
      ensureSystemThread: async () => 'thread_memory_operations',
      routingDispatchPreflight: {
        async preflight(input) {
          return {
            v: 1,
            ownerId: input.ownerId,
            observedAt: 1_000,
            resolverState: 'fresh',
            targets: [{ targetCatId: input.targetCatIds[0], disposition: 'allowed', reasons: [], alternatives: [] }],
          };
        },
      },
      messageStore,
      writeOpportunityTerminalLedger: {
        async readLineageStates() {
          return new Map([[lineage.dedupeLineage, { terminalGenerations: new Map([[1, 'defer']]) }]]);
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
      randomId: () => 'claim-daily-2',
    });
    const admission = await spec.admission.gate({});

    await spec.run.execute(admission.workItems[0].signal, admission.workItems[0].subjectKey, {
      assignedCatId: 'codex-terra',
      deliver: async (input) => {
        delivered.push(input);
        return 'daily-trigger-message';
      },
      invokeTrigger: { async trigger() {} },
    });

    const content = delivered[0].content;
    // names the exact generation being re-judged, and the unchanged destination
    assert.match(content, new RegExp(lineage.opportunityId));
    assert.match(content, new RegExp(lineage.dedupeLineage));
    assert.match(content, /priorGeneration=1/);
    assert.match(content, /F276\.CaptureCandidate\.v1/);
    assert.equal(delivered[0].extra.writeOpportunityReentries.length, 1);
    assert.equal(delivered[0].extra.writeOpportunityReentries[0].scene.opportunity.generation, 2);
    assert.equal(
      delivered[0].extra.writeOpportunityReentries[0].scene.opportunity.dedupeLineage,
      lineage.dedupeLineage,
    );
    assert.equal(
      delivered[0].extra.writeOpportunityReentries[0].scene.opportunity.scope.threadId,
      'thread_memory_operations',
    );
    assert.equal(delivered[0].extra.writeOpportunityReentries[0].scene.opportunity.consumer.catId, 'codex-terra');
    // re-entry must not reprint transcript payload
    assert.equal(content.includes('private transcript body'), false);

    const released = [];
    const missingAuthoritySpec = createDeferredPersonMemoryDailyTaskSpec({
      receiptStore: {
        async listReady() {
          return [receipt];
        },
        async get() {
          return receipt;
        },
        async claim(input) {
          return {
            outcome: 'claimed',
            receipt: {
              ...receipt,
              state: 'claimed',
              claimId: input.claimId,
              claimUntil: input.now + input.leaseMs,
              processorCatId: input.processorCatId,
              processingThreadId: input.processingThreadId,
            },
          };
        },
        async bindProcessingMessage(input) {
          return { outcome: 'bound', receipt: { receiptId: input.receiptId } };
        },
        async release(...args) {
          released.push(args);
          return true;
        },
        async hardForget() {
          return { outcome: 'purged' };
        },
      },
      ensureSystemThread: async () => 'thread_memory_operations',
      routingDispatchPreflight: {
        async preflight(input) {
          return {
            v: 1,
            ownerId: input.ownerId,
            observedAt: 1_000,
            resolverState: 'fresh',
            targets: [{ targetCatId: input.targetCatIds[0], disposition: 'allowed', reasons: [], alternatives: [] }],
          };
        },
      },
      messageStore,
      ownerUserId: 'owner-1',
      now: () => 1_000,
      randomId: () => 'claim-without-authority',
    });
    const missingAuthority = await missingAuthoritySpec.admission.gate({});
    assert.equal(missingAuthority.run, true);
    await missingAuthoritySpec.run.execute(
      missingAuthority.workItems[0].signal,
      missingAuthority.workItems[0].subjectKey,
      {
        assignedCatId: 'codex-terra',
        deliver: async () => {
          throw new Error('must not deliver without re-entry authority');
        },
        invokeTrigger: { async trigger() {} },
      },
    );
    assert.deepEqual(released, [['owner-1', receipt.receiptId, 'claim-without-authority', 1_000]]);
  });
});
