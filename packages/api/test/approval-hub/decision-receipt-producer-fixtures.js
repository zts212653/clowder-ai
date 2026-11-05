import { createProposal as scheduleProposal } from '../scheduler/schedule-proposal-decision-fixture.js';
import { createExtraProducer } from './decision-receipt-extra-fixtures.js';

export const OWNER = 'owner-user';
export const CARD_THREAD = 'receipt-card-thread';
export const SECRET = 'sensitive-proposal-body-do-not-copy';
export const REASON = 'No thanks, this is not needed';

export async function anchor(store, producerId, id, createdAt) {
  await store.commitEnvelope(id, {
    canonicalProposalId: id,
    sourceFeatureId: producerId,
    ownerUserId: OWNER,
    requesterCatId: 'codex-sol',
    createdAt,
    originRef: { kind: 'message', threadId: 'original-source-thread', messageId: 'source-message' },
    approvalCardRef: { threadId: CARD_THREAD, messageId: `card-${id}` },
  });
}

export async function createProducer(producerId, db, t) {
  let store, proposal, settle;
  const common = { sourceThreadId: 'original-source-thread', sourceCatId: 'codex-sol', createdBy: OWNER };
  switch (producerId) {
    case 'F128': {
      const { InMemoryProposalStore } = await import('../../dist/domains/cats/services/stores/ports/ProposalStore.js');
      store = new InMemoryProposalStore();
      proposal = store.create({
        ...common,
        sourceInvocationId: 'inv-1',
        title: SECRET,
        reason: SECRET,
        parentThreadId: 'parent',
        preferredCats: ['codex-sol'],
        projectPath: '/p',
      });
      settle = async (action) => {
        if (action === 'reject')
          return store.markRejected({ proposalId: proposal.proposalId, rejectedBy: OWNER, rejectionReason: REASON });
        store.claimForApproval({ proposalId: proposal.proposalId, approvedBy: OWNER });
        return store.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: 'created-thread' });
      };
      break;
    }
    case 'F139': {
      const { ScheduleMutationProposalStore } = await import(
        '../../dist/infrastructure/scheduler/ScheduleMutationProposalStore.js'
      );
      store = new ScheduleMutationProposalStore(db);
      proposal = scheduleProposal({ proposalId: 'receipt-schedule', ownerUserId: OWNER });
      proposal.mutation.task.params.message = SECRET;
      store.create(proposal);
      settle = async (action) => {
        if (action === 'reject') return store.reject(proposal.proposalId, OWNER, REASON, Date.now());
        store.claimForApproval(proposal.proposalId, Date.now());
        store.applyCreateEffect(proposal.proposalId, Date.now());
        return store.finalizeApproved(proposal.proposalId, OWNER, Date.now());
      };
      break;
    }
    case 'F193': {
      const { InMemoryDispatchProposalStore } = await import(
        '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
      );
      store = new InMemoryDispatchProposalStore();
      ({ proposal } = await store.create({
        proposalId: 'receipt-dispatch',
        sourceThreadId: common.sourceThreadId,
        targetThreadId: 'target',
        senderCatId: 'codex-sol',
        ownerUserId: OWNER,
        content: SECRET,
        targetCats: ['kimi'],
        createdAt: Date.now(),
      }));
      settle = (action) => store[action === 'approve' ? 'approve' : 'reject'](proposal.proposalId, OWNER);
      break;
    }
    case 'F221': {
      const { InMemoryTasteProposalStore } = await import(
        '../../dist/domains/taste/stores/InMemoryTasteProposalStore.js'
      );
      store = new InMemoryTasteProposalStore();
      proposal = store.create({
        userId: OWNER,
        catId: 'codex-sol',
        threadId: common.sourceThreadId,
        scene: SECRET,
        quote: SECRET,
        tags: ['clarity'],
        dimension: 'authentic-expression',
        privacy: 'private',
      });
      settle = async (action) => {
        if (action === 'reject') return store.markRejected(proposal.id, REASON, OWNER);
        store.claimForApproval(proposal.id, OWNER);
        return store.finalizeApproval(proposal.id, OWNER, 'receipt', '/receipt.md');
      };
      break;
    }
    case 'F225': {
      const { InMemorySessionHandoffProposalStore } = await import(
        '../../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js'
      );
      store = new InMemorySessionHandoffProposalStore();
      proposal = store.create({
        userId: OWNER,
        sourceCatId: 'codex-sol',
        sourceThreadId: common.sourceThreadId,
        sourceSessionId: 'session',
        note: { done: SECRET, nextSteps: SECRET },
      });
      settle = async (action) => {
        if (action === 'reject')
          return store.markRejected(proposal.proposalId, {
            decidedAt: Date.now(),
            feedback: { reasonCode: 'other', detail: REASON },
          });
        store.claimForApproval(proposal.proposalId);
        return store.finalizeApproval(proposal.proposalId);
      };
      break;
    }
    case 'F231': {
      const { InMemoryProfileUpdateProposalStore } = await import(
        '../../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js'
      );
      store = new InMemoryProfileUpdateProposalStore();
      proposal = store.create({
        ...common,
        sourceInvocationId: 'inv',
        targetLayer: 'primer',
        targetPath: '/primer.md',
        beforeContent: SECRET,
        baseContentHash: 'a'.repeat(64),
        afterContent: SECRET,
        rationale: SECRET,
        signalProvenance: { kind: 'cat-declared', sourceThreadId: common.sourceThreadId },
      });
      settle = async (action) => {
        if (action === 'reject') return store.markRejected(proposal.proposalId, OWNER, REASON);
        store.claimForApproval(proposal.proposalId, OWNER);
        store.recordCheckpoint(proposal.proposalId, { writtenPath: '/primer.md', provenancePath: '/provenance.json' });
        return store.finalizeApproval(proposal.proposalId);
      };
      break;
    }
    case 'F260': {
      const { InMemoryEntityProposalStore } = await import(
        '../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js'
      );
      store = new InMemoryEntityProposalStore();
      proposal = store.create({
        entityId: 'concept:receipt',
        entityType: 'concept',
        canonicalName: SECRET,
        aliases: [],
        stance: 'endorsed',
        visibilityScope: 'workspace',
        provenance: [{ source: 'cat-proposed', anchor: 'test' }],
        rationale: SECRET,
        sourceThreadId: common.sourceThreadId,
        sourceCatId: 'codex-sol',
        ownerUserId: OWNER,
      });
      settle = (action) =>
        action === 'reject'
          ? store.markRejected(proposal.proposalId, OWNER, REASON)
          : store.markApproved(proposal.proposalId, OWNER);
      break;
    }
    default:
      return createExtraProducer(producerId, db, t);
  }
  const id = proposal.proposalId ?? proposal.id;
  await anchor(store, producerId, id, proposal.createdAt);
  const mod = await import(`../../dist/domains/approval-hub/adapters/${producerId}ApprovalAdapter.js`);
  const adapter = new mod[`${producerId}ApprovalAdapter`](store);
  return { id, adapter, settle };
}
