/** F257 operator boundary: approve / skip / reject one cycle proposal. */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  requireConnectorWriteNetworkGuard,
  requireConnectorWriteOwner,
} from '../config/connector-secret-write-guards.js';
import type { CycleGovernanceCoordinator } from '../infrastructure/harness-eval/governance/CycleGovernanceCoordinator.js';

export interface HarnessGovernanceCandidateRoutesOptions {
  governance?: CycleGovernanceCoordinator;
}

export const harnessGovernanceCandidateRoutes: FastifyPluginAsync<HarnessGovernanceCandidateRoutesOptions> = async (
  app,
  opts,
) => {
  app.post('/api/harness-governance-candidates/:proposalId/approve', (request, reply) =>
    decide(request, reply, opts, 'approve'),
  );
  app.post('/api/harness-governance-candidates/:proposalId/skip', (request, reply) =>
    decide(request, reply, opts, 'skip'),
  );
  app.post('/api/harness-governance-candidates/:proposalId/reject', (request, reply) =>
    decide(request, reply, opts, 'reject'),
  );
};

async function decide(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: HarnessGovernanceCandidateRoutesOptions,
  action: 'approve' | 'skip' | 'reject',
): Promise<unknown> {
  const ownerUserId = requireWriteAuth(request, reply);
  if (!ownerUserId) return;
  if (!opts.governance) return reply.status(503).send({ error: 'Harness governance coordinator unavailable' });
  const { proposalId } = request.params as { proposalId: string };
  const reason = noteFromBody(request.body);
  if (action === 'reject' && !reason) {
    return reply.status(400).send({ error: 'harness_governance_reject_reason_required' });
  }
  try {
    const result =
      action === 'approve'
        ? await opts.governance.approveProposal(
            ownerUserId,
            proposalId,
            ownerUserId,
            reason || `Approved Harness governance proposal ${proposalId}`,
          )
        : action === 'skip'
          ? await opts.governance.skipProposal(ownerUserId, proposalId, ownerUserId, reason)
          : await opts.governance.rejectProposal(ownerUserId, proposalId, ownerUserId, reason);
    return reply.send({ ok: true, proposalId, ...result });
  } catch (error) {
    if (!mapGovernanceError(error, reply)) throw error;
  }
}

function requireWriteAuth(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId?.trim();
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  const networkError = requireConnectorWriteNetworkGuard(request);
  if (networkError) {
    reply.status(networkError.status).send({ error: networkError.error });
    return null;
  }
  const ownerError = requireConnectorWriteOwner(userId);
  if (ownerError) {
    reply.status(ownerError.status).send({ error: ownerError.error });
    return null;
  }
  return userId;
}

function noteFromBody(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const note = (body as Record<string, unknown>).note;
  return typeof note === 'string' ? note.trim() : '';
}

function mapGovernanceError(error: unknown, reply: FastifyReply): boolean {
  const message = error instanceof Error ? error.message : '';
  if (message === 'harness_governance_proposal_not_found') {
    reply.status(404).send({ error: message });
    return true;
  }
  if (
    message === 'harness_governance_proposal_not_pending' ||
    message === 'harness_governance_proposal_concurrent_transition' ||
    message === 'harness_governance_cycle_not_active' ||
    message === 'harness_governance_cycle_concurrent_transition' ||
    message === 'harness_governance_source_version_changed'
  ) {
    reply.status(409).send({ error: message });
    return true;
  }
  if (message.startsWith('harness_governance_') || message.startsWith('cycle_governance_')) {
    reply.status(400).send({ error: message });
    return true;
  }
  return false;
}
