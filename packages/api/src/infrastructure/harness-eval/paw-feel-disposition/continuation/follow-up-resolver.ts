import type {
  PawFeelContinuationProjection,
  PawFeelDispositionProjection,
  PawFeelIssueProjection,
} from '@cat-cafe/shared';
import type { VerifiedPawFeelSourceIdentityContext } from '../direct-repair/direct-repair-source.js';
import { derivePawFeelIssue } from '../projection/read-model-issue.js';
import {
  type PawFeelDirectRepairBindingStatusResolver,
  type PawFeelRepairProgressResolver,
  resolvePawFeelRepairFollowUp,
} from './follow-up-repair.js';

export type { PawFeelRepairProgress } from './follow-up-repair.js';

export type PawFeelSourceCaseFollowUp =
  | {
      resolution: 'resolved';
      resolvedAt: string;
      continuation: PawFeelContinuationProjection;
    }
  | {
      resolution: 'open';
      continuation: PawFeelContinuationProjection;
      resumeAt?: string;
    };

export interface PawFeelContinuingResponsibilityResolverOptions {
  repairProgressResolver?: PawFeelRepairProgressResolver;
  directRepairBindingResolver?: PawFeelDirectRepairBindingStatusResolver;
  sourceCaseResolver?: PawFeelSourceCaseResolver;
}

export interface PawFeelSourceCaseResolver {
  resolveFollowUp(input: {
    projection: PawFeelDispositionProjection;
    source?: VerifiedPawFeelSourceIdentityContext;
  }): Promise<PawFeelSourceCaseFollowUp | null>;
  snapshot?(): PawFeelSourceCaseResolver;
}

export interface PawFeelFollowUpResolveInput {
  projection: PawFeelDispositionProjection;
  projectionsBySignalId: ReadonlyMap<string, PawFeelDispositionProjection>;
  sourceIdentitiesBySignalId?: ReadonlyMap<string, VerifiedPawFeelSourceIdentityContext>;
  nowMs: number;
}

function withCanonicalSignal(
  continuation: PawFeelContinuationProjection,
  canonicalSignalId: string,
): PawFeelContinuationProjection {
  const ultimateCanonicalSignalId = continuation.canonicalSignalId ?? canonicalSignalId;
  return {
    ...continuation,
    canonicalSignalId: ultimateCanonicalSignalId,
    evidenceRefs: [...new Set([canonicalSignalId, ultimateCanonicalSignalId, ...continuation.evidenceRefs])],
  };
}

export class PawFeelContinuingResponsibilityResolver {
  constructor(private readonly options: PawFeelContinuingResponsibilityResolverOptions = {}) {}

  snapshot(): PawFeelContinuingResponsibilityResolver {
    const sourceCaseResolver = this.options.sourceCaseResolver;
    return new PawFeelContinuingResponsibilityResolver({
      ...(this.options.repairProgressResolver ? { repairProgressResolver: this.options.repairProgressResolver } : {}),
      ...(this.options.directRepairBindingResolver
        ? { directRepairBindingResolver: this.options.directRepairBindingResolver }
        : {}),
      ...(sourceCaseResolver ? { sourceCaseResolver: sourceCaseResolver.snapshot?.() ?? sourceCaseResolver } : {}),
    });
  }

  async resolve(input: PawFeelFollowUpResolveInput): Promise<PawFeelIssueProjection> {
    return this.resolveProjection(
      input.projection,
      input.projectionsBySignalId,
      input.sourceIdentitiesBySignalId,
      input.nowMs,
      new Set(),
    );
  }

  private async resolveProjection(
    projection: PawFeelDispositionProjection,
    projections: ReadonlyMap<string, PawFeelDispositionProjection>,
    sourceIdentities: ReadonlyMap<string, VerifiedPawFeelSourceIdentityContext> | undefined,
    nowMs: number,
    visited: Set<string>,
  ): Promise<PawFeelIssueProjection> {
    const base = derivePawFeelIssue(projection, nowMs);
    if (base.resolution === 'resolved') return base;
    if (visited.has(projection.signalId)) return this.duplicateCycle(projection, nowMs, visited);
    visited.add(projection.signalId);
    const duplicate = await this.followDuplicate(projection, projections, sourceIdentities, nowMs, visited);
    if (duplicate) return duplicate;
    const repair = await resolvePawFeelRepairFollowUp({
      projection,
      nowMs,
      base,
      progressResolver: this.options.repairProgressResolver,
      bindingResolver: this.options.directRepairBindingResolver,
    });
    if (repair) return repair;
    const caseJoin = await this.resolveCase(projection, sourceIdentities?.get(projection.signalId), nowMs);
    if (caseJoin) return caseJoin;
    return base;
  }

  private duplicateCycle(
    projection: PawFeelDispositionProjection,
    nowMs: number,
    visited: ReadonlySet<string>,
  ): PawFeelIssueProjection {
    return derivePawFeelIssue(projection, nowMs, {
      continuation: {
        kind: 'duplicate_following',
        evidenceRefs: [...visited, projection.signalId],
        canonicalSignalId: projection.signalId,
      },
    });
  }

  private async followDuplicate(
    projection: PawFeelDispositionProjection,
    projections: ReadonlyMap<string, PawFeelDispositionProjection>,
    sourceIdentities: ReadonlyMap<string, VerifiedPawFeelSourceIdentityContext> | undefined,
    nowMs: number,
    visited: Set<string>,
  ): Promise<PawFeelIssueProjection | undefined> {
    if (projection.state !== 'duplicate' || !projection.duplicateOf) return undefined;
    const canonical = projections.get(projection.duplicateOf);
    if (!canonical) return undefined;
    const followed = await this.resolveProjection(canonical, projections, sourceIdentities, nowMs, visited);
    return {
      ...followed,
      continuation: withCanonicalSignal(followed.continuation, canonical.signalId),
    };
  }

  private async resolveCase(
    projection: PawFeelDispositionProjection,
    source: VerifiedPawFeelSourceIdentityContext | undefined,
    nowMs: number,
  ): Promise<PawFeelIssueProjection | undefined> {
    if (!this.options.sourceCaseResolver) return undefined;
    try {
      const joined = await this.options.sourceCaseResolver.resolveFollowUp({
        projection,
        ...(source ? { source } : {}),
      });
      if (!joined) return undefined;
      if (joined.resolution === 'resolved') {
        return derivePawFeelIssue(projection, nowMs, {
          resolution: 'resolved',
          resolvedAt: joined.resolvedAt,
          continuation: joined.continuation,
        });
      }
      return derivePawFeelIssue(projection, nowMs, {
        continuation: joined.continuation,
        ...(joined.resumeAt ? { resumeAt: joined.resumeAt } : {}),
      });
    } catch {
      return derivePawFeelIssue(projection, nowMs, {
        continuation: { kind: 'analysis_stale', evidenceRefs: [projection.signalId] },
      });
    }
  }
}
