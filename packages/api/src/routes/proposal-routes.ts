/** F128 user-side proposal endpoints. Cat-side propose lives in callback-propose-thread-routes.ts. */

import { catIdSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IProposalStore } from '../domains/cats/services/stores/ports/ProposalStore.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveUserId } from '../utils/request-identity.js';
import { appendApprovedInitialMessage } from './proposal-approve-dispatch.js';
import { resolveApproveOverrides } from './proposal-approve-overrides.js';
import { handleApproveStaleClaim, handleRejectStaleClaim } from './proposal-stale-recovery.js';

export interface ProposalRoutesOptions {
  proposalStore: IProposalStore;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  router?: Pick<AgentRouter, 'resolveTargetsAndIntent'>;
  invocationQueue?: Pick<InvocationQueue, 'enqueue' | 'backfillMessageId' | 'rollbackEnqueue'>;
  queueProcessor?: Pick<QueueProcessor, 'processNext'>;
  /** F192: Record proposal rejection as task outcome A2 signal. */
  onProposalReject?: (input: {
    proposalId: string;
    catId: string;
    threadId: string;
    proposalTitle?: string;
    rejectionReason?: string;
  }) => void;
}

const approveBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    parentThreadId: z.string().min(1).optional(),
    preferredCats: z.array(catIdSchema()).max(10).optional(),
    initialMessage: z.string().max(4000).nullable().optional(),
    // F128: let the user re-home the child thread at approve time. Validated against allowed
    // roots (resolvePersistentProjectPath) — supplied-but-invalid → 400 (fail loud, never silent default).
    projectPath: z.string().min(1).max(500).optional(),
    reportingMode: z.enum(['none', 'final-only', 'state-transitions', 'blocking-ack']).optional(),
  })
  .strict();

