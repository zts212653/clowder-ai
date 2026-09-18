import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyCleanupPlan, buildCleanupPlan, cleanupPlanDigest, parseArgs } from './f257-s0-clean-derived-state.mjs';

function globRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${escaped}$`);
}

function fakeRedis({ strings = {}, zsets = {} } = {}) {
  const values = new Map(Object.entries(strings));
  const sortedSets = new Map(Object.entries(zsets).map(([key, members]) => [key, new Set(members)]));

  return {
    values,
    sortedSets,
    async scan(_cursor, _matchToken, pattern) {
      const match = globRegex(pattern);
      const keys = [...new Set([...values.keys(), ...sortedSets.keys()])].filter((key) => match.test(key));
      return ['0', keys];
    },
    async get(key) {
      return values.get(key) ?? null;
    },
    async exists(key) {
      return values.has(key) || sortedSets.has(key) ? 1 : 0;
    },
    async zscore(key, member) {
      return sortedSets.get(key)?.has(member) ? '1' : null;
    },
    multi() {
      const operations = [];
      return {
        unlink(key) {
          operations.push(() => values.delete(key));
          return this;
        },
        zrem(key, member) {
          operations.push(() => sortedSets.get(key)?.delete(member));
          return this;
        },
        async exec() {
          return operations.map((operation) => [null, operation() ? 1 : 0]);
        },
      };
    },
  };
}

describe('F257 S0 derived-state cleanup plan', () => {
  it('requires an explicit Redis target and digest-bound apply', () => {
    assert.throws(() => parseArgs(['--owner-user-id', 'default-user'], {}), /redis_url_required/);
    assert.throws(
      () =>
        parseArgs(['--owner-user-id', 'default-user', '--apply'], {
          REDIS_URL: 'redis://127.0.0.1:16499',
        }),
      /confirm_plan_required/,
    );
  });

  it('targets only open legacy state owned by the selected user', async () => {
    const prefix = 'cat-cafe:';
    const redis = fakeRedis({
      strings: {
        [`${prefix}harness-unit-run-pending:default-user:identity-truth`]: JSON.stringify({
          snapshotId: 'snapshot-pending',
          expectedWatermark: 7,
          snapshot: { ownerUserId: 'default-user', objectiveId: 'identity-truth' },
        }),
        [`${prefix}harness-evaluation-snapshot:snapshot-pending`]: '{"large":"payload"}',
        [`${prefix}harness-unit-semantic-result:snapshot-pending:metric-a`]: '{"result":true}',
        [`${prefix}harness-unit-semantic-job:unit-open`]: JSON.stringify({
          jobId: 'unit-open',
          ownerUserId: 'default-user',
        }),
        [`${prefix}harness-unit-semantic-retrieval:unit-open:0`]: '{"cursor":0}',
        [`${prefix}harness-unit-semantic-job:unit-complete`]: JSON.stringify({
          jobId: 'unit-complete',
          ownerUserId: 'default-user',
        }),
        [`${prefix}harness-unit-semantic-completion:unit-complete`]: '{"completed":true}',
        [`${prefix}harness-unit-semantic-job:other-open`]: JSON.stringify({
          jobId: 'other-open',
          ownerUserId: 'another-user',
        }),
        [`${prefix}harness-semantic-sweep-job:sweep-open`]: JSON.stringify({
          jobId: 'sweep-open',
          ownerUserId: 'default-user',
        }),
        [`${prefix}harness-semantic-sweep-job:sweep-complete`]: JSON.stringify({
          jobId: 'sweep-complete',
          ownerUserId: 'default-user',
        }),
        [`${prefix}harness-semantic-sweep-completion:sweep-complete`]: '{"completed":true}',
        [`${prefix}harness-semantic-sweep-state:default-user`]: '{"generation":1899}',
      },
      zsets: {
        [`${prefix}harness-evaluation-snapshot-index:default-user:identity-truth`]: ['snapshot-pending'],
        [`${prefix}harness-semantic-sweep-retry-due`]: ['default-user'],
      },
    });

    const plan = await buildCleanupPlan(redis, { ownerUserId: 'default-user', keyPrefix: prefix });
    const keys = plan.unlinkKeys.map((entry) => entry.key);

    assert.deepEqual(plan.counts, {
      pendingRuns: 1,
      pendingSnapshots: 1,
      pendingSemanticResults: 1,
      unitJobs: 2,
      unitRetrievalReceipts: 1,
      unitCompletions: 1,
      openSweepJobs: 1,
      sweepDrainStates: 1,
      indexMembers: 2,
    });
    assert.ok(keys.includes(`${prefix}harness-unit-run-pending:default-user:identity-truth`));
    assert.ok(keys.includes(`${prefix}harness-evaluation-snapshot:snapshot-pending`));
    assert.ok(keys.includes(`${prefix}harness-unit-semantic-job:unit-open`));
    assert.ok(keys.includes(`${prefix}harness-unit-semantic-retrieval:unit-open:0`));
    assert.ok(keys.includes(`${prefix}harness-semantic-sweep-job:sweep-open`));
    assert.ok(keys.includes(`${prefix}harness-semantic-sweep-state:default-user`));
    assert.ok(keys.includes(`${prefix}harness-unit-semantic-job:unit-complete`));
    assert.ok(keys.includes(`${prefix}harness-unit-semantic-completion:unit-complete`));
    assert.ok(!keys.includes(`${prefix}harness-unit-semantic-job:other-open`));
    assert.ok(!keys.includes(`${prefix}harness-semantic-sweep-job:sweep-complete`));
    assert.equal(plan.zremMembers.length, 2);
  });

  it('fails closed when an owner-scoped pending record is malformed', async () => {
    const redis = fakeRedis({
      strings: {
        'cat-cafe:harness-unit-run-pending:default-user:identity-truth': '{not-json',
      },
    });

    await assert.rejects(
      buildCleanupPlan(redis, { ownerUserId: 'default-user', keyPrefix: 'cat-cafe:' }),
      /invalid_json:.*harness-unit-run-pending/,
    );
  });

  it('aborts apply when live state moved after the dry run, instead of orphaning the sibling record', async () => {
    const prefix = 'cat-cafe:';
    const redis = fakeRedis({
      strings: {
        [`${prefix}harness-semantic-sweep-job:sweep-open`]: JSON.stringify({
          jobId: 'sweep-open',
          ownerUserId: 'default-user',
        }),
      },
    });
    const plan = await buildCleanupPlan(redis, { ownerUserId: 'default-user', keyPrefix: prefix });
    const digest = cleanupPlanDigest(plan);
    assert.deepEqual(
      plan.unlinkKeys.map((entry) => entry.key),
      [`${prefix}harness-semantic-sweep-job:sweep-open`],
      'the dry run planned to unlink the open sweep job',
    );

    // The sweep finishes between the dry run and --apply. Its job record is no
    // longer open state, and unlinking it would strand the completion record.
    redis.values.set(`${prefix}harness-semantic-sweep-completion:sweep-open`, '{"completed":true}');

    await assert.rejects(applyCleanupPlan(redis, plan, digest), /cleanup_plan_state_changed/);
    assert.equal(
      redis.values.has(`${prefix}harness-semantic-sweep-job:sweep-open`),
      true,
      'the now-completed job record survives the aborted apply',
    );
    assert.equal(
      redis.values.has(`${prefix}harness-semantic-sweep-completion:sweep-open`),
      true,
      'no orphaned completion record is left behind',
    );
  });

  it('binds apply to the exact dry-run digest and leaves completed sweep records intact', async () => {
    const prefix = 'cat-cafe:';
    const redis = fakeRedis({
      strings: {
        [`${prefix}harness-semantic-sweep-job:sweep-open`]: JSON.stringify({
          jobId: 'sweep-open',
          ownerUserId: 'default-user',
        }),
        [`${prefix}harness-semantic-sweep-job:sweep-complete`]: JSON.stringify({
          jobId: 'sweep-complete',
          ownerUserId: 'default-user',
        }),
        [`${prefix}harness-semantic-sweep-completion:sweep-complete`]: '{"completed":true}',
      },
    });
    const options = { ownerUserId: 'default-user', keyPrefix: prefix };
    const plan = await buildCleanupPlan(redis, options);
    assert.notEqual(
      cleanupPlanDigest({ ...plan, targetFingerprint: 'target-a' }),
      cleanupPlanDigest({ ...plan, targetFingerprint: 'target-b' }),
    );

    await assert.rejects(applyCleanupPlan(redis, plan, 'wrong-digest'), /cleanup_plan_digest_mismatch/);
    await applyCleanupPlan(redis, plan, cleanupPlanDigest(plan));

    assert.equal(redis.values.has(`${prefix}harness-semantic-sweep-job:sweep-open`), false);
    assert.equal(redis.values.has(`${prefix}harness-semantic-sweep-job:sweep-complete`), true);
    assert.equal(redis.values.has(`${prefix}harness-semantic-sweep-completion:sweep-complete`), true);
  });
});
