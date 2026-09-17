import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ownedSeedSourceRevision } from '../../dist/domains/auto-dream/private-seed-contract.js';
import { readTrustedConnectorMemoryCueSeeds } from '../../dist/domains/memory/cue/MemoryCueTrustedConnector.js';
import { CatOwnedSeedCueResolver } from '../../dist/domains/memory/cue/resolvers/CatOwnedSeedCueResolver.js';
import { CatOwnedSeedMemoryCueSource } from '../../dist/domains/memory/cue/sources/CatOwnedSeedMemoryCueSource.js';

const OWNER = 'owner-1';
const CAT = 'codex-sol';
const SCOPE = { ownerUserId: OWNER, threadId: 'thread-private-time', invocationId: 'invocation-1' };

function seed(overrides = {}) {
  return {
    seedId: 'seed_1',
    ownerUserId: OWNER,
    catId: CAT,
    sourceKind: 'originated',
    claim: '窗边那个秘密愿望',
    status: 'owned',
    sourceRunId: 'dreamrun_source',
    createdByInvocationId: 'invocation-source',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function opportunity(record = seed()) {
  return {
    v: 1,
    kind: 'owned_seed_available',
    opportunityId: 'opportunity-seed-1',
    producer: 'present_loop',
    consumer: 'agent_route',
    scope: SCOPE,
    occurredAt: 2_000,
    payload: {
      runId: 'dreamrun_current',
      producingCatId: CAT,
      seedId: record.seedId,
      sourceRevision: ownedSeedSourceRevision(record),
      sourceMessageId: 'message-present-loop',
    },
  };
}

describe('F312 Phase E cat-owned Seed Standing Reflex', () => {
  it('resolves one content-free cue only for the producing cat and drills the exact private revision', async () => {
    let current = seed();
    const source = new CatOwnedSeedMemoryCueSource({
      getOwnedSeed: async (ownerUserId, catId, seedId) =>
        current.ownerUserId === ownerUserId && current.catId === catId && current.seedId === seedId ? current : null,
    });
    const resolver = new CatOwnedSeedCueResolver(source);
    const candidate = opportunity(current);
    const handles = [];
    const cues = await resolver.resolve(candidate, {
      now: 2_001,
      expiresAt: 302_000,
      consumerCatId: CAT,
      createDrillHandle(coordinate) {
        handles.push(coordinate);
        return 'opaque-seed-handle';
      },
    });

    assert.equal(cues.length, 1);
    assert.equal(cues[0].resolverFamily, 'cat_owned_seed');
    assert.equal(cues[0].drill.family, 'owned_seed');
    assert.equal(JSON.stringify(cues).includes(current.claim), false);
    assert.equal(handles[0].consumerCatId, CAT);
    assert.deepEqual(
      await source.read({
        ownerUserId: OWNER,
        consumerCatId: CAT,
        anchor: cues[0].source.anchor,
        expectedRevision: cues[0].source.revision,
      }),
      {
        status: 'ok',
        payload: {
          seedId: current.seedId,
          claim: current.claim,
          sourceKind: current.sourceKind,
          sourceRunId: current.sourceRunId,
          sourceRevision: ownedSeedSourceRevision(current),
          authority: 'producing_cat_private_hypothesis',
          allowedUse: 'present_loop_private_intent_or_silence',
        },
      },
    );

    assert.deepEqual(
      await resolver.resolve(candidate, {
        now: 2_001,
        expiresAt: 302_000,
        consumerCatId: 'codex-terra',
        createDrillHandle: () => 'must-not-be-issued',
      }),
      [],
    );
    assert.deepEqual(
      await source.read({
        ownerUserId: OWNER,
        consumerCatId: 'codex-terra',
        anchor: cues[0].source.anchor,
        expectedRevision: cues[0].source.revision,
      }),
      { status: 'not_available', invalidationReason: 'scope_revoked' },
    );
  });

  it('invalidates correction drift and dormant supersession instead of serving stale claims', async () => {
    let current = seed();
    const originalRevision = ownedSeedSourceRevision(current);
    const source = new CatOwnedSeedMemoryCueSource({
      getOwnedSeed: async () => current,
    });

    current = { ...current, claim: '修订后的私有假设', updatedAt: 2_000 };
    assert.deepEqual(
      await source.read({
        ownerUserId: OWNER,
        consumerCatId: CAT,
        anchor: `owned-seed:${CAT}:${current.seedId}`,
        expectedRevision: originalRevision,
      }),
      { status: 'not_available', invalidationReason: 'source_corrected' },
    );

    current = { ...current, status: 'dormant', dormantAt: 3_000, updatedAt: 3_000 };
    assert.deepEqual(
      await source.read({
        ownerUserId: OWNER,
        consumerCatId: CAT,
        anchor: `owned-seed:${CAT}:${current.seedId}`,
        expectedRevision: ownedSeedSourceRevision(current),
      }),
      { status: 'not_available', invalidationReason: 'superseded' },
    );
  });

  it('admits only the target cat server-scheduler carrier and keeps its body out of transport', async () => {
    const record = seed();
    const carrier = {
      v: 1,
      producer: 'present_loop',
      producerProvenance: 'server_scheduler',
      runId: 'dreamrun_current',
      producingCatId: CAT,
      seedId: record.seedId,
      sourceRevision: ownedSeedSourceRevision(record),
      occurredAt: 2_000,
    };
    const stored = {
      id: 'message-present-loop',
      threadId: SCOPE.threadId,
      userId: 'scheduler',
      catId: null,
      content: '[scheduler] privateContext=invocation-only',
      source: { connector: 'scheduler', label: '定时任务' },
      extra: { scheduler: { hiddenTrigger: true }, memoryCue: { catOwnedSeed: carrier } },
      timestamp: 2_000,
    };
    const input = {
      entrySource: 'connector',
      messageId: stored.id,
      expectedThreadId: stored.threadId,
      expectedUserId: stored.userId,
      expectedTargetCatIds: [CAT],
      messageStore: { getById: async () => stored },
    };

    assert.deepEqual(await readTrustedConnectorMemoryCueSeeds(input), [
      {
        kind: 'owned_seed_available',
        producer: 'present_loop',
        occurredAt: carrier.occurredAt,
        payload: {
          runId: carrier.runId,
          producingCatId: CAT,
          seedId: carrier.seedId,
          sourceRevision: carrier.sourceRevision,
          sourceMessageId: stored.id,
        },
      },
    ]);
    assert.equal(JSON.stringify(stored.extra).includes(record.claim), false);
    assert.deepEqual(await readTrustedConnectorMemoryCueSeeds({ ...input, expectedTargetCatIds: ['codex-terra'] }), []);
    assert.deepEqual(await readTrustedConnectorMemoryCueSeeds({ ...input, entrySource: 'agent' }), []);
  });
});