const rejectBodySchema = z
  .object({
    rejectionReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const proposalParamsSchema = z.object({
  proposalId: z.string().min(1).max(200),
});

export const proposalRoutes: FastifyPluginAsync<ProposalRoutesOptions> = async (app, opts) => {
  const { proposalStore, threadStore, messageStore, socketManager, onProposalReject } = opts;

  app.post('/api/proposals/:proposalId/approve', async (request, reply) => {
    const paramsParse = proposalParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid proposalId' };
    }
    const bodyParse = approveBodySchema.safeParse(request.body ?? {});
    if (!bodyParse.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: bodyParse.error.issues };
    }
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const proposal = await proposalStore.get(paramsParse.data.proposalId);
    if (!proposal) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    if (proposal.createdBy !== userId) {
      reply.status(403);
      return { error: 'Proposal does not belong to the current user' };
    }
    if (proposal.status === 'rejected') {
      reply.status(409);
      return { error: 'Proposal already rejected', status: proposal.status };
    }
    if (proposal.status === 'approved' && proposal.createdThreadId) {
      return {
        proposalId: proposal.proposalId,
        threadId: proposal.createdThreadId,
        status: proposal.status,
        deduped: true,
      };
    }
    if (proposal.status === 'approving') {
      const outcome = await handleApproveStaleClaim({
        proposal,
        userId,
        proposalStore,
        threadStore,
        socketManager,
        reply,
      });
      if (outcome.kind === 'in_flight') {
        return { error: 'Proposal is being approved by another request; retry shortly', status: proposal.status };
      }
      if (outcome.kind === 'recoveredBody') return outcome.body;
      if (outcome.kind === 'race_retry') {
        return { error: 'Proposal status changed concurrently — retry approve' };
      }
      // kind === 'cleared' → fall through; claimForApproval below will re-claim.
    }

    // Resolve + validate the user's approve-time edits (parentThreadId ownership, projectPath
    // validity) BEFORE claiming — a rejected override must not leave the proposal in `approving`.
    const resolution = await resolveApproveOverrides(proposal, bodyParse.data, userId, threadStore);
    if (!resolution.ok) {
      reply.status(resolution.status);
      return { error: resolution.error };
    }
    const {
      finalTitle,
      finalParentThreadId,
      finalPreferredCats,
      finalInitialMessage,
      finalProjectPath,
      finalReportingMode,
      finalizeOverrides,
    } = resolution.resolved;

    // Atomic claim — guards against concurrent approve/reject leaving an orphan thread.
    const claimed = await proposalStore.claimForApproval({ proposalId: proposal.proposalId, approvedBy: userId });
    if (!claimed) {
      reply.status(409);
      return { error: 'Proposal status changed concurrently — retry approve' };
    }

    // Stage 1: create the thread. Only this step is allowed to rollback the claim,
    // because nothing user-visible has been committed yet.
    let thread: Thread;
    try {
      thread = await threadStore.create(userId, finalTitle, finalProjectPath, finalParentThreadId, {
        createdFromProposalId: proposal.proposalId,
        sourceThreadId: proposal.sourceThreadId,
        approvedBy: userId,
        approvedAt: Date.now(),
      });
    } catch (err) {
      await proposalStore.rollbackClaim(proposal.proposalId);
      throw err;
    }

    // Stage 1.5: persist createdThreadId on the proposal BEFORE finalize. If the process dies
    // between create and finalize, the next stale-claim recovery sees this field and re-finalizes
    // against the existing thread — preventing duplicate threads on retry.
    try {
      await proposalStore.recordCreatedThread(proposal.proposalId, thread.id, finalizeOverrides);
    } catch {
      // best-effort persist; failure here only weakens crash recovery, doesn't break the
      // happy path. Finalize below still writes createdThreadId atomically.
    }

    // Stage 2: finalize the proposal NOW that a real threadId exists. After this point,
    // any side-effect failure is reported as a warning — the proposal must NOT roll back
    // (that would leave an orphan thread).
    const finalized = await proposalStore.finalizeApproval({
      proposalId: proposal.proposalId,
      createdThreadId: thread.id,
      overrides: finalizeOverrides,
    });
    if (!finalized) {
      // Should not happen — we hold the approving claim. Surface as 500; thread is intentionally
      // kept (writing finalize is the only contract violation here, not the thread itself).
      reply.status(500);
      return { error: 'Proposal finalize failed unexpectedly after claim', threadId: thread.id };
    }

    // Stage 3: best-effort side effects. Failures become warnings, not 500s.
    const warnings: string[] =
      finalProjectPath === 'default'
        ? ['子 thread 将进入未分类（projectPath=default）；请选择项目或明确保留未分类']
        : [];
    if (finalPreferredCats.length > 0) {
      try {
        await threadStore.updatePreferredCats(thread.id, finalPreferredCats);
      } catch (err) {
        warnings.push(`updatePreferredCats failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (finalInitialMessage) {
      try {
        // F128 round-9 plan-based: routes pass raw user input + parent
        // metadata only; dispatch is the single owner of router resolve,
        // parseIntent, plan computation (targetCats / intent / reporter),
        // enrichWithParentThreadHeader, and enqueue. This closes the
        // round-7/8 補锅匠 trap where enrich had to recover the parallel
        // reporter from a raw `@<token>` regex (which kept missing handle
        // shapes — CJK, dotted, hyphenated).
        const sourceThread = await threadStore.get(proposal.sourceThreadId);

        const result = await appendApprovedInitialMessage({
          proposalId: proposal.proposalId,
          userId,
          threadId: thread.id,
          rawInitialMessage: finalInitialMessage,
          sourceThreadId: proposal.sourceThreadId,
          sourceThreadTitle: sourceThread?.title,
          preferredCats: finalPreferredCats,
          reportingMode: finalReportingMode,
          // Phase AA (AC-AA4/AA5): source cat attribution + crossPost metadata
          sourceCatId: proposal.sourceCatId,
          sourceInvocationId: proposal.sourceInvocationId,
          messageStore,
          router: opts.router,
          invocationQueue: opts.invocationQueue,
          queueProcessor: opts.queueProcessor,
        });
        if (result.warning) warnings.push(result.warning);
      } catch (err) {
        warnings.push(`initialMessage append failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const updatedThread = (await threadStore.get(thread.id)) ?? thread;
    socketManager.emitToUser(userId, 'thread_created', updatedThread);
    socketManager.emitToUser(userId, 'proposal_updated', finalized);

    return {
      proposalId: finalized.proposalId,
      threadId: thread.id,
      status: finalized.status,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });

  app.post('/api/proposals/:proposalId/reject', async (request, reply) => {
    const paramsParse = proposalParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid proposalId' };
    }
    const bodyParse = rejectBodySchema.safeParse(request.body ?? {});
    if (!bodyParse.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: bodyParse.error.issues };
    }
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const proposal = await proposalStore.get(paramsParse.data.proposalId);
    if (!proposal) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    if (proposal.createdBy !== userId) {
      reply.status(403);
      return { error: 'Proposal does not belong to the current user' };
    }
    if (proposal.status === 'approved') {
      reply.status(409);
      return { error: 'Proposal already approved', status: proposal.status };
    }
    if (proposal.status === 'approving') {
      const outcome = await handleRejectStaleClaim({ proposal, proposalStore, threadStore, reply });
      if (outcome.kind === 'in_flight') {
        return {
          error: 'Proposal is being approved — wait for the in-flight approve to settle',
          status: proposal.status,
        };
      }
      if (outcome.kind === 'cannot_reject') return outcome.body;
      // kind === 'cleared' → fall through to markRejected.
    }
    if (proposal.status === 'rejected') {
      return { proposalId: proposal.proposalId, status: proposal.status, deduped: true };
    }

    const marked = await proposalStore.markRejected({
      proposalId: proposal.proposalId,
      rejectedBy: userId,
      ...(bodyParse.data.rejectionReason ? { rejectionReason: bodyParse.data.rejectionReason } : {}),
    });
    if (!marked) {
      reply.status(409);
      return { error: 'Proposal status changed concurrently — retry reject' };
    }

    socketManager.emitToUser(userId, 'proposal_updated', marked);

    // F192: Record proposal rejection as task outcome eval signal
    if (onProposalReject) {
      try {
        onProposalReject({
          proposalId: proposal.proposalId,
          catId: proposal.sourceCatId,
          threadId: proposal.sourceThreadId,
          proposalTitle: proposal.title,
          rejectionReason: bodyParse.data.rejectionReason,
        });
      } catch {
        // Best-effort: don't fail the rejection response if signal recording fails
      }
    }

    return { proposalId: marked.proposalId, status: marked.status };
  });

  app.get('/api/proposals/:proposalId', async (request, reply) => {
    const paramsParse = proposalParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid proposalId' };
    }
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }
    const proposal = await proposalStore.get(paramsParse.data.proposalId);
    if (!proposal) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    if (proposal.createdBy !== userId) {
      reply.status(403);
      return { error: 'Proposal does not belong to the current user' };
    }
    return { proposal };
  });

  app.get('/api/proposals/pending', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }
    const proposals = await proposalStore.listPending(userId);
    return { proposals };
  });
};
