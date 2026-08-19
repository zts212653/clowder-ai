/**
 * F231 Phase C Task3: cat-side propose-profile-update callback route.
 *
 * POST /api/callbacks/propose-profile-update
 *   Cat-auth. Pins the current primer as beforeContent + baseContentHash (the P1-2 optimistic
 *   lock base — approve re-reads and compares before writing). Creates a ProfileUpdateProposal
 *   (status=pending) and appends the confirmation card; does NOT write the primer. Idempotent
 *   via clientRequestId.
 *
 * targetPath is DERIVED from the authenticated cat's stable persona
 * (`relationship/{relationshipKey}-primer.md`), never
 * user-supplied — so a malicious afterContent can't escape the profile dir. INV-6: AC-C1 only
 * writes the current persona primer; capsule is rejected at the schema layer.
 *
 * The companion approve/reject endpoints are user-authenticated and live in
 * profile-update-decision-routes.ts.
 */

import {
  type ApprovalEnvelope,
  COLLECTION_SIGNAL_KINDS,
  generateProposalId,
  type ProfileUpdateProposal,
} from '@cat-cafe/shared';
import {
  relationshipKeyFromPrimerRelativePath,
  relationshipPrimerRelativePath,
} from '@cat-cafe/shared/profile-contract';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { FileProfileRepository } from '../domains/cats/services/profile/ProfileRepository.js';
import { hashContent } from '../domains/cats/services/profile/writeProfileUpdate.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IProfileUpdateProposalStore } from '../domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { profileUpdateProposed } from '../infrastructure/telemetry/instruments.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { buildProfileUpdateCardBlock } from './profile-update-card-block.js';

const proposeSchema = z.object({
  afterContent: z.string().min(1).max(20000),
  rationale: z.string().trim().min(1).max(1000),
  signalKind: z.enum(COLLECTION_SIGNAL_KINDS),
  sourceMessageId: z.string().min(1).optional(),
  // INV-6: AC-C1 writes the current persona primer only. `capsule` is not in the union → 400.
  targetLayer: z.literal('primer').optional(),
  clientRequestId: z.string().min(1).max(200).optional(),
});

export interface ProposeProfileUpdateDeps {
  registry: InvocationRegistry;
  proposalStore: IProfileUpdateProposalStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  repository: FileProfileRepository;
  approvalIngress?: ApprovalIngress;
}

export function registerCallbackProposeProfileUpdateRoutes(app: FastifyInstance, deps: ProposeProfileUpdateDeps): void {
  const { registry, proposalStore, messageStore, socketManager, repository } = deps;
  const approvalIngress = deps.approvalIngress ?? new ApprovalIngress({ messageStore, socketManager });

  app.post('/api/callbacks/propose-profile-update', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = proposeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { afterContent, rationale, signalKind, sourceMessageId, clientRequestId } = parsed.data;
    const invocationId = record.invocationId;

    if (!(await registry.isLatest(invocationId))) {
      return { status: 'stale_ignored' };
    }

    const originMessageId = record.originTriggerMessageId ?? record.a2aTriggerMessageId;
    if (!originMessageId) {
      reply.status(400);
      return { error: 'Exact source message is required for an approval proposal' };
    }
    if (sourceMessageId && sourceMessageId !== originMessageId) {
      reply.status(400);
      return { error: 'sourceMessageId must match the authenticated invocation origin' };
    }

    // Target identity is derived from the authenticated cat's stable persona — never user-supplied.
    let scope: ReturnType<FileProfileRepository['scope']>;
    try {
      scope = repository.scope(record.userId, record.catId);
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : 'invalid profile persona' };
    }
    const targetPath = relationshipPrimerRelativePath(scope.relationshipKey);

    if (clientRequestId) {
      const cached = await proposalStore.getDedupProposalId(record.userId, clientRequestId);
      if (cached) {
        return visibleDedupResponse(approvalIngress, proposalStore, originMessageId, cached, reply);
      }
    }
    // Pin the current primer state as the optimistic-lock base (P1-2).
    const beforeContent = repository.readPrimer(scope)?.content ?? '';
    const baseContentHash = hashContent(beforeContent);

    // Reserve dedup BEFORE create so a concurrent retry's loser creates nothing.
    const proposalId = generateProposalId();
    let reservedDedup = false;
    if (clientRequestId) {
      const winningId = await proposalStore.reserveDedup(record.userId, clientRequestId, proposalId);
      if (winningId !== proposalId) {
        return visibleDedupResponse(approvalIngress, proposalStore, originMessageId, winningId, reply);
      }
      reservedDedup = true;
    }

    let proposal: ProfileUpdateProposal;
    try {
      proposal = await proposalStore.create({
        proposalId,
        sourceThreadId: record.threadId,
        sourceInvocationId: invocationId,
        sourceCatId: record.catId,
        targetLayer: 'primer',
        targetPath,
        beforeContent,
        baseContentHash,
        afterContent,
        rationale,
        signalProvenance: {
          kind: signalKind,
          sourceThreadId: record.threadId,
          sourceMessageId: originMessageId,
        },
        createdBy: record.userId,
      });
    } catch (err) {
      if (reservedDedup && clientRequestId) {
        try {
          await proposalStore.releaseDedup(record.userId, clientRequestId, proposalId);
        } catch {
          // best-effort cleanup; surface the original error
        }
      }
      throw err;
    }

    let envelope: ApprovalEnvelope;
    try {
      envelope = await publishProfileUpdateApproval(approvalIngress, proposalStore, proposal, originMessageId);
    } catch (err) {
      if (reservedDedup && clientRequestId && !(await proposalStore.get(proposal.proposalId))) {
        try {
          await proposalStore.releaseDedup(record.userId, clientRequestId, proposal.proposalId);
        } catch {
          // best-effort cleanup
        }
      }
      throw err;
    }
    socketManager.emitToUser(record.userId, 'profile_update_proposal_created', proposal);

    // F231 AC-C3 eval counter (KD-10)
    profileUpdateProposed.add(1, { 'agent.id': record.catId, 'signal.kind': signalKind });

    // F221 AC-B9: taste routing advisory (non-blocking — proposal already created)
    const { detectTasteSignal } = await import('../domains/taste/services/taste-routing-guard.js');
    const tasteAdvisory = detectTasteSignal({ rationale, afterContent });

    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      messageId: envelope.approvalCardRef.messageId,
      ...(tasteAdvisory ? { routing_advisory: tasteAdvisory } : {}),
    };
  });
}

