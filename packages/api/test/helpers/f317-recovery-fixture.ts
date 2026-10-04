import { APPROVAL_PRODUCER_IDS, createCatId } from '@cat-cafe/shared';
import {
  ApprovalProducerRegistry,
  type ApprovalProducerRuntimeBindings,
} from '../../src/domains/approval-hub/ApprovalProducerRegistry.js';
import { F128ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F128ApprovalAdapter.js';
import { ContextEpochOwner } from '../../src/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../../src/domains/cats/services/stores/ports/ContextEpochStore.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import {
  InMemoryProposalStore,
  type IProposalStore,
} from '../../src/domains/cats/services/stores/ports/ProposalStore.js';
import { SummaryStore } from '../../src/domains/cats/services/stores/ports/SummaryStore.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { MessageLiveInboxSource } from '../../src/domains/concierge/live/inbox/MessageLiveInboxSource.js';

export const scope = {
  userId: 'owner',
  threadId: 'home',
  catId: createCatId('codex-astra'),
  invocationId: 'child',
  callId: 'call',
  generation: 1,
};

export function fixtureApprovalRegistry(proposals: IProposalStore) {
  const bindings = Object.fromEntries(
    APPROVAL_PRODUCER_IDS.map((featureId) => [
      featureId,
      {
        adapter:
          featureId === 'F128'
            ? new F128ApprovalAdapter(proposals)
            : { featureId, listPending: () => [], listSettled: () => [] },
        lifecycle: { contractVersion: 1, writerGeneration: 'legacy' },
      },
    ]),
  ) as ApprovalProducerRuntimeBindings;
  return new ApprovalProducerRegistry(bindings);
}

export function recoveryFixture() {
  const tasks = new TaskStore();
  const summaries = new SummaryStore({ maxSummaries: 500 });
  const messages = new MessageStore();
  const proposals = new InMemoryProposalStore();
  const epochs = new InMemoryContextEpochStore();
  const epochOwner = new ContextEpochOwner(epochs);
  let allowed = true;
  const authorize = async () => allowed;
  const approvals = fixtureApprovalRegistry(proposals);
  const inbox = new MessageLiveInboxSource({ store: messages, authorize });
  const options = { tasks, messages, epochs, approvals, inbox, authorize };
  const message = (content = 'source') =>
    messages.append({
      userId: scope.userId,
      threadId: scope.threadId,
      catId: null,
      content,
      mentions: [],
      timestamp: Date.now(),
    });
  const task = (title = 'old unfinished work', sourceMessageId?: string) => {
    const item = tasks.create({
      threadId: scope.threadId,
      userId: scope.userId,
      title,
      why: 'accepted work',
      ownerCatId: scope.catId,
      createdBy: scope.catId,
    });
    // Hydrated legacy records can carry these fields; the generic create path currently omits them.
    if (sourceMessageId) Object.assign(item, { sourceMessageId });
    return item;
  };
  const summary = () =>
    summaries.create({
      threadId: scope.threadId,
      createdBy: scope.catId,
      topic: 'recorded discussion',
      conclusions: ['use blue'],
      openQuestions: ['size?'],
    });
  const decision = (source = message(), title = 'approved project') => {
    const proposal = proposals.create({
      sourceThreadId: scope.threadId,
      sourceInvocationId: 'old-child',
      sourceCatId: scope.catId,
      sourceMessageId: source.id,
      title,
      reason: 'source intent',
      parentThreadId: scope.threadId,
      preferredCats: [scope.catId],
      projectPath: '/test',
      createdBy: scope.userId,
    });
    proposals.commitEnvelope(proposal.proposalId, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F128',
      ownerUserId: scope.userId,
      requesterCatId: scope.catId,
      originRef: { kind: 'message', threadId: scope.threadId, messageId: source.id },
      approvalCardRef: { threadId: scope.threadId, messageId: source.id },
      createdAt: proposal.createdAt,
    });
    proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: scope.userId });
    proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: 'result-thread' });
    return proposal;
  };
  return {
    ...options,
    summaries,
    options,
    epochOwner,
    message,
    task,
    summary,
    decision,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
  };
}
