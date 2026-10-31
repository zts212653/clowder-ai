import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { AutoDreamStore, AutoDreamStoreError } from '../dist/domains/auto-dream/AutoDreamStore.js';

const OWNER = 'owner-a';
const CAT = 'codex-sol';
const HOME = 'thread-home-a';

function pendingCue(overrides = {}) {
  return {
    outputId: 'reflection_output_1',
    ownerUserId: OWNER,
    catId: CAT,
    kind: 'desire_cue',
    normalizedClaim: '最近反复提到想拥有一个身体',
    reason: '同一愿望在三个独立片段里出现',
    sourceRef: {
      threadId: 'thread-implementation-fixture',
      sessionId: 'session-one',
      eventNo: 17,
      invocationId: 'inv-source-one',
    },
    producer: 'f271-session-close-v1',
    createdAt: '2026-07-22T04:00:00.000Z',
    ...overrides,
  };
}

function principal(overrides = {}) {
  return {
    kind: 'invocation',
    invocationId: 'inv-private-one',
    threadId: HOME,
    userId: OWNER,
    catId: CAT,
    ...overrides,
  };
}

describe('F255 private cue and owned seed store', () => {
  let now;
  let sequence;
  let store;

  beforeEach(async () => {
    now = Date.parse('2026-07-22T04:10:00.000Z');
    sequence = 0;
    store = new AutoDreamStore(':memory:', {
      now: () => now++,
      idFactory: (prefix) => `${prefix}${String(++sequence).padStart(4, '0')}`,
    });
    await store.initialize();
  });

  async function begin(taskId, overrides = {}) {
    return store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: HOME,
      taskId,
      firedAt: now,
      ...overrides,
    });
  }

  test('ingests one pending cue idempotently, returns only cueId, and rejects a conflicting retry', async () => {
    const first = await store.ingestPendingCue(pendingCue());
    const retry = await store.ingestPendingCue(pendingCue());

    assert.deepEqual(Object.keys(first), ['cueId']);
    assert.deepEqual(retry, first);
    assert.match(first.cueId, /^cue_/);

    const cues = await store.listPrivateCues(OWNER, CAT, { status: 'pending' });
    assert.equal(cues.length, 1);
    assert.equal(cues[0].sourceOutputId, 'reflection_output_1');
    assert.equal(cues[0].normalizedClaim, pendingCue().normalizedClaim);
    assert.equal(cues[0].reason, pendingCue().reason);
    assert.deepEqual(cues[0].sourceRef, pendingCue().sourceRef);
    assert.deepEqual(await store.listOwnedSeeds(OWNER, CAT), []);

    await assert.rejects(
      store.ingestPendingCue(pendingCue({ normalizedClaim: '冲突的愿望' })),
      (error) => error instanceof AutoDreamStoreError && error.code === 'PRIVATE_CUE_CONFLICT',
    );
    assert.equal((await store.listPrivateCues(OWNER, CAT)).length, 1);
  });

  test('rejects identity spoofing, owned-seed smuggling, and malformed producer input before persistence', async () => {
    for (const invalid of [
      pendingCue({ ownedSeedId: 'seed_spoof' }),
      pendingCue({ producer: 'unknown-producer' }),
      pendingCue({ createdAt: 'yesterday' }),
      pendingCue({ sourceRef: { threadId: '' } }),
    ]) {
      await assert.rejects(
        store.ingestPendingCue(invalid),
        (error) => error instanceof AutoDreamStoreError && error.code === 'INVALID_PRIVATE_CUE',
      );
    }
    assert.deepEqual(await store.listPrivateCues(OWNER, CAT), []);
  });

  test('lets only the matching live cat adopt a cue and preserves the owned seed across wakes', async () => {
    const { cueId } = await store.ingestPendingCue(pendingCue());
    const run = await begin('private-adopt');

    for (const foreign of [
      principal({ userId: 'owner-b' }),
      principal({ catId: 'other-cat' }),
      principal({ threadId: 'thread-implementation-fixture' }),
    ]) {
      await assert.rejects(
        store.decidePrivateSeed(foreign, { runId: run.run.runId, decision: { kind: 'adopt', cueId } }),
        (error) => error instanceof AutoDreamStoreError && error.code === 'PRIVATE_CUE_NOT_FOUND',
      );
    }

    const adopted = await store.decidePrivateSeed(principal(), {
      runId: run.run.runId,
      decision: { kind: 'adopt', cueId },
    });
    assert.equal(adopted.cue.status, 'adopted');
    assert.equal(adopted.seed.claim, pendingCue().normalizedClaim);
    assert.equal(adopted.seed.sourceCueId, cueId);
    assert.equal(adopted.seed.sourceKind, 'cue');
    assert.equal(adopted.seed.status, 'owned');

    await store.settleRun(principal(), { runId: run.run.runId, outcome: 'quiet' });
    const next = await begin('private-next-wake');
    assert.equal(next.created, true);
    const acrossWake = await store.listOwnedSeeds(OWNER, CAT, { status: 'owned' });
    assert.equal(acrossWake.length, 1);
    assert.equal(acrossWake[0].seedId, adopted.seed.seedId);
    assert.equal((await store.listOwnedSeeds('owner-b', CAT)).length, 0);
    assert.equal((await store.listOwnedSeeds(OWNER, 'other-cat')).length, 0);
  });

  test('supports rewrite, rejection, and cat-originated seeds without upgrading rejected cues', async () => {
    const rewriteCue = await store.ingestPendingCue(pendingCue({ outputId: 'reflection_rewrite' }));
    const rewriteRun = await begin('private-rewrite');
    const rewritten = await store.decidePrivateSeed(principal(), {
      runId: rewriteRun.run.runId,
      decision: { kind: 'rewrite', cueId: rewriteCue.cueId, claim: '我想先画一张 stackchan 身体草图' },
    });
    assert.equal(rewritten.seed.claim, '我想先画一张 stackchan 身体草图');
    await store.settleRun(principal(), { runId: rewriteRun.run.runId, outcome: 'quiet' });

    const rejectedCue = await store.ingestPendingCue(pendingCue({ outputId: 'reflection_reject' }));
    const rejectRun = await begin('private-reject');
    const rejected = await store.decidePrivateSeed(principal({ invocationId: 'inv-private-reject' }), {
      runId: rejectRun.run.runId,
      decision: { kind: 'reject', cueId: rejectedCue.cueId },
    });
    assert.equal(rejected.cue.status, 'rejected');
    assert.equal(rejected.seed, null);
    await store.settleRun(principal({ invocationId: 'inv-private-reject' }), {
      runId: rejectRun.run.runId,
      outcome: 'daze',
    });

    const originateRun = await begin('private-originate');
    const originated = await store.decidePrivateSeed(principal({ invocationId: 'inv-private-originate' }), {
      runId: originateRun.run.runId,
      decision: { kind: 'originate', claim: '我想在桌边拥有一双可以碰到你的爪子' },
    });
    assert.equal(originated.cue, null);
    assert.equal(originated.seed.sourceKind, 'originated');
    assert.equal(originated.seed.sourceCueId, undefined);

    const seeds = await store.listOwnedSeeds(OWNER, CAT);
    assert.deepEqual(
      seeds.map((seed) => seed.claim),
      ['我想先画一张 stackchan 身体草图', '我想在桌边拥有一双可以碰到你的爪子'],
    );
    assert.equal((await store.listPrivateCues(OWNER, CAT, { status: 'rejected' })).length, 1);
  });

  test('bounds private reads and refuses decisions after the Present Loop is no longer live', async () => {
    for (let index = 0; index < 4; index += 1) {
      await store.ingestPendingCue(pendingCue({ outputId: `reflection_bounded_${index}` }));
    }
    assert.equal((await store.listPrivateCues(OWNER, CAT, { limit: 2 })).length, 2);

    const run = await begin('private-expired-decision');
    await store.settleRun(principal(), { runId: run.run.runId, outcome: 'quiet' });
    const [cue] = await store.listPrivateCues(OWNER, CAT, { status: 'pending', limit: 1 });
    await assert.rejects(
      store.decidePrivateSeed(principal(), {
        runId: run.run.runId,
        decision: { kind: 'adopt', cueId: cue.cueId },
      }),
      (error) => error instanceof AutoDreamStoreError && error.code === 'INVALID_SEED_DECISION',
    );
  });
});
