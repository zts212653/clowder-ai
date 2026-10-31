/**
 * F260 Phase A T2: Entity proposal decision routes (user-auth approve / reject).
 *
 * Approve flow — claim/upsert/finalize with rollback:
 *   1. Validate proposal exists and belongs to user
 *   2. CAS claim: store.markApproved() — pending→approved (blocks concurrent reject)
 *   3. entityRegistry.upsert() — write entity with stance/visibilityScope/status
 *   4. On upsert failure: store.revertToPending() — rollback to pending (user can retry)
 *
 * Ordering rationale (Blocker 2 fix):
 *   - CAS first prevents race: concurrent reject can't win between upsert and mark.
 *   - If upsert fails after CAS: revert to pending (no orphaned "approved but unregistered").
 *   - If CAS + upsert both succeed: clean state, entity carries proposal stance/visibility (KD-7).
 *
 * The proposal provenance is tagged with source='proposal' so INV-5
 * (entity-seeds.ts) can skip these entities during seed reload.
 */

import {
  ENTITY_CONFLICT_RESOLUTION_ACTIONS,
  type EntityConflictContext,
  type EntityConflictResolutionRequest,
  type EntityProposal,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApprovalPublicationNotAnchoredError,
  requireAnchoredPublication,
} from '../domains/approval-hub/requireAnchoredPublication.js';
import type { IEntityProposalStore } from '../domains/approval-hub/stores/ports/IEntityProposalStore.js';
import {
  EntityConflictInvalidResolutionError,
  EntityConflictStaleError,
  EntitySurfaceConflictError,
} from '../domains/memory/EntityRegistry.js';
import type { EntityMutationContext, EntityProvenance, EntityRecord } from '../domains/memory/interfaces.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const paramsSchema = z.object({ proposalId: z.string().min(1).max(200) });
const rejectBodySchema = z.object({ rejectionReason: z.string().trim().min(1).max(500).optional() }).strict();
const resolveBodySchema = z
  .object({
    action: z.enum(ENTITY_CONFLICT_RESOLUTION_ACTIONS),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    replacementCanonicalNames: z.record(z.string().trim().min(1).max(200)).optional(),
  })
  .strict();

export interface EntityProposalDecisionDeps {
  store: IEntityProposalStore;
  /** upsertEntities: typically SqliteEvidenceStore.upsertEntities (wraps EntityRegistry.upsert). */
  upsertEntities: (entities: EntityRecord[], context?: EntityMutationContext) => void | Promise<void>;
  inspectEntityConflict: (
    incoming: EntityRecord,
    viewerUserId?: string,
  ) => EntityConflictContext | null | Promise<EntityConflictContext | null>;
  resolveEntityConflict: (
    incoming: EntityRecord,
    resolution: EntityConflictResolutionRequest,
    context: EntityMutationContext,
  ) => void | Promise<void>;
  socketManager: Pick<SocketManager, 'emitToUser'>;
}

/** Shared validation: parse params, resolve userId, fetch proposal, check ownership. */
async function validateProposalAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  store: IEntityProposalStore,
): Promise<{ userId: string; proposal: EntityProposal } | null> {
  const params = paramsSchema.safeParse(request.params);
  if (!params.success) {
    reply.status(400);
    reply.send({ error: 'Invalid proposalId' });
    return null;
  }
  const userId = resolveStrictUserId(request);
  if (!userId) {
    reply.status(401);
    reply.send({ error: 'Identity required (X-Cat-Cafe-User header or userId query)' });
    return null;
  }
  const proposal = await store.get(params.data.proposalId);
  if (!proposal) {
    reply.status(404);
    reply.send({ error: 'Proposal not found' });
    return null;
  }
  if (proposal.ownerUserId !== userId) {
    reply.status(403);
    reply.send({ error: 'Proposal does not belong to the current user' });
    return null;
  }
  return { userId, proposal };
}

