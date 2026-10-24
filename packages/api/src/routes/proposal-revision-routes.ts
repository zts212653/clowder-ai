import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAnchoredPublication } from '../domains/approval-hub/requireAnchoredPublication.js';
import { generateSortableId } from '../domains/cats/services/stores/ports/MessageStore.js';
import { primaryMentionHandleForCatId } from '../utils/cat-mention-handle.js';
import { resolvePersistentProjectPath } from '../utils/persistent-project-path.js';
import { resolveStrictUserId } from '../utils/request-identity.js';
import { validateProposalGroup } from './proposal-group-placement.js';
import type { ProposalRoutesOptions } from './proposal-route-options.js';

const bodySchema = z
  .object({
    instruction: z.string().trim().min(1).max(2000),
    suggestedGroupId: z
      .string()
      .regex(/^attention_[A-Za-z0-9_-]+$/)
      .nullable()
      .optional(),
    projectPath: z.string().min(1).max(500).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

/** Owner-authored feedback is sent through the existing durable Queue to exactly the proposer. */
export function registerProposalRevisionRoutes(app: FastifyInstance, opts: ProposalRoutesOptions): void {
  app.post<{ Params: { proposalId: string } }>(
    '/api/proposals/:proposalId/request-revision',
    async (request, reply) => {
      const userId = resolveStrictUserId(request);
      if (!userId) return reply.code(401).send({ error: 'Owner identity required' });
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Please enter the requested change' });
      const proposal = await opts.proposalStore.get(request.params.proposalId);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });
      if (proposal.createdBy !== userId)
        return reply.code(403).send({ error: 'Proposal does not belong to the current user' });
      const source = await opts.threadStore.get(proposal.sourceThreadId);
      if (!source || source.createdBy !== userId)
        return reply.code(403).send({ error: 'Source thread does not belong to the current user' });
      if (!opts.invocationQueue)
        return reply.code(503).send({ error: 'Message delivery is unavailable; please retry' });
      if (!(await validateProposalGroup(opts.threadStore, userId, parsed.data.suggestedGroupId)))
        return reply.code(400).send({ error: 'Selected Group does not belong to you' });
      const { instruction, ...choices } = parsed.data;
      if (choices.projectPath) {
        const canonical = await resolvePersistentProjectPath(choices.projectPath);
        if (!canonical) return reply.code(400).send({ error: 'Invalid projectPath' });
        choices.projectPath = canonical;
      }
      await requireAnchoredPublication(opts.proposalStore, proposal.proposalId);
      const reserved = await opts.proposalStore.recordRevisionRequest(proposal.proposalId, {
        messageId: generateSortableId(Date.now()),
        instruction,
        requestedBy: userId,
        requestedAt: Date.now(),
        ...(Object.keys(choices).length ? { choices } : {}),
      });
      if (!reserved?.revisionRequest)
        return reply
          .code(409)
          .send({ error: 'This proposal changed or already has a different revision request; reread it' });
      const revision = reserved.revisionRequest;
      const content = `${primaryMentionHandleForCatId(proposal.sourceCatId) ?? `@${proposal.sourceCatId}`}\n\n${revision.instruction}\n\n请按上面的原话修改提议「${proposal.title}」，用 cat_cafe_propose_thread 重提，带 supersedesProposalId="${proposal.proposalId}"。preferredCats 是派给谁的唯一来源，initialMessage 正文开头不要重复点名。新卡发布后旧卡会自动收起。`;
      const from = { kind: 'user', userId } as const;
      const idempotencyKey = `proposal-revision:${proposal.proposalId}:${revision.messageId}`;
      const result = await opts.invocationQueue.send(
        opts.messageStore,
        {
          from,
          userId,
          content,
          mentions: [proposal.sourceCatId],
          timestamp: revision.requestedAt,
          threadId: proposal.sourceThreadId,
          deliveryStatus: 'queued',
          idempotencyKey,
          reservedId: revision.messageId,
        },
        {
          from,
          userId,
          threadId: proposal.sourceThreadId,
          kind: 'conversation_input',
          ownerAuthProvenance: 'strict',
          targetCats: [proposal.sourceCatId],
          exactTargets: true,
          content,
          intent: 'execute',
          idempotencyKey,
        },
      );
      if (result.outcome === 'full')
        return reply.code(429).send({ error: 'The proposer queue is full; retry this change shortly' });
      const queued = await opts.proposalStore.recordRevisionRequest(proposal.proposalId, {
        ...revision,
        queuedAt: Date.now(),
      });
      opts.socketManager.emitToUser(userId, 'new_message', result.message);
      opts.socketManager.emitToUser(userId, 'proposal_updated', queued ?? reserved);
      return { proposalId: proposal.proposalId, messageId: result.message.id, status: 'revision_requested' };
    },
  );
}