async function visibleDedupResponse(
  ingress: ApprovalIngress,
  proposalStore: IProfileUpdateProposalStore,
  fallbackOriginMessageId: string,
  proposalId: string,
  reply: FastifyReply,
): Promise<Record<string, unknown>> {
  const proposal = await proposalStore.get(proposalId);
  if (proposal && !proposal.publication) {
    const cardMessageId =
      proposal.cardMessageId ??
      (await ingress.recoverLegacyCard({
        producerId: 'F231',
        canonicalProposalId: proposal.proposalId,
        ownerUserId: proposal.createdBy,
        cardThreadId: proposal.sourceThreadId,
        cardBlockId: buildProfileUpdateCardBlock(proposal).id,
      }));
    if (!cardMessageId) {
      reply.status(503);
      reply.header('retry-after', '1');
      return {
        proposalId,
        error: 'Legacy profile update card is not visible; retry shortly',
        status: 'retryable',
        retryable: true,
      };
    }
    if (!proposal.cardMessageId) await proposalStore.setCardMessageId(proposal.proposalId, cardMessageId);
    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      messageId: cardMessageId,
      deduped: true,
    };
  }
  if (proposal) {
    const envelope = await publishProfileUpdateApproval(ingress, proposalStore, proposal, fallbackOriginMessageId);
    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      messageId: envelope.approvalCardRef.messageId,
      deduped: true,
    };
  }
  reply.status(503);
  reply.header('retry-after', '1');
  return {
    proposalId,
    error: proposal
      ? 'Profile update proposal in-flight (card not visible yet); retry shortly'
      : 'Profile update proposal reservation in-flight (card not visible yet); retry shortly',
    status: 'retryable',
    retryable: true,
  };
}

function publishProfileUpdateApproval(
  ingress: ApprovalIngress,
  store: IProfileUpdateProposalStore,
  proposal: ProfileUpdateProposal,
  fallbackOriginMessageId: string,
) {
  const sourceMessageId = proposal.signalProvenance.sourceMessageId ?? fallbackOriginMessageId;
  const relationshipKey = relationshipKeyFromPrimerRelativePath(proposal.targetPath);
  return ingress.publish(
    {
      producerId: 'F231',
      canonicalProposalId: proposal.proposalId,
      ownerUserId: proposal.createdBy,
      requesterCatId: proposal.sourceCatId,
      originRef: { kind: 'message', threadId: proposal.signalProvenance.sourceThreadId, messageId: sourceMessageId },
      cardThreadId: proposal.sourceThreadId,
      cardContent: `提议更新 ${relationshipKey} persona 的关系档案（primer）`,
      cardBlock: buildProfileUpdateCardBlock(proposal),
      createdAt: proposal.createdAt,
    },
    store,
  );
}
