import assert from 'node:assert/strict';
import { test } from 'node:test';
import { F128ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F128ApprovalAdapter.js';
import { F221ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F221ApprovalAdapter.js';
import { F225ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F225ApprovalAdapter.js';
import { F231ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F231ApprovalAdapter.js';
import { F276ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F276ApprovalAdapter.js';
import { RedisTasteProposalStore } from '../../src/domains/taste/stores/redis/RedisTasteProposalStore.js';

test('all capped approval adapters read the whole owner snapshot rather than a default source page', async () => {
  const rows = Array.from({ length: 125 }, (_, index) => ({
    proposalId: `proposal-${index}`,
    id: `proposal-${index}`,
    candidateId: `proposal-${index}`,
    ownerUserId: 'owner',
    userId: 'owner',
    createdBy: 'owner',
    sourceCatId: 'codex61-sol',
    catId: 'codex61-sol',
    requesterCatId: 'codex61-sol',
    sourceThreadId: 'source',
    threadId: 'source',
    createdAt: index + 1,
    status: 'pending',
    title: 'Thread',
    quote: 'Taste',
    dimension: 'code',
    rationale: 'Profile',
    signalProvenance: { kind: 'explicit_request' },
    note: { done: 'Session complete' },
    personDraft: { displayName: 'Person' },
    claimDrafts: [],
    remainingDraftIds: [],
  }));
  const read = (_owner: string, limit = 100) => rows.slice(0, limit);
  const cases = [
    new F128ApprovalAdapter({ listPending: read } as unknown as ConstructorParameters<typeof F128ApprovalAdapter>[0]),
    new F221ApprovalAdapter({ listActionable: read } as unknown as ConstructorParameters<
      typeof F221ApprovalAdapter
    >[0]),
    new F225ApprovalAdapter({ listPendingByUser: read } as unknown as ConstructorParameters<
      typeof F225ApprovalAdapter
    >[0]),
    new F231ApprovalAdapter({ listPending: read } as unknown as ConstructorParameters<typeof F231ApprovalAdapter>[0]),
    new F276ApprovalAdapter({
      listPending: async (owner, limit) => read(owner, limit),
    } as unknown as ConstructorParameters<typeof F276ApprovalAdapter>[0]),
  ];
  for (const adapter of cases) {
    const items = await adapter.listPending('owner');
    assert.equal(items.length, 125, adapter.featureId);
    assert.equal(new Set(items.map((item) => item.proposalId)).size, 125, adapter.featureId);
    assert(
      items.every((item) => item.ownerUserId === 'owner'),
      adapter.featureId,
    );
  }
});

test('Redis taste honors exhaustive adapter reads while bounded callers keep their default page', async () => {
  const ids = Array.from({ length: 125 }, (_, index) => `taste-${index}`);
  const redis = {
    async zrevrange(_key: string, start: number, stop: number) {
      return ids.slice(start, stop + 1);
    },
    pipeline() {
      const pending: string[] = [];
      return {
        hgetall(key: string) {
          pending.push(key);
          return this;
        },
        async exec() {
          return pending.map((key) => [
            null,
            {
              id: key.split(':').at(-1),
              userId: 'owner',
              catId: 'codex61-sol',
              threadId: 'source',
              quote: 'Taste',
              dimension: 'code',
              status: 'pending',
              createdAt: '1',
            },
          ]);
        },
      };
    },
  };
  const store = new RedisTasteProposalStore(
    redis as unknown as ConstructorParameters<typeof RedisTasteProposalStore>[0],
  );
  assert.equal((await store.listActionable('owner')).length, 100);
  assert.equal((await new F221ApprovalAdapter(store).listPending('owner')).length, 125);
});
