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
 * writes only after the owner confirms; F332 KD-8 adds the bounded owner-wide capsule.
 *
 * The companion approve/reject endpoints are user-authenticated and live in
 * profile-update-decision-routes.ts.
 */

import { generateProposalId, type ProfileUpdateProposal } from '@cat-cafe/shared';
import {
  PROFILE_CAPSULE_RELATIVE_PATH,
  profileCorpusRelativePath,
  relationshipPrimerRelativePath,
  renderUserCapsuleSection,
} from '@cat-cafe/shared/profile-contract';
import type { FastifyInstance } from 'fastify';
import { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { FileProfileRepository } from '../domains/cats/services/profile/ProfileRepository.js';
import { hashContent } from '../domains/cats/services/profile/writeProfileUpdate.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IProfileUpdateProposalStore } from '../domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { ProfileUpdateReservationLostError } from '../domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { profileUpdateProposed } from '../infrastructure/telemetry/instruments.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { isEligibleProfileOrigin, profileUpdateInputSchema } from './profile-update-proposal-input.js';
import {
  publishProfileUpdateApproval,
  releaseEmptyProfileReservation,
  visibleDedupResponse,
} from './profile-update-proposal-publication.js';

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

    const parsed = profileUpdateInputSchema.safeParse(request.body);
    if (!parsed.success) {
      // Phase E: surface typed error for invalid targetLayer specifically (Design Gate §5).
      const layerIssue = parsed.error.issues.find((i) => i.path.includes('targetLayer'));
      if (layerIssue) {
        reply.status(400);
        return { error: 'invalid_target_layer', detail: layerIssue.message };
      }
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { afterContent, rationale, signalKind, sourceMessageId, clientRequestId, targetLayer, expectedRevision } =
      parsed.data;
    const invocationId = record.invocationId;

    if (!(await registry.isLatest(invocationId))) {
      return { status: 'stale_ignored' };
    }

    const originMessageId = record.originTriggerMessageId ?? record.a2aTriggerMessageId;
    if (!originMessageId) {
      reply.status(400);
      return { error: 'Exact source message is required for an approval proposal' };
    }
    // Recheck the authenticated source even on retries; a cache hit is not permission.
    const origin = await messageStore.getById(originMessageId);
    if (!isEligibleProfileOrigin(origin, record.userId, record.threadId)) {
      return reply.status(409).send({ error: 'origin_not_eligible' });
    }

    // Dedup check BEFORE target read: a retry with a known clientRequestId must return
    // the cached proposal even when the repository is temporarily unavailable (cloud P1).
    if (clientRequestId) {
      const cached = await proposalStore.getDedupProposalId(record.userId, clientRequestId);
      if (cached) {
        return visibleDedupResponse(approvalIngress, proposalStore, cached, parsed.data, record, messageStore, reply);
      }
    }
    // Only a new request binds its explicit source to this invocation. Recovery compares the saved origin.
    if (sourceMessageId && sourceMessageId !== originMessageId) {
      return reply.status(400).send({ error: 'sourceMessageId must match the authenticated invocation origin' });
    }

    if (targetLayer === 'capsule') {
      try {
        if (!renderUserCapsuleSection(afterContent)) throw new Error('Capsule is empty');
      } catch {
        return reply
          .status(400)
          .send({ error: 'invalid_content', detail: 'Capsule must contain 1–300 non-whitespace characters' });
      }
    }

    // Phase E: derive target identity by layer.
    let targetPath: string;
    let beforeContent: string;
    let scope: ReturnType<FileProfileRepository['scope']> | undefined;

    if (targetLayer === 'capsule' || targetLayer === 'corpus') {
      try {
        targetPath = targetLayer === 'capsule' ? PROFILE_CAPSULE_RELATIVE_PATH : profileCorpusRelativePath();
        beforeContent =
          (targetLayer === 'capsule' ? repository.readCapsule(record.userId) : repository.readCorpus(record.userId))
            ?.content ?? '';
      } catch {
        reply.status(503);
        return { error: `${targetLayer}_target_unavailable`, detail: 'Profile repository is currently unavailable' };
      }
    } else {
      // Target identity is derived from the authenticated cat's stable persona — never user-supplied.
      try {
        scope = repository.scope(record.userId, record.catId);
      } catch (err) {
        reply.status(400);
        return { error: err instanceof Error ? err.message : 'invalid profile persona' };
      }
      targetPath = relationshipPrimerRelativePath(scope.relationshipKey);
      beforeContent = repository.readPrimer(scope)?.content ?? '';
    }
    const baseContentHash = hashContent(beforeContent);
    if (expectedRevision !== undefined && expectedRevision !== `sha256:${baseContentHash}`) {
      return reply.status(409).send({ error: 'profile_revision_changed', recovery: 'read_profile_then_revise' });
    }

    // Reserve dedup BEFORE create so a concurrent retry's loser creates nothing.
    const proposalId = generateProposalId();
    if (clientRequestId) {
      const winningId = await proposalStore.reserveDedup(record.userId, clientRequestId, proposalId);
      if (winningId !== proposalId) {
        return visibleDedupResponse(
          approvalIngress,
          proposalStore,
          winningId,
          parsed.data,
          record,
          messageStore,
          reply,
        );
      }
    }

    let proposal: ProfileUpdateProposal;
    try {
      proposal = await proposalStore.create({
        proposalId,
        ...(clientRequestId ? { clientRequestId } : {}),
        sourceThreadId: record.threadId,
        sourceInvocationId: invocationId,
        sourceCatId: record.catId,
        targetLayer,
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
      await releaseEmptyProfileReservation(proposalStore, record.userId, clientRequestId, proposalId);
      if (err instanceof ProfileUpdateReservationLostError) {
        return reply.status(409).send({ error: 'profile_request_reservation_changed', recovery: 'retry_same_request' });
      }
      throw err;
    }

    const envelope = await publishProfileUpdateApproval(approvalIngress, proposalStore, proposal);
    socketManager.emitToUser(record.userId, 'profile_update_proposal_created', proposal);

    // F231 AC-C3 eval counter (KD-10)
    profileUpdateProposed.add(1, { 'agent.id': record.catId, 'signal.kind': signalKind, 'target.layer': targetLayer });

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
