import type { SessionRecord } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import {
  completeCapsuleForCompact,
  isCollaborationContinuityCapsuleV1,
} from '../domains/cats/services/agents/invocation/CollaborationContinuityCapsule.js';
import type { PostCompactContextProjector } from '../domains/cats/services/agents/routing/post-compact-context-projector.js';
import {
  type AuthoritativeCompactionEventSource,
  authenticatedCompactionSequenceFromSession,
  authoritativeCompactionEventFromSession,
  resolveAuthoritativeCompactionSupport,
} from '../domains/cats/services/session/authoritative-compaction.js';
import type { ContextEpochOwner } from '../domains/cats/services/session/ContextEpochOwner.js';
import type { TranscriptReader } from '../domains/cats/services/session/TranscriptReader.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { AgentContextCapability } from '../domains/cats/services/types.js';

export interface SessionCompactionSurfaceDeps {
  sessionChainStore: ISessionChainStore;
  transcriptReader: TranscriptReader;
  contextEpochOwner?: Pick<ContextEpochOwner, 'observeCompaction'>;
  resolveContextCapability?: (catId: SessionRecord['catId']) => AgentContextCapability;
  postCompactContextProjector?: PostCompactContextProjector;
  /** Live invocation callback-auth readiness shared by route and provider consumers. */
  hookAuthenticationReady?: boolean | (() => boolean);
}

export function createSessionCompactionSurface(deps: SessionCompactionSurfaceDeps) {
  async function observeAuthoritativeCompaction(
    record: SessionRecord,
    eventSource: AuthoritativeCompactionEventSource,
  ) {
    if (!deps.contextEpochOwner || !deps.resolveContextCapability) {
      return { status: 'unsupported' as const, reason: 'epoch_owner_unavailable' as const };
    }
    const support = resolveAuthoritativeCompactionSupport({
      capability: deps.resolveContextCapability(record.catId),
      eventSource,
      hookAuthenticationReady:
        typeof deps.hookAuthenticationReady === 'function'
          ? deps.hookAuthenticationReady()
          : (deps.hookAuthenticationReady ?? false),
      // Reaching this authenticated route is the carrier proof. Provider-stream
      // boundaries use the active workspace filesystem predicate instead.
      hookCarrierReady: true,
      // The authenticated route records this atomically before asking the
      // epoch owner; replay routes consume the same durable observation.
      hookInvocationAttested: authenticatedCompactionSequenceFromSession(record) !== null,
    });
    if (support.status === 'unsupported') return support;
    const decision = await deps.contextEpochOwner.observeCompaction({
      userId: record.userId,
      catId: record.catId,
      threadId: record.threadId,
      event: authoritativeCompactionEventFromSession(record, eventSource),
    });
    return { status: 'observed' as const, decision };
  }

  async function projectPostCompact(record: SessionRecord) {
    const observation = await observeAuthoritativeCompaction(record, 'claude_precompact_hook');
    if (observation.status !== 'observed') return observation;
    if (!deps.postCompactContextProjector) {
      return { status: 'unsupported' as const, reason: 'post_compact_projector_unavailable' as const };
    }
    const projection = await deps.postCompactContextProjector({
      record,
      decision: {
        contextEpoch: observation.decision.contextEpoch,
        contextMode: 'cold',
        transition: observation.decision.transition,
      },
    });
    return {
      status: 'projected' as const,
      contextEpoch: observation.decision.contextEpoch,
      transition: observation.decision.transition,
      replayed: observation.decision.replayed,
      ...projection,
    };
  }

  function compactContinuityFor(record: SessionRecord) {
    const capsule = completeCapsuleForCompact(record.continuityCapsule, { createdAt: Date.now() });
    if (!capsule) return undefined;
    return {
      capsule,
      diagnostics: {
        source: 'active_session_route_state',
        boundary: 'compact_boundary',
        generated: true,
        threadId: record.threadId,
        catId: record.catId,
        sessionId: record.id,
        compressionCount: record.compressionCount,
      },
    };
  }

  function registerLatestDigestRoute(app: FastifyInstance): void {
    app.get<{
      Querystring: { cliSessionId?: string };
    }>('/api/sessions/latest-digest', async (request, reply) => {
      const { cliSessionId } = request.query;
      if (!cliSessionId) {
        reply.status(400);
        return { error: 'cliSessionId query parameter required' };
      }

      const record = await deps.sessionChainStore.getByCliSessionId(cliSessionId);
      if (!record) {
        reply.status(404);
        return { error: 'No session found for this CLI session ID' };
      }

      const hasObservedCompact =
        (record.compressionCount !== null && record.compressionCount > 0) ||
        (record.hybridProgress?.observedCount ?? 0) > 0;
      const activeCompactContinuity =
        record.status === 'active' && hasObservedCompact ? compactContinuityFor(record) : undefined;
      if (record.status === 'active' && hasObservedCompact) {
        const postCompact = await projectPostCompact(record);
        return reply.send({
          sessionId: record.id,
          status: record.status,
          seq: record.seq,
          catId: record.catId,
          threadId: record.threadId,
          digest: null,
          ...(activeCompactContinuity ? { continuity: activeCompactContinuity } : {}),
          postCompact,
        });
      }

      const postCompact = hasObservedCompact ? await projectPostCompact(record) : undefined;
      const chain = await deps.sessionChainStore.getChain(record.catId, record.threadId, record.userId);
      const sealedSessions = chain
        .filter((session) => session.status === 'sealed' && session.sealedAt != null)
        .sort((left, right) => (right.sealedAt ?? 0) - (left.sealedAt ?? 0));
      const latest = sealedSessions[0];

      if (!latest) {
        if (postCompact?.status === 'projected') {
          return reply.send({
            sessionId: record.id,
            status: record.status,
            seq: record.seq,
            catId: record.catId,
            threadId: record.threadId,
            digest: null,
            postCompact,
          });
        }
        reply.status(404);
        return { error: 'No sealed sessions found' };
      }

      const digest = await deps.transcriptReader.readDigest(latest.id, latest.threadId, latest.catId);
      if (!digest) {
        if (postCompact?.status === 'projected') {
          return reply.send({
            sessionId: latest.id,
            status: latest.status,
            seq: latest.seq,
            catId: latest.catId,
            threadId: latest.threadId,
            digest: null,
            postCompact,
          });
        }
        reply.status(404);
        return { error: 'Digest not found for latest sealed session' };
      }
      const sealedCapsule = isCollaborationContinuityCapsuleV1(digest.continuityCapsule)
        ? digest.continuityCapsule
        : undefined;

      return reply.send({
        sessionId: latest.id,
        seq: latest.seq,
        catId: latest.catId,
        threadId: latest.threadId,
        sealedAt: latest.sealedAt,
        digest,
        ...(postCompact ? { postCompact } : {}),
        ...(sealedCapsule
          ? {
              continuity: {
                capsule: sealedCapsule,
                diagnostics: {
                  source: 'sealed_session_digest',
                  boundary: sealedCapsule.continuationReason,
                  generated: true,
                  threadId: latest.threadId,
                  catId: latest.catId,
                  sessionId: latest.id,
                },
              },
            }
          : {}),
      });
    });
  }

  return { observeAuthoritativeCompaction, compactContinuityFor, registerLatestDigestRoute };
}
