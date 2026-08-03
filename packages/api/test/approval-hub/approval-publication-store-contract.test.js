import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryDispatchProposalStore } from '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js';
import { InMemoryEntityProposalStore } from '../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js';
import { InMemoryProfileUpdateProposalStore } from '../../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { InMemoryProposalStore } from '../../dist/domains/cats/services/stores/ports/ProposalStore.js';
import { InMemorySessionHandoffProposalStore } from '../../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js';
import { InMemoryTasteProposalStore } from '../../dist/domains/taste/stores/InMemoryTasteProposalStore.js';

const cases = [
  {
    name: 'F128',
    create() {
      const store = new InMemoryProposalStore();
      const proposal = store.create({
        proposalId: 'proposal-f128',
        sourceThreadId: 'thread-1',
        sourceInvocationId: 'invocation-1',
        sourceCatId: 'codex-sol',
        title: 'Child thread',
        reason: 'Long-running work',
        parentThreadId: 'thread-1',
        preferredCats: [],
        projectPath: '/workspace',
        createdBy: 'user-1',
      });
      return { store, proposal, producerId: 'F128', ownerUserId: proposal.createdBy };
    },
  },
  {
    name: 'F225',
    create() {
      const store = new InMemorySessionHandoffProposalStore();
      const proposal = store.create({
        proposalId: 'proposal-f225',
        sourceThreadId: 'thread-1',
        sourceSessionId: 'session-1',
        sourceCatId: 'codex-sol',
        userId: 'user-1',
        note: { done: 'done', nextSteps: 'continue' },
      });
      return { store, proposal, producerId: 'F225', ownerUserId: proposal.userId };
    },
  },
  {
    name: 'F231',
    create() {
      const store = new InMemoryProfileUpdateProposalStore();
      const proposal = store.create({
        proposalId: 'proposal-f231',
        sourceThreadId: 'thread-1',
        sourceInvocationId: 'invocation-1',
        sourceCatId: 'codex-sol',
        targetLayer: 'primer',
        targetPath: 'relationship/sol-primer.md',
        beforeContent: 'before',
        baseContentHash: 'hash',
        afterContent: 'after',
        rationale: 'operator instruction',
        signalProvenance: { kind: 'cvo-instructed', sourceThreadId: 'thread-1', sourceMessageId: 'origin-1' },
        createdBy: 'user-1',
      });
      return { store, proposal, producerId: 'F231', ownerUserId: proposal.createdBy };
    },
  },
  // ── Wave 2 producers (F246 Phase I AC-I8/I9/I10) ──
  {
    name: 'F193',
    async create() {
      const store = new InMemoryDispatchProposalStore();
      const { proposal } = await store.create({
        proposalId: 'proposal-f193',
        sourceThreadId: 'thread-1',
        targetThreadId: 'thread-2',
        senderCatId: 'codex-sol',
        ownerUserId: 'user-1',
        content: 'Fix the bug',
        targetCats: ['sonnet'],
        createdAt: Date.now(),
      });
      return {
        store,
        proposal: { ...proposal, proposalId: proposal.proposalId, sourceCatId: proposal.senderCatId },
        producerId: 'F193',
        ownerUserId: proposal.ownerUserId,
      };
    },
  },
  {
    name: 'F260',
    create() {
      const store = new InMemoryEntityProposalStore();
      const proposal = store.create({
        entityId: 'concept:test',
        entityType: 'concept',
        canonicalName: 'Test',
        aliases: ['test-alias'],
        stance: 'endorsed',
        visibilityScope: 'workspace',
        provenance: [{ source: 'cat-proposed', anchor: 'thread-1' }],
        rationale: 'Test entity',
        sourceThreadId: 'thread-1',
        sourceCatId: 'codex-sol',
        ownerUserId: 'user-1',
      });
      return { store, proposal, producerId: 'F260', ownerUserId: proposal.ownerUserId };
    },
  },
  {
    name: 'F221',
    create() {
      const store = new InMemoryTasteProposalStore();
      const raw = store.create({
        userId: 'user-1',
        catId: 'codex-sol',
        threadId: 'thread-1',
        scene: 'Test taste',
        quote: 'Quote',
        tags: ['real'],
        dimension: 'authentic-expression',
        privacy: 'public',
      });
      // F221 uses id/userId/catId/threadId, not proposalId/ownerUserId/sourceCatId/sourceThreadId.
      // Map to the contract's generic shape.
      return {
        store,
        proposal: { ...raw, proposalId: raw.id, sourceCatId: raw.catId, sourceThreadId: raw.threadId },
        producerId: 'F221',
        ownerUserId: raw.userId,
      };
    },
  },
];

describe('healthy producer publication store contract', () => {
  for (const fixture of cases) {
    it(`${fixture.name} creates staged and commits one immutable envelope`, async () => {
      const { store, proposal, producerId, ownerUserId } = await fixture.create();
      assert.equal(proposal.publication.state, 'staged');
      assert.deepEqual(await store.getPublication(proposal.proposalId), proposal.publication);

      const envelope = {
        canonicalProposalId: proposal.proposalId,
        sourceFeatureId: producerId,
        ownerUserId,
        requesterCatId: proposal.sourceCatId,
        originRef: { kind: 'message', threadId: proposal.sourceThreadId, messageId: 'origin-1' },
        approvalCardRef: { threadId: proposal.sourceThreadId, messageId: 'card-1' },
        createdAt: proposal.createdAt,
      };
      await store.commitEnvelope(proposal.proposalId, envelope);
      await store.commitEnvelope(proposal.proposalId, envelope);
      assert.deepEqual(await store.getPublication(proposal.proposalId), { state: 'anchored', envelope });

      await assert.rejects(
        () =>
          Promise.resolve().then(() =>
            store.commitEnvelope(proposal.proposalId, {
              ...envelope,
              approvalCardRef: { ...envelope.approvalCardRef, messageId: 'card-2' },
            }),
          ),
        /conflicting approval envelope/,
      );
    });

    it(`${fixture.name} rejects an envelope for a different canonical record or producer`, async () => {
      const { store, proposal, producerId, ownerUserId } = await fixture.create();
      const envelope = {
        canonicalProposalId: proposal.proposalId,
        sourceFeatureId: producerId,
        ownerUserId,
        requesterCatId: proposal.sourceCatId,
        originRef: { kind: 'message', threadId: proposal.sourceThreadId, messageId: 'origin-1' },
        approvalCardRef: { threadId: proposal.sourceThreadId, messageId: 'card-1' },
        createdAt: proposal.createdAt,
      };

      await assert.rejects(
        () =>
          Promise.resolve().then(() =>
            store.commitEnvelope(proposal.proposalId, { ...envelope, canonicalProposalId: 'other' }),
          ),
        /canonicalProposalId/,
      );
      await assert.rejects(
        () =>
          Promise.resolve().then(() =>
            store.commitEnvelope(proposal.proposalId, { ...envelope, sourceFeatureId: 'FXXX' }),
          ),
        /sourceFeatureId/,
      );
      assert.deepEqual(await store.getPublication(proposal.proposalId), proposal.publication);
    });

    it(`${fixture.name} abortStaged removes a proposal whose card could not be committed`, async () => {
      const { store, proposal } = await fixture.create();
      await store.abortStaged(proposal.proposalId, 'append failed');
      assert.equal(await store.get(proposal.proposalId), null);
      assert.equal(await store.getPublication(proposal.proposalId), null);
    });
  }
});
