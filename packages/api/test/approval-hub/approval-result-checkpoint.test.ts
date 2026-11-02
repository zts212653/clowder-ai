import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TasteProposal, ThreadProposal } from '@cat-cafe/shared';
import {
  ApprovalProducerRegistry,
  bindLegacyApprovalProducer,
} from '../../src/domains/approval-hub/ApprovalProducerRegistry.js';
import { F128ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F128ApprovalAdapter.js';
import { F221ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F221ApprovalAdapter.js';
import type { IProposalStore } from '../../src/domains/cats/services/stores/ports/ProposalStore.js';
import type { ITasteProposalStore } from '../../src/domains/taste/stores/ports/TasteProposalStore.js';

test('history preserves the producer finalized thread binding and taste write checkpoint instead of generic unknown', async () => {
  const thread = {
    proposalId: 'thread-proposal',
    createdBy: 'owner',
    sourceCatId: 'codex61-sol',
    sourceThreadId: 'source',
    parentThreadId: 'source',
    createdAt: 1,
    status: 'approved',
    title: 'Already created',
    reason: 'A discussion',
    preferredCats: [],
    projectPath: '/isolated',
    approvedAt: 2,
    approvedBy: 'owner',
    createdThreadId: 'actual-child',
  } as unknown as ThreadProposal;
  const taste = {
    id: 'taste-proposal',
    userId: 'owner',
    catId: 'codex61-sol',
    threadId: 'source',
    createdAt: 1,
    status: 'approved',
    approvedAt: 2,
    approvedBy: 'owner',
    scene: 'Work',
    quote: 'Actual source',
    dimension: 'style',
    tags: [],
    privacy: 'private',
    vignetteSlug: 'actual-entry',
    vignettePath: 'docs/taste/actual-entry.md',
  } as unknown as TasteProposal;
  const threads = { listSettledByUser: async () => [thread] } as unknown as IProposalStore;
  const tastes = { listSettledByUser: async () => [taste] } as unknown as ITasteProposalStore;
  const registry = new ApprovalProducerRegistry({
    F128: bindLegacyApprovalProducer(new F128ApprovalAdapter(threads)),
    F221: bindLegacyApprovalProducer(new F221ApprovalAdapter(tastes)),
  });
  const [created] = await registry.listSettledFor('F128', 'owner', 30);
  const [remembered] = await registry.listSettledFor('F221', 'owner', 30);
  assert.equal(created.detail.createdThreadId, 'actual-child');
  assert.equal(created.materialization.state, 'succeeded');
  assert.equal(remembered.materialization.state, 'succeeded');
  // An accepted decision alone never becomes a write receipt.
  delete taste.vignettePath;
  assert.equal((await registry.listSettledFor('F221', 'owner', 30))[0].materialization.state, 'outcome_unknown');
});
