import { APPROVAL_PRODUCER_IDS, type CatId, type IgnoredItemEntry, type RichCardBlock } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { ApprovalIngress } from '../../src/domains/approval-hub/ApprovalIngress.js';
import {
  ApprovalProducerRegistry,
  type ApprovalProducerRuntimeBindings,
  bindLegacyApprovalProducer,
} from '../../src/domains/approval-hub/ApprovalProducerRegistry.js';
import { F193ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F193ApprovalAdapter.js';
import { F221ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F221ApprovalAdapter.js';
import { F260ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F260ApprovalAdapter.js';
import type { IApprovalAdapter } from '../../src/domains/approval-hub/ports/IApprovalAdapter.js';
import { InMemoryDispatchProposalStore } from '../../src/domains/approval-hub/stores/ports/IDispatchProposalStore.js';
import { InMemoryEntityProposalStore } from '../../src/domains/approval-hub/stores/ports/IEntityProposalStore.js';
import { MessageStore, type StoredMessage } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { InMemoryTasteProposalStore } from '../../src/domains/taste/stores/InMemoryTasteProposalStore.js';
import { readCompanionDecisionProjection } from '../../src/routes/companion-decision-read-service.js';
import { buildDispatchProposalCardBlock } from '../../src/routes/dispatch-proposal-card-block.js';
import { buildEntityProposalCardBlock } from '../../src/routes/entity-proposal-card-block.js';
import { buildTasteProposalCardBlock } from '../../src/routes/taste-proposal-card-block.js';

export type InformationProducer = 'F193' | 'F221' | 'F260';
export const infoOwner = 'owner';
const catId = 'codex-sol' as CatId;
const threadId = 'info-thread';

/** Real staged store -> feature builder -> Ingress -> adapter/registry -> owner projection. */
export async function informationalOriginalFixture(feature: InformationProducer, correction = false) {
  const messages = new MessageStore();
  const origin = await messages.append({
    userId: infoOwner,
    from: { kind: 'user', userId: infoOwner },
    threadId,
    content: 'Please consider this',
    mentions: [],
    timestamp: Date.now(),
  });
  const originRef = { kind: 'message' as const, threadId, messageId: origin.id };
  const dispatch = new InMemoryDispatchProposalStore();
  const taste = new InMemoryTasteProposalStore();
  const entity = new InMemoryEntityProposalStore();
  const dispatchProposal = (
    await dispatch.create({
      proposalId: 'dispatch-one',
      sourceInvocationId: 'invocation-one',
      sourceThreadId: threadId,
      targetThreadId: 'target-thread',
      senderCatId: catId,
      ownerUserId: infoOwner,
      content: 'Implement the accepted task and return its result',
      targetCats: ['kimi'],
      createdAt: Date.now(),
      approvalOriginRef: originRef,
      proposedAction: {
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        subjectRef: 'subject:task:original',
        terminalPredicate: { kind: 'task_done' },
      },
    })
  ).proposal;
  const tasteProposal = taste.create({
    proposalId: 'taste-one',
    userId: infoOwner,
    catId,
    threadId,
    sourceMessageId: origin.id,
    approvalOriginRef: originRef,
    scene: 'The source context',
    quote: 'Show me the real result',
    takeaway: 'Prefer verifiable outcomes',
    tags: ['outcome', 'clarity'],
    dimension: 'cognitive-honesty',
    privacy: 'public',
    ...(correction
      ? {
          correctionTarget: {
            sourceAnchor: 'taste-vignette:docs/taste/vignettes/original.md',
            expectedRevision: `sha256:${'a'.repeat(64)}`,
            reason: 'outdated' as const,
            suggestedPatch: { scene: 'A corrected scene', quotes: ['A corrected quotation'] },
          },
        }
      : {}),
  });
  const entityProposal = entity.create({
    proposalId: 'entity-one',
    entityId: 'concept:outcome',
    entityType: 'concept',
    canonicalName: 'Verifiable outcome',
    aliases: ['Observable result'],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    provenance: [{ source: 'thread', anchor: threadId }],
    rationale: 'Use this name for the shared concept',
    sourceThreadId: threadId,
    sourceCatId: catId,
    ownerUserId: infoOwner,
    approvalOriginRef: originRef,
  });
  const selected =
    feature === 'F193'
      ? {
          proposalId: dispatchProposal.proposalId,
          createdAt: dispatchProposal.createdAt,
          block: buildDispatchProposalCardBlock(dispatchProposal),
          store: dispatch,
        }
      : feature === 'F221'
        ? {
            proposalId: tasteProposal.id,
            createdAt: tasteProposal.createdAt,
            block: buildTasteProposalCardBlock(tasteProposal),
            store: taste,
          }
        : {
            proposalId: entityProposal.proposalId,
            createdAt: entityProposal.createdAt,
            block: buildEntityProposalCardBlock(entityProposal),
            store: entity,
          };
  const ingress = new ApprovalIngress({
    messageStore: messages,
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
  });
  const envelope = await ingress.publish(
    {
      producerId: feature,
      canonicalProposalId: selected.proposalId,
      ownerUserId: infoOwner,
      requesterCatId: catId,
      originRef,
      cardThreadId: threadId,
      cardContent: 'Original domain proposal',
      cardBlock: selected.block,
      createdAt: selected.createdAt,
    },
    selected.store,
  );
  const adapter: IApprovalAdapter =
    feature === 'F193'
      ? new F193ApprovalAdapter(dispatch)
      : feature === 'F221'
        ? new F221ApprovalAdapter(taste)
        : new F260ApprovalAdapter(entity);
  const bindings = Object.fromEntries(
    APPROVAL_PRODUCER_IDS.map((id) => [
      id,
      bindLegacyApprovalProducer(
        id === feature ? adapter : { featureId: id, listPending: () => [], listSettled: () => [] },
      ),
    ]),
  ) as ApprovalProducerRuntimeBindings;
  const registry = new ApprovalProducerRegistry(bindings);
  const app = Fastify();
  app.get('/api/approval-hub/pending', async (request) => ({
    items: await registry.listPending(String(request.headers['x-cat-cafe-user'])),
    coverage: { state: 'complete' },
  }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  const stored = await messages.getById(envelope.approvalCardRef.messageId);
  if (!stored) throw new Error('Ingress failed to publish its card');
  return {
    block: stored.extra?.rich?.blocks[0] as RichCardBlock,
    stored,
    envelope,
    dispatch,
    taste,
    entity,
    registry,
    project: (mutate?: (message: StoredMessage) => StoredMessage | null, entries: IgnoredItemEntry[] = []) =>
      readCompanionDecisionProjection(
        app,
        infoOwner,
        { offset: 0, limit: 20 },
        undefined,
        undefined,
        undefined,
        { mode: 'visible', read: () => ({ ownerUserId: infoOwner, revision: 1, entries }) },
        {
          getById: async (id) => {
            const message = await messages.getById(id);
            return message && mutate ? mutate(structuredClone(message)) : message;
          },
        },
      ),
    close: () => app.close(),
  };
}
