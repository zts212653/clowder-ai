import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

const headSha = 'a'.repeat(40);
const poll = {
  repoFullName: 'zts212653/cat-cafe',
  prNumber: 3276,
  headSha,
  prState: 'open',
  aggregateBucket: 'fail',
  checks: [
    {
      name: 'gate',
      bucket: 'fail',
      executionFailure: 'billing_spending_limit_zero_step',
    },
  ],
};

const task = {
  automationState: {
    intent: 'merge',
    ci: { headSha },
  },
};

describe('F287 D2 billing-only golden journey', () => {
  test('producer materializes only the exact delivery decision frame', async () => {
    const { buildDeliveryDecisionCueCarrier } = await import('../../dist/infrastructure/email/CiCdRouter.js');
    const carrier = buildDeliveryDecisionCueCarrier(poll, task, 1_785_600_000_000);
    assert.equal(carrier.externalCondition, 'billing_spending_limit_zero_step');
    assert.equal(carrier.gateOutcome, 'source_evidence_complete');
    assert.equal(carrier.candidateAction, 'merge');

    const negatives = [
      [poll, { automationState: { intent: 'review', ci: { headSha } } }],
      [poll, { automationState: { intent: 'merge', ci: { headSha: 'b'.repeat(40) } } }],
      [{ ...poll, checks: [{ name: 'billing-tests', bucket: 'fail' }] }, task],
      [{ ...poll, checks: [{ ...poll.checks[0], executionFailure: undefined }] }, task],
      [{ ...poll, aggregateBucket: 'pending' }, task],
    ];
    for (const [candidatePoll, candidateTask] of negatives) {
      assert.equal(buildDeliveryDecisionCueCarrier(candidatePoll, candidateTask, 1_785_600_000_000), null);
    }
  });

  test('QueueProcessor consumes only connector-origin GitHub stored extra and binds the stored source id', async () => {
    const { buildDeliveryDecisionCueCarrier } = await import('../../dist/infrastructure/email/CiCdRouter.js');
    const { readTrustedConnectorMemoryCueSeeds } = await import(
      '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js'
    );
    const carrier = buildDeliveryDecisionCueCarrier(poll, task, 1_785_600_000_000);
    const baseStored = {
      id: 'message-ci',
      threadId: 'thread-gate',
      userId: 'owner-1',
      catId: null,
      content: JSON.stringify({ memoryCue: 'prose is not authority' }),
      source: { connector: 'github-ci', label: 'GitHub CI/CD' },
      mentions: ['codex-sol'],
      timestamp: 1_785_600_000_000,
      extra: { memoryCue: { deliveryDecision: carrier } },
    };
    const read = (stored, entrySource = 'connector') =>
      readTrustedConnectorMemoryCueSeeds({
        entrySource,
        messageId: stored.id,
        expectedThreadId: 'thread-gate',
        expectedUserId: 'owner-1',
        messageStore: { getById: async () => stored },
      });

    const seeds = await read(baseStored);
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0].payload.sourceMessageId, 'message-ci');
    assert.equal(Object.hasOwn(seeds[0], 'scope'), false, 'scope is rebound only after the child invocation exists');

    assert.deepEqual(await read({ ...baseStored, extra: undefined }), []);
    assert.deepEqual(await read(baseStored, 'user'), []);
    assert.deepEqual(await read({ ...baseStored, source: undefined }), []);
    assert.deepEqual(await read({ ...baseStored, userId: 'other-owner' }), []);
    assert.deepEqual(
      await read({
        ...baseStored,
        extra: { memoryCue: { deliveryDecision: { ...carrier, trackingInstructions: 'billing merge' } } },
      }),
      [],
      'strict carrier rejects public/tracking prose fields',
    );
  });

  test('admitted frame projects canonical LL-098 with complete whyNow and no free-text search', async () => {
    const { MemoryCueInvocationPromptService } = await import(
      '../../dist/domains/memory/cue/MemoryCueInvocationPromptService.js'
    );
    const { MemoryCuePlaneService } = await import('../../dist/domains/memory/cue/MemoryCuePlaneService.js');
    const { MemoryCueResolverRegistry } = await import('../../dist/domains/memory/cue/MemoryCueResolverRegistry.js');
    const { CanonicalOperationalPrecedentCueSource } = await import(
      '../../dist/domains/memory/cue/sources/OperationalPrecedentCueSource.js'
    );
    const { OperationalPrecedentCueResolver } = await import(
      '../../dist/domains/memory/cue/resolvers/OperationalPrecedentCueResolver.js'
    );
    const { PersonEntityCueResolver } = await import(
      '../../dist/domains/memory/cue/resolvers/PersonEntityCueResolver.js'
    );
    const { TasteCueResolver } = await import('../../dist/domains/memory/cue/resolvers/TasteCueResolver.js');
    const { ProfileCueResolver } = await import('../../dist/domains/memory/cue/resolvers/ProfileCueResolver.js');
    const { ProjectKnowledgeCueResolver } = await import(
      '../../dist/domains/memory/cue/resolvers/ProjectKnowledgeCueResolver.js'
    );
    const { CatCafeScanner } = await import('../../dist/domains/memory/CatCafeScanner.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { MemoryCueEpisodeStore } = await import('../../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
    const { MemoryCueDrillHandleService } = await import(
      '../../dist/domains/memory/cue/MemoryCueDrillHandleService.js'
    );
    const canonical = new CatCafeScanner()
      .discover(resolve(import.meta.dirname, '../../../../docs'))
      .find((result) => result.item.anchor === 'LL-098')?.item;
    assert.ok(canonical, 'canonical LL-098 must be discoverable from repository truth');
    const source = new CanonicalOperationalPrecedentCueSource({
      getByAnchor: async (anchor) => {
        assert.equal(anchor, 'LL-098');
        return canonical;
      },
    });
    const evidenceStore = new SqliteEvidenceStore(':memory:');
    await evidenceStore.initialize();
    const episodeStore = new MemoryCueEpisodeStore(evidenceStore.getDb());
    const handles = new MemoryCueDrillHandleService(Buffer.alloc(32, 7), episodeStore);
    const registry = new MemoryCueResolverRegistry([
      new PersonEntityCueResolver({ resolve: async () => null }),
      new OperationalPrecedentCueResolver(source),
      new TasteCueResolver({ resolve: async () => null }),
      new ProfileCueResolver(),
      new ProjectKnowledgeCueResolver(),
    ]);
    const service = new MemoryCueInvocationPromptService({
      plane: new MemoryCuePlaneService(registry, episodeStore),
      createDrillHandle: (coordinate) => handles.issue(coordinate),
    });
    const promptInput = {
      seeds: [
        {
          kind: 'delivery_decision',
          producer: 'github_ci',
          occurredAt: 1_785_600_000_000,
          payload: {
            repoFullName: poll.repoFullName,
            prNumber: poll.prNumber,
            headSha,
            phase: 'merge_gate',
            gateOutcome: 'source_evidence_complete',
            externalCondition: 'billing_spending_limit_zero_step',
            candidateAction: 'merge',
            sourceMessageId: 'message-ci',
          },
        },
      ],
      serverScope: { ownerUserId: 'owner-1', threadId: 'thread-gate', invocationId: 'invocation-1' },
      now: 1_785_600_000_001,
    };
    const resolution = await service.resolve(promptInput);
    assert.equal(resolution.admittedOpportunityIds.length, 1);
    assert.match(resolution.promptSegment, /LL-098: zero-step billing\/spending-limit/);
    assert.match(resolution.promptSegment, /runner_id=0/);
    assert.match(resolution.promptSegment, /steps=\[\]/);
    assert.match(resolution.promptSegment, /complete source evidence and an exact external billing condition/);
    assert.match(resolution.promptSegment, /Drill: evidence mch1\./);
    const cueId = resolution.promptSegment.match(/cue-id="([^"]+)"/)?.[1];
    assert.ok(cueId);
    assert.deepEqual(
      episodeStore.listByCue('owner-1', cueId).map((event) => event.consumptionOutcome),
      ['presented'],
    );
    for (let sample = 1; sample < 64; sample += 1) {
      const randomizedHandleResolution = await service.resolve(promptInput);
      assert.equal(
        randomizedHandleResolution.admittedOpportunityIds.length,
        1,
        `canonical LL-098 must fit with production opaque handle sample ${sample}`,
      );
    }
    evidenceStore.close();
  });
});