/** Convert proposal provenance to EntityRecord provenance + proposal tag for INV-5. */
export function buildEntityRecord(proposal: EntityProposal, userId: string): EntityRecord {
  return {
    entityId: proposal.entityId,
    type: proposal.entityType as EntityRecord['type'],
    canonicalName: proposal.canonicalName,
    aliases: proposal.aliases,
    /** KD-7: carry stance/visibilityScope from proposal — private entities must not become workspace. */
    stance: proposal.stance,
    visibilityScope: proposal.visibilityScope,
    status: 'active',
    provenance: [
      ...proposal.provenance.map(
        (p): EntityProvenance => ({
          source: p.source,
          ...(p.anchor ? { anchor: p.anchor } : {}),
          ...(p.note ? { note: p.note } : {}),
          ...(p.date ? { date: p.date } : {}),
        }),
      ),
      {
        source: 'proposal',
        anchor: proposal.proposalId,
        note: `Approved via Hub by ${userId}`,
        date: new Date().toISOString().slice(0, 10),
      },
      // Structured birth-thread provenance (codex review R2: anchor, not note)
      {
        source: 'callback-thread',
        anchor: proposal.sourceThreadId,
        note: `Entity proposal birth thread`,
        date: new Date().toISOString().slice(0, 10),
      },
    ],
    updatedAt: new Date().toISOString(),
  };
}

async function replyConflictResolutionFailure(
  app: FastifyInstance,
  reply: FastifyReply,
  store: IEntityProposalStore,
  proposalId: string,
  err: unknown,
) {
  await store.revertToPending(proposalId);
  if (err instanceof EntityConflictStaleError) {
    app.log.warn({ err, proposalId }, 'F260: stale conflict decision — reverting approval');
    reply.status(409);
    return { error: 'entity_conflict_stale', message: err.message, conflict: err.conflict };
  }
  if (err instanceof EntityConflictInvalidResolutionError) {
    app.log.warn({ err, proposalId }, 'F260: invalid conflict decision — reverting approval');
    reply.status(422);
    return { error: 'entity_conflict_invalid_resolution', message: err.message, conflict: err.conflict };
  }
  app.log.error({ err, proposalId }, 'F260: conflict resolution failed — reverting approval');
  reply.status(500);
  return { error: 'Entity conflict resolution failed — proposal reverted to pending, retry later' };
}

