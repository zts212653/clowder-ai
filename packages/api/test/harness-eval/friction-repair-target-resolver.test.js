import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFrictionRepairTargetResolver } from '../../dist/infrastructure/harness-eval/friction/friction-repair-target-resolver.js';
import { resolveFeatureOwnerCatId } from '../../dist/routes/feature-thread-resolver.js';

const logger = { warn() {} };

function stores(threadIds = ['thread_f188']) {
  return {
    threadStore: {
      async list() {
        return threadIds.map((id, index) => ({ id, backlogItemId: `backlog-${index}` }));
      },
    },
    backlogStore: {
      async get(id) {
        return id.startsWith('backlog-') ? { tags: ['feature:f188'] } : null;
      },
    },
  };
}

function resolver({ threadIds, entries } = {}) {
  const deps = stores(threadIds);
  return createFrictionRepairTargetResolver({
    ...deps,
    logger,
    featureIndexProvider: async () =>
      entries ?? [
        {
          featId: 'F188',
          name: 'Evidence Memory',
          status: 'doing',
          owner: '小太阳·砚砚（@codex-sol, GPT-5.6 Sol）',
        },
      ],
  });
}

const input = {
  userId: 'user-1',
  hint: { featureId: 'F188', componentId: 'evidence-reader' },
  resolvedAt: '2026-08-29T03:09:18.499Z',
};

describe('canonical friction repair target resolver', () => {
  it('characterizes the existing feature owner parser without accepting multi-owner ambiguity', () => {
    assert.equal(resolveFeatureOwnerCatId('小太阳·砚砚（@codex-sol, GPT-5.6 Sol）'), 'codex-sol');
    assert.equal(resolveFeatureOwnerCatId('@codex-sol / GPT-5.6 Sol'), 'codex-sol');
    assert.equal(resolveFeatureOwnerCatId('@codex-sol + @opus-47'), undefined);
  });

  it('derives owner, resolution ref, resolvedAt and version from canonical feature/thread truth', async () => {
    const targetResolver = resolver();
    const first = await targetResolver.resolve(input);
    const replay = await targetResolver.resolve(input);
    assert.equal(first.status, 'resolved');
    assert.deepEqual(first, replay);
    assert.equal(first.target.featureId, 'F188');
    assert.equal(first.target.componentId, 'evidence-reader');
    assert.equal(first.target.ownerCatId, 'codex-sol');
    assert.equal(first.target.resolvedAt, input.resolvedAt);
    assert.equal(first.target.resolutionRef, 'feature-thread-owner:v1:F188:thread_f188:codex-sol');
    assert.match(first.target.version, /^repair-target-v1-[a-f0-9]{64}$/);
  });

  it('fails closed for missing, ambiguous, and internal owner mismatch truth', async () => {
    const missing = await resolver({ entries: [] }).resolve(input);
    assert.deepEqual(missing, {
      status: 'blocked',
      reason: 'owner_unresolved',
      evidenceRef: 'feature-index:F188:not-found',
    });

    const ambiguousThread = await resolver({ threadIds: ['thread_f188_a', 'thread_f188_b'] }).resolve(input);
    assert.equal(ambiguousThread.status, 'blocked');
    assert.equal(ambiguousThread.reason, 'owner_ambiguous');
    assert.match(ambiguousThread.evidenceRef, /thread_f188_a,thread_f188_b/);

    const ambiguousOwner = await resolver({
      entries: [{ featId: 'F188', name: 'x', status: 'doing', owner: '@codex-sol + @opus-47' }],
    }).resolve(input);
    assert.equal(ambiguousOwner.status, 'blocked');
    assert.equal(ambiguousOwner.reason, 'owner_ambiguous');

    const mismatch = await resolver().resolve({ ...input, expectedOwnerCatId: 'opus-47' });
    assert.equal(mismatch.status, 'blocked');
    assert.equal(mismatch.reason, 'target_mismatch');
  });

  it('detects target version drift by re-running the same canonical resolver', async () => {
    let owner = '@codex-sol';
    const deps = stores();
    const targetResolver = createFrictionRepairTargetResolver({
      ...deps,
      logger,
      featureIndexProvider: async () => [{ featId: 'F188', name: 'x', status: 'doing', owner }],
    });
    const initial = await targetResolver.resolve(input);
    assert.equal(initial.status, 'resolved');
    owner = '@opus-47';
    const stale = await targetResolver.revalidate({
      userId: input.userId,
      target: initial.target,
      resolvedAt: '2026-08-30T03:09:18.499Z',
    });
    assert.equal(stale.status, 'blocked');
    assert.equal(stale.reason, 'target_mismatch');
    assert.match(stale.evidenceRef, /stale-target/);
  });
});
