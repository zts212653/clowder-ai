/**
 * F24 / F296 / F117 K2: the seal a Claude PreCompact triggers.
 *
 * Shared by POST /api/sessions/seal, which the print carrier's f24-pre-compact.sh reaches through
 * callback auth, and by the Agent SDK carrier's in-process PreCompact hook. Both record this
 * invocation's compression observation, let the epoch owner see it, and apply the session policy.
 */

import type { ISessionSealer } from '../domains/cats/services/session/SessionSealer.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { createSessionCompactionSurface } from './session-compaction-surface.js';

export interface SessionSealDeps {
  readonly sessionChainStore: ISessionChainStore;
  readonly sessionSealer: ISessionSealer;
  readonly compactionSurface: Pick<
    ReturnType<typeof createSessionCompactionSurface>,
    'observeAuthoritativeCompaction' | 'compactContinuityFor'
  >;
}

/** What the route replies; the in-process hook only reads it. */
export interface SessionSealOutcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export type SealOnPreCompact = (
  invocationId: string,
  cliSessionId: string,
  reason: string,
) => Promise<SessionSealOutcome>;

export function createSealOnPreCompact(deps: SessionSealDeps): SealOnPreCompact {
  const { sessionChainStore, sessionSealer, compactionSurface } = deps;
  return async (invocationId, cliSessionId, reason) => {
    // Look up Clowder AI session by CLI session ID
    const record = await sessionChainStore.getByCliSessionId(cliSessionId);
    if (!record) {
      return { status: 404, body: { error: 'No session found for this CLI session ID' } };
    }

    if (record.status !== 'active') {
      return {
        status: 409,
        body: {
          error: `Session already ${record.status}`,
          sessionId: record.id,
          status: record.status,
        },
      };
    }

    // #1329: the hook consumes the policy snapshot owned by this managed
    // invocation. A config read here would let a mid-invocation settings edit
    // change the action family and would re-introduce the policy/capability bug.
    const policy = record.appliedPolicy;
    if (!policy) {
      return {
        status: 200,
        body: {
          action: 'no_action',
          sessionId: record.id,
          compressionCount: record.compressionCount,
          executionStatus: {
            status: 'unavailable',
            missingCapabilities: ['managed_invocation_boundary'],
          },
          contextEpoch: {
            status: 'unsupported',
            reason: 'managed_invocation_boundary_unavailable',
          },
        },
      };
    }

    // Atomically update lifetime telemetry (when its origin is known) and the
    // revision-scoped hybrid counter. A concurrent policy revision makes the
    // event stale instead of attributing it to the new epoch.
    const observed = await sessionChainStore.recordCompressionEvent(record.id, policy.revision, invocationId);
    if (!observed) {
      return {
        status: 409,
        body: { error: 'Session disappeared during compression observation (race)', sessionId: record.id },
      };
    }
    const updated = await sessionChainStore.get(record.id);
    const contextEpoch = updated
      ? await compactionSurface.observeAuthoritativeCompaction(updated, 'claude_precompact_hook')
      : { status: 'unsupported' as const, reason: 'session_record_unavailable' as const };

    if (!observed.revisionMatched) {
      return {
        status: 200,
        body: {
          action: 'no_action',
          reason: 'stale_policy_revision',
          sessionId: record.id,
          compressionCount: observed.compressionCount,
          strategy: policy.config.strategy,
          policyRevision: policy.revision,
          ...(updated?.appliedPolicy ? { activePolicyRevision: updated.appliedPolicy.revision } : {}),
          contextEpoch,
        },
      };
    }

    const strategy = policy.config;
    const canExecuteHandoff = policy.execution.status === 'active';
    const maxCompressions = strategy.hybrid?.maxCompressions ?? 2;
    const hybridCount = observed.hybridProgress?.observedCount ?? null;
    // PreCompact arrives before the pending compaction and the store records
    // that signal atomically before this decision. Count N is therefore the
    // Nth compaction to allow; only signal N+1 exhausts an N-compaction policy.
    const hybridShouldSeal =
      strategy.strategy === 'hybrid' && canExecuteHandoff && hybridCount !== null && hybridCount > maxCompressions;

    if (strategy.strategy === 'compress' || strategy.strategy === 'hybrid' || !canExecuteHandoff) {
      if (!hybridShouldSeal) {
        return {
          status: 200,
          body: {
            action: canExecuteHandoff || strategy.strategy === 'compress' ? 'compress_allowed' : 'no_action',
            sessionId: record.id,
            compressionCount: observed.compressionCount,
            hybridProgress: observed.hybridProgress,
            ...(strategy.strategy === 'hybrid' ? { maxCompressions } : {}),
            strategy: strategy.strategy,
            executionStatus: policy.execution,
            ...(updated ? { continuity: compactionSurface.compactContinuityFor(updated) } : {}),
            contextEpoch,
          },
        };
      }
    }

    // Hybrid only crosses into handoff after its active, revision-scoped count
    // is exhausted. Degraded hybrid always stays in its own action family.
    const sealReason = strategy.strategy === 'hybrid' ? 'max_compressions' : reason;

    const sealResult = await sessionSealer.requestSeal({
      sessionId: record.id,
      reason: sealReason,
      expectedPolicyRevision: policy.revision,
    });

    if (!sealResult.accepted) {
      if (sealResult.rejectionReason === 'policy_revision_mismatch') {
        const active = await sessionChainStore.get(record.id);
        return {
          status: 200,
          body: {
            action: 'no_action',
            reason: 'stale_policy_revision',
            sessionId: record.id,
            compressionCount: observed.compressionCount,
            strategy: policy.config.strategy,
            policyRevision: policy.revision,
            ...(active?.appliedPolicy ? { activePolicyRevision: active.appliedPolicy.revision } : {}),
          },
        };
      }
      return {
        status: 409,
        body: {
          error: 'Seal request not accepted (race condition)',
          sessionId: record.id,
          status: sealResult.status,
        },
      };
    }

    // Slow path: async transcript flush (fire-and-forget)
    sessionSealer.finalize({ sessionId: record.id }).catch(() => {
      /* best-effort: finalize failure logged internally */
    });

    return {
      status: 200,
      body: {
        sessionId: record.id,
        threadId: record.threadId,
        catId: record.catId,
        status: 'sealing',
        strategy: strategy.strategy,
        executionStatus: policy.execution,
        contextEpoch,
      },
    };
  };
}
