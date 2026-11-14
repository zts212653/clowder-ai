import { isDeepStrictEqual } from 'node:util';
import type { EntityProposal } from '@cat-cafe/shared';
import type { FastifyReply } from 'fastify';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { ProposeEntityDeps, ProposeEntityInput } from './callback-propose-entity-routes.js';
import { readMemoryProposalRetryOrigin } from './memory-proposal-retry-origin.js';
import { publishEntityProposal } from './wave2-proposal-publication.js';

export async function recoverEntityProposal(
  proposal: EntityProposal,
  input: ProposeEntityInput,
  actor: InvocationRecord,
  deps: ProposeEntityDeps,
  reply: FastifyReply,
  recoverStaged: boolean,
) {
  if (proposal.publication?.state === 'staged' && proposal.sourceThreadId !== actor.threadId) {
    return reply.status(409).send({
      error: 'Staged proposal recovery must run in its original thread',
      status: 'origin_thread_required',
      sourceThreadId: proposal.sourceThreadId,
    });
  }
  if (!entityRequestMatches(proposal, input, actor)) {
    return reply.status(409).send({ error: 'client_request_conflict' });
  }
  const origin = await readMemoryProposalRetryOrigin(deps.approvalIngress, 'F260', proposal);
  if (!origin) {
    return reply.status(409).send({ error: 'origin_not_eligible' });
  }
  if (!recoverStaged && proposal.publication?.state !== 'anchored') {
    reply.header('retry-after', '1');
    return reply
      .status(503)
      .send({ error: 'Proposal publication is still in-flight; retry shortly', status: 'retryable' });
  }
  if (proposal.publication?.state === 'staged' || proposal.publication?.state === 'anchored') {
    // Eligibility above requires the exact persisted origin. Never fall back to the retry actor.
    await publishEntityProposal(deps.approvalIngress, deps.entityProposalStore, proposal, origin);
  }
  return {
    proposalId: proposal.proposalId,
    status: proposal.status,
    entityId: proposal.entityId,
    ...(proposal.publication?.state === 'staged' ? { recovered: true } : { deduped: true }),
  };
}

function entityRequestMatches(proposal: EntityProposal, input: ProposeEntityInput, actor: InvocationRecord): boolean {
  return (
    proposal.ownerUserId === actor.userId &&
    proposal.sourceCatId === actor.catId &&
    proposal.sourceThreadId === actor.threadId &&
    proposal.entityId === input.entityId &&
    proposal.entityType === input.entityType &&
    proposal.canonicalName === input.canonicalName &&
    proposal.stance === input.stance &&
    proposal.visibilityScope === input.visibilityScope &&
    proposal.rationale === input.rationale &&
    isDeepStrictEqual(proposal.aliases, input.aliases) &&
    isDeepStrictEqual(proposal.provenance, input.provenance)
  );
}
