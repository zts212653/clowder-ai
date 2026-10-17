import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { ActionSuccessorKeys } from '../dist/domains/ball-custody/action-successor-keys.js';
import { RedisActionSuccessorLeaseStore } from '../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js';
import { digest, fixture } from './helpers/custody-host-fixture.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const evidence = 'github:https://github.com/owner/repo/pull/42#pullrequestreview-1';
const replacementEvidence = 'github:https://github.com/owner/repo/pull/42#pullrequestreview-2';
const redisUrl = process.env.REDIS_URL;

async function redisFixture(t) {
  assertRedisIsolationOrThrow(redisUrl, 'F202 native custody Redis composition');
  assert.ok(redisUrl);
  const keyPrefix = `f202-custody-${randomUUID()}:`;
  const redis = createRedisClient({ url: redisUrl, keyPrefix });
  const peer = createRedisClient({ url: redisUrl, keyPrefix });
  t.after(async () => {
    await Promise.all([redis.quit(), peer.quit()]);
  });
  await Promise.all([redis.ping(), peer.ping()]);
  const store = new RedisActionSuccessorLeaseStore(redis);
  const independentlyLoaded = new RedisActionSuccessorLeaseStore(peer);
  const f = await fixture(t, { persistentStore: store });
  return { ...f, redis, store, independentlyLoaded };
}

describe('native custody with actual isolated Redis CAS', { skip: redisIsolationSkipReason(redisUrl) }, () => {
  test('real module completes a persisted bound lease and replay still requires live authorization', async (t) => {
    const f = await redisFixture(t);
    const fence = await f.claim();
    const original = await f.independentlyLoaded.get(fence.leaseId);
    assert.ok(original.terminalPredicateProviderBinding);
    assert.deepEqual((await f.call('preflight', { ...fence, terminalPredicateDigest: digest })).result, {
      ok: true,
      reason: 'active',
    });
    const input = { ...fence, evidenceRefs: [evidence] };
    assert.deepEqual((await f.call('complete', input)).result, { outcome: 'committed', ...fence });
    const completed = await f.independentlyLoaded.get(fence.leaseId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.holderOutcomes.reviewer.outcome, 'succeeded');
    assert.deepEqual(completed.terminalPredicateProviderBinding, original.terminalPredicateProviderBinding);
    assert.equal(await f.redis.ttl(ActionSuccessorKeys.detail(fence.leaseId)), -1);
    assert.equal(await f.redis.ttl(ActionSuccessorKeys.identity(completed)), -1);
    assert.equal((await f.call('complete', input)).result.outcome, 'committed');
    assert.equal(f.verifierCalls(), 1);
    await f.revoke();
    await assert.rejects(() => f.call('complete', input), /no longer current|custody.invoke/);
    assert.deepEqual(await f.independentlyLoaded.get(fence.leaseId), completed);
  });

  test('revocation during verifier IO leaves the Redis candidate active without success', async (t) => {
    const f = await redisFixture(t);
    const fence = await f.claim();
    f.onVerify(() => f.revoke());
    await assert.rejects(() => f.call('complete', { ...fence, evidenceRefs: [evidence] }));
    const lease = await f.independentlyLoaded.get(fence.leaseId);
    assert.equal(lease.status, 'active');
    assert.deepEqual(lease.completionCandidates.reviewer.evidenceRefs, [evidence]);
    assert.equal(lease.holderOutcomes.reviewer, undefined);
    assert.equal(f.verifierCalls(), 1);
  });

  test('independent Redis candidate expansion fences the old verdict, then reverified evidence can complete', async (t) => {
    const f = await redisFixture(t);
    const fence = await f.claim();
    let firstCandidate;
    f.onVerify(async (input) => {
      assert.deepEqual(input.evidenceRefs, [evidence]);
      firstCandidate = (await f.independentlyLoaded.get(fence.leaseId)).completionCandidates.reviewer;
      const replaced = await f.independentlyLoaded.recordCompletionCandidate(fence.leaseId, {
        generation: fence.generation,
        catId: 'reviewer',
        evidenceRefs: [replacementEvidence],
        now: Date.now(),
      });
      assert.equal(replaced.outcome, 'recorded');
    });
    assert.deepEqual((await f.call('complete', { ...fence, evidenceRefs: [evidence] })).result, {
      outcome: 'stale',
      reason: 'candidate_changed',
    });
    const raced = await f.independentlyLoaded.get(fence.leaseId);
    assert.equal(raced.status, 'active');
    const expandedRefs = [evidence, replacementEvidence];
    assert.deepEqual(raced.completionCandidates.reviewer.evidenceRefs, expandedRefs);
    assert.equal(raced.completionCandidates.reviewer.candidateRevision, firstCandidate.candidateRevision + 1);
    assert.notEqual(raced.completionCandidates.reviewer.evidenceDigest, firstCandidate.evidenceDigest);
    assert.equal(raced.holderOutcomes.reviewer, undefined);
    f.onVerify(async (input) => {
      assert.deepEqual(input.evidenceRefs, expandedRefs);
    });
    assert.equal(
      (await f.call('complete', { ...fence, evidenceRefs: [replacementEvidence] })).result.outcome,
      'committed',
    );
    const completed = await f.independentlyLoaded.get(fence.leaseId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.completionCandidates.reviewer, undefined);
    assert.equal(completed.holderOutcomes.reviewer.outcome, 'succeeded');
    assert.equal(completed.holderOutcomes.reviewer.evidenceRef, evidence);
    assert.ok(expandedRefs.every((ref) => completed.evidenceRefs.includes(ref)));
    assert.equal(f.verifierCalls(), 2);
  });
});
