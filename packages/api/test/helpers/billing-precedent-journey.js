import assert from 'node:assert/strict';

export async function assertBillingPrecedentJourney({ docsRoot, repoFullName, expectedSourceText }) {
  assert.ok(expectedSourceText, 'the caller must supply a nonempty independent source expectation');
  const headSha = 'a'.repeat(40);
  const poll = {
    repoFullName,
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
  const { EventCueResolver } = await import('../../dist/domains/memory/cue/resolvers/EventCueResolver.js');
  const { DecisionCueResolver } = await import('../../dist/domains/memory/cue/resolvers/DecisionCueResolver.js');
  const { CatOwnedSeedCueResolver } = await import(
    '../../dist/domains/memory/cue/resolvers/CatOwnedSeedCueResolver.js'
  );
  const { ProjectKnowledgeCueResolver } = await import(
    '../../dist/domains/memory/cue/resolvers/ProjectKnowledgeCueResolver.js'
  );
  const { CatCafeScanner } = await import('../../dist/domains/memory/CatCafeScanner.js');
  const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
  const { MemoryCueEpisodeStore } = await import('../../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
  const { MemoryCueDrillHandleService } = await import('../../dist/domains/memory/cue/MemoryCueDrillHandleService.js');
  const canonical = new CatCafeScanner().discover(docsRoot).find((result) => result.item.anchor === 'LL-098')?.item;
  assert.ok(canonical, 'the real scanner must discover the supplied LL-098 source');
  assert.equal(canonical.summary.length, 300);
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
    new PersonEntityCueResolver({ resolve: async () => null }, { isCurrentVisibleRevision: () => false }),
    new OperationalPrecedentCueResolver(source),
    new TasteCueResolver({ resolve: async () => null }),
    new ProfileCueResolver(),
    new EventCueResolver({ resolve: async () => null }),
    new DecisionCueResolver({ resolve: async () => null }),
    new ProjectKnowledgeCueResolver({ resolve: async () => null }),
    new CatOwnedSeedCueResolver({ resolve: async () => null }),
    { family: 'thread_overview', resolverVersion: 1, resolve: async () => [] },
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
    consumerCatId: 'codex-sol',
  };
  const resolution = await service.resolve(promptInput);
  assert.equal(resolution.admittedOpportunityIds.length, 1);
  assert.doesNotMatch(resolution.promptSegment, /LL-098|runner_id|steps=|why-now/);
  assert.ok(!resolution.promptSegment.includes(expectedSourceText), 'the pointer must not preload source policy');
  assert.match(resolution.promptSegment, /^Family: evidence$/m);
  const handle = resolution.promptSegment.match(/^Handle: (mch1\.[^\s]+)$/m)?.[1];
  assert.ok(handle, 'the pointer must expose a bare, directly copyable opaque handle');
  assert.match(resolution.promptSegment, /cat_cafe_drill_memory_cue\(handle=Handle\)/);
  assert.match(resolution.promptSegment, /cat_cafe_record_memory_cue_outcome\(handle=Handle,/);
  const receipt = resolution.deliveryReceipts[0];
  const cueId = receipt?.cueId;
  assert.ok(cueId);
  assert.equal(resolution.deliveryReceipts.length, 1);
  const original = await source.read({
    anchor: receipt.event.sourceAnchor,
    expectedRevision: receipt.event.sourceRevision,
  });
  assert.equal(original.status, 'ok');
  assert.ok(original.payload.summary.includes(expectedSourceText), 'the original read preserves the supplied policy');
  assert.deepEqual(
    episodeStore.listByCue('owner-1', cueId).map((event) => event.consumptionOutcome),
    [],
    'rendering a cue must not claim that the provider received it',
  );
  await service.recordPresented(resolution.deliveryReceipts, {
    generationId: 'sha256:final-provider-prompt',
    evidenceRef: 'context-delivery:invocation-1:sha256:final-provider-prompt',
  });
  assert.deepEqual(
    episodeStore.listByCue('owner-1', cueId).map((event) => event.consumptionOutcome),
    ['presented'],
    'the receipt becomes durable only after an explicit provider-delivery confirmation',
  );
  const verifiedHandle = handles.verify(handle, promptInput.serverScope, promptInput.now, 'codex-sol');
  assert.equal(verifiedHandle.ok, true, 'the complete displayed Handle value verifies after delivery');
  assert.equal(verifiedHandle.coordinate.revision, receipt.event.sourceRevision);
  for (let sample = 1; sample < 64; sample += 1) {
    const randomizedHandleResolution = await service.resolve(promptInput);
    assert.equal(
      randomizedHandleResolution.admittedOpportunityIds.length,
      1,
      `canonical LL-098 must fit with production opaque handle sample ${sample}`,
    );
  }
  evidenceStore.close();
}