export function registerEntityProposalDecisionRoutes(app: FastifyInstance, deps: EntityProposalDecisionDeps): void {
  const { store, upsertEntities, inspectEntityConflict, resolveEntityConflict, socketManager } = deps;

  app.post('/api/entity-proposals/:proposalId/approve', async (request, reply) => {
    const access = await validateProposalAccess(request, reply, store);
    if (!access) return;
    const { userId, proposal } = access;

    if (proposal.status !== 'pending') {
      reply.status(409);
      return { error: `Proposal already ${proposal.status}`, status: proposal.status };
    }

    // F246 Phase I (INV-I5): anchored publication guard.
    try {
      await requireAnchoredPublication(store, proposal.proposalId);
    } catch (err) {
      if (err instanceof ApprovalPublicationNotAnchoredError) {
        reply.status(err.statusCode);
        return { error: err.message, code: err.code };
      }
      throw err;
    }

    const incoming = buildEntityRecord(proposal, userId);

    // Step 1: CAS claim — pending → approved.
    // This prevents concurrent reject from racing: if reject wins first, this CAS fails.
    const approved = await store.markApproved(proposal.proposalId, userId);
    if (!approved) {
      reply.status(409);
      return { error: 'Proposal status changed concurrently', status: proposal.status };
    }

    // Step 2: Upsert entity into registry.
    // If this fails, rollback the approval so user can retry.
    try {
      await upsertEntities([incoming], {
        source: 'proposal-approval',
        actorId: userId,
        proposalId: proposal.proposalId,
        reason: proposal.rationale,
        conflictPolicy: 'reject-conflict',
      });
    } catch (err) {
      await store.revertToPending(proposal.proposalId);
      if (err instanceof EntitySurfaceConflictError) {
        app.log.warn({ err, proposalId: proposal.proposalId }, 'F260: entity conflict — reverting approval');
        const conflict = await inspectEntityConflict(incoming, userId);
        reply.status(409);
        return {
          error: 'entity_surface_conflict',
          message: 'Entity registration conflicts with current workspace registry truth',
          incomingEntityId: err.incomingEntityId,
          conflictingEntityIds: conflict?.candidates.map(({ entityId }) => entityId) ?? [],
          conflictingSurfaces: conflict?.conflictingSurfaces ?? [],
          reason: conflict?.reason ?? err.reason,
          conflict,
        };
      }
      app.log.error({ err, proposalId: proposal.proposalId }, 'F260: entity upsert failed — reverting approval');
      reply.status(500);
      return { error: 'Entity registration failed — proposal reverted to pending, retry later' };
    }

    socketManager.emitToUser(userId, 'proposal_updated', approved);
    return { proposalId: approved.proposalId, status: approved.status, entityId: approved.entityId };
  });

  app.post('/api/entity-proposals/:proposalId/resolve', async (request, reply) => {
    const access = await validateProposalAccess(request, reply, store);
    if (!access) return;
    const { userId, proposal } = access;
    if (proposal.status !== 'pending') {
      reply.status(409);
      return { error: `Proposal already ${proposal.status}`, status: proposal.status };
    }

    const body = resolveBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: body.error.issues };
    }

    // F246 Phase I (INV-I5): anchored publication guard.
    try {
      await requireAnchoredPublication(store, proposal.proposalId);
    } catch (err) {
      if (err instanceof ApprovalPublicationNotAnchoredError) {
        reply.status(err.statusCode);
        return { error: err.message, code: err.code };
      }
      throw err;
    }

    const approved = await store.markApproved(proposal.proposalId, userId);
    if (!approved) {
      reply.status(409);
      return { error: 'Proposal status changed concurrently', status: proposal.status };
    }

    try {
      await resolveEntityConflict(buildEntityRecord(proposal, userId), body.data, {
        source: 'proposal-approval',
        actorId: userId,
        proposalId: proposal.proposalId,
        reason: proposal.rationale,
      });
    } catch (err) {
      return replyConflictResolutionFailure(app, reply, store, proposal.proposalId, err);
    }

    socketManager.emitToUser(userId, 'proposal_updated', approved);
    return { proposalId: approved.proposalId, status: approved.status, entityId: approved.entityId };
  });

  app.post('/api/entity-proposals/:proposalId/reject', async (request, reply) => {
    const access = await validateProposalAccess(request, reply, store);
    if (!access) return;
    const { userId, proposal } = access;

    const body = rejectBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: body.error.issues };
    }
    if (proposal.status === 'approved') {
      reply.status(409);
      return { error: 'Proposal already approved', status: 'approved' };
    }
    if (proposal.status === 'rejected') {
      return { proposalId: proposal.proposalId, status: proposal.status, deduped: true };
    }

    // F246 Phase I (INV-I5): anchored publication guard.
    try {
      await requireAnchoredPublication(store, proposal.proposalId);
    } catch (err) {
      if (err instanceof ApprovalPublicationNotAnchoredError) {
        reply.status(err.statusCode);
        return { error: err.message, code: err.code };
      }
      throw err;
    }

    const marked = await store.markRejected(proposal.proposalId, userId, body.data.rejectionReason);
    if (!marked) {
      reply.status(409);
      return { error: 'Proposal status changed concurrently — retry reject', status: proposal.status };
    }
    socketManager.emitToUser(userId, 'proposal_updated', marked);
    return { proposalId: marked.proposalId, status: marked.status };
  });
}
