import type { ScheduleMutationProposal } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  ApprovalPublicationNotAnchoredError,
  requireAnchoredPublication,
} from '../domains/approval-hub/requireAnchoredPublication.js';
import {
  type ScheduleMutationProposalStore,
  ScheduleMutationProposalStoreError,
} from '../infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { notifyTaskDeleted, notifyTaskRegistered } from '../infrastructure/scheduler/schedule-notify.js';
import type { TaskRunnerV2 } from '../infrastructure/scheduler/TaskRunnerV2.js';
import type { TaskTemplate } from '../infrastructure/scheduler/templates/types.js';
import type { ScheduleLifecycleNotifier } from '../infrastructure/scheduler/types.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requirePrivilegedRouteOwner } from '../utils/privileged-route-guard.js';

export interface ScheduleProposalDecisionOptions {
  ownerUserId: string;
  store: ScheduleMutationProposalStore;
  taskRunner: TaskRunnerV2;
  templateRegistry: { get(id: string): TaskTemplate | null };
  socketManager: SocketManager;
  notifyLifecycle?: ScheduleLifecycleNotifier;
}

export const scheduleProposalDecisionRoutes: FastifyPluginAsync<ScheduleProposalDecisionOptions> = async (
  app,
  opts,
) => {
  app.get('/api/schedule-proposals/:proposalId', async (request, reply) => {
    const access = resolveAccess(request, reply, opts);
    if (!access) return;
    return { proposal: access.proposal };
  });

  app.post('/api/schedule-proposals/:proposalId/approve', async (request, reply) => {
    const access = resolveAccess(request, reply, opts);
    if (!access) return;
    const anchored = await guardAnchored(access, reply, opts.store);
    if (!anchored) return;

    let proposal = access.proposal;
    if (proposal.status === 'pending') {
      const claimed = opts.store.claimForApproval(proposal.proposalId, Date.now());
      if (!claimed) return conflict(reply, proposal.status);
      proposal = claimed;
    } else if (proposal.status !== 'applying') {
      return conflict(reply, proposal.status);
    }

    try {
      if (proposal.mutation.kind === 'create') {
        const effect = opts.store.applyCreateEffect(proposal.proposalId, Date.now());
        const template = opts.templateRegistry.get(effect.task.templateId);
        if (!template) {
          reply.status(500);
          return { error: `Template ${effect.task.templateId} not found — approval remains recoverable` };
        }
        if (!opts.taskRunner.getTaskSummaries().some((task) => task.id === effect.task.id)) {
          const spec = template.createSpec(effect.task.id, {
            trigger: effect.task.trigger,
            params: effect.task.params,
            deliveryThreadId: effect.task.deliveryThreadId,
          });
          spec.display = effect.task.display;
          opts.taskRunner.registerDynamic(spec, effect.task.id);
        }
        if (effect.applied) notifyTaskRegistered(opts.notifyLifecycle, effect.task);
      } else {
        const effect = opts.store.applyDeleteEffect(proposal.proposalId, Date.now());
        opts.taskRunner.unregister(effect.task.id);
        if (effect.applied) notifyTaskDeleted(opts.notifyLifecycle, effect.task);
      }
    } catch (error) {
      if (error instanceof ScheduleMutationProposalStoreError) {
        reply.status(error.statusCode);
        return { error: error.message, code: error.code };
      }
      throw error;
    }

    const approved = opts.store.finalizeApproved(proposal.proposalId, access.userId, Date.now());
    if (!approved) return conflict(reply, opts.store.getById(proposal.proposalId)?.status ?? proposal.status);
    opts.socketManager.emitToUser(access.userId, 'proposal_updated', approved);
    return { proposalId: approved.proposalId, status: approved.status };
  });

  app.post('/api/schedule-proposals/:proposalId/reject', async (request, reply) => {
    const access = resolveAccess(request, reply, opts);
    if (!access) return;
    const anchored = await guardAnchored(access, reply, opts.store);
    if (!anchored) return;
    if (access.proposal.status !== 'pending') return conflict(reply, access.proposal.status);
    const body = (request.body ?? {}) as { rejectionReason?: unknown };
    if (body.rejectionReason !== undefined && typeof body.rejectionReason !== 'string') {
      reply.status(400);
      return { error: 'rejectionReason must be a string' };
    }
    const rejected = opts.store.reject(
      access.proposal.proposalId,
      access.userId,
      typeof body.rejectionReason === 'string' ? body.rejectionReason.trim() : '',
      Date.now(),
    );
    if (!rejected) return conflict(reply, access.proposal.status);
    opts.socketManager.emitToUser(access.userId, 'proposal_updated', rejected);
    return { proposalId: rejected.proposalId, status: rejected.status };
  });
};

interface DecisionAccess {
  userId: string;
  proposal: ScheduleMutationProposal;
}

function resolveAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: Pick<ScheduleProposalDecisionOptions, 'ownerUserId' | 'store'>,
): DecisionAccess | null {
  const ownerGate = requirePrivilegedRouteOwner(request, reply, {
    surface: 'Schedule proposal decisions',
    ownerErrorMessage: 'Schedule proposal decisions can only be accessed by the configured owner',
  });
  if (!ownerGate.ok) {
    reply.send(ownerGate.response);
    return null;
  }
  const userId = ownerGate.userId;
  if (userId !== opts.ownerUserId) {
    reply.status(403).send({ error: 'Schedule proposal does not belong to the authenticated owner' });
    return null;
  }
  const { proposalId } = request.params as { proposalId?: string };
  if (!proposalId || proposalId.length > 200) {
    reply.status(400).send({ error: 'Invalid proposalId' });
    return null;
  }
  const proposal = opts.store.getById(proposalId);
  if (!proposal) {
    reply.status(404).send({ error: 'Schedule proposal not found' });
    return null;
  }
  if (proposal.ownerUserId !== userId) {
    reply.status(403).send({ error: 'Schedule proposal does not belong to the authenticated owner' });
    return null;
  }
  return { userId, proposal };
}

async function guardAnchored(
  access: DecisionAccess,
  reply: FastifyReply,
  store: ScheduleMutationProposalStore,
): Promise<boolean> {
  try {
    await requireAnchoredPublication(store, access.proposal.proposalId);
    return true;
  } catch (error) {
    if (error instanceof ApprovalPublicationNotAnchoredError) {
      reply.status(409).send({ error: error.message, code: error.code });
      return false;
    }
    throw error;
  }
}

function conflict(reply: FastifyReply, status: ScheduleMutationProposal['status']) {
  reply.status(409);
  return { error: `Schedule proposal is already ${status}`, status };
}
