/** F128 cat-side requester withdrawal for still-pending thread proposals. */

import type { ThreadProposal } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAnchoredPublication } from '../domains/approval-hub/requireAnchoredPublication.js';
import type {
  InvocationRecord,
  InvocationRegistry,
} from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IProposalStore } from '../domains/cats/services/stores/ports/ProposalStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const withdrawThreadProposalSchema = z
  .object({
    proposalId: z.string().trim().min(1).max(200),
  })
  .strict();

export interface WithdrawThreadProposalDeps {
  registry: InvocationRegistry;
  proposalStore: IProposalStore;
  socketManager: SocketManager;
}

async function requireRequesterPendingProposal(
  deps: WithdrawThreadProposalDeps,
  record: InvocationRecord,
  proposalId: string,
  reply: FastifyReply,
): Promise<ThreadProposal | null> {
  const proposal = await deps.proposalStore.get(proposalId);
  if (!proposal) {
    reply.status(404).send({ error: 'Proposal not found' });
    return null;
  }
  if (proposal.createdBy !== record.userId) {
    reply.status(403).send({ error: 'Proposal does not belong to the current user' });
    return null;
  }
  if (proposal.sourceCatId !== record.catId) {
    reply.status(403).send({ error: 'Only the proposal requester can withdraw it' });
    return null;
  }
  if (proposal.status === 'withdrawn') {
    reply.send({ proposalId: proposal.proposalId, status: proposal.status, deduped: true });
    return null;
  }
  if (proposal.status !== 'pending') {
    reply.status(409).send({ error: 'Only a pending proposal can be withdrawn', status: proposal.status });
    return null;
  }
  return proposal;
}

export function registerCallbackWithdrawThreadProposalRoutes(
  app: FastifyInstance,
  deps: WithdrawThreadProposalDeps,
): void {
  app.post('/api/callbacks/withdraw-thread-proposal', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const parsed = withdrawThreadProposalSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    if (!(await deps.registry.isLatest(record.invocationId))) return { status: 'stale_ignored' };

    const proposal = await requireRequesterPendingProposal(deps, record, parsed.data.proposalId, reply);
    if (!proposal) return;

    await requireAnchoredPublication(deps.proposalStore, proposal.proposalId);
    const withdrawn = await deps.proposalStore.withdrawPending({
      proposalId: proposal.proposalId,
      withdrawnBy: record.catId,
    });
    if (!withdrawn) {
      const current = await deps.proposalStore.get(proposal.proposalId);
      if (
        current?.status === 'withdrawn' &&
        current.createdBy === record.userId &&
        current.sourceCatId === record.catId &&
        current.withdrawnBy === record.catId
      ) {
        return { proposalId: current.proposalId, status: current.status, deduped: true };
      }
      reply.status(409);
      return { error: 'Proposal status changed concurrently', status: current?.status ?? 'unknown' };
    }

    deps.socketManager.emitToUser(record.userId, 'proposal_updated', withdrawn);
    return { proposalId: withdrawn.proposalId, status: withdrawn.status };
  });
}
