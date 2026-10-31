import type { SessionPolicySnapshot } from '@cat-cafe/shared';
import { getSessionStrategyWithSource } from '../../../../../config/session-strategy.js';
import { resolveSessionExecutionStatus } from '../context-lifecycle-capability.js';
import type { InvocationCapacitySnapshot } from './invocation-capacity-snapshot.js';

export interface ManagedSessionPolicyEvidence {
  capacitySnapshot: InvocationCapacitySnapshot | undefined;
  authoritativeUsage: boolean;
  sessionRotation: boolean;
  continuityBootstrap: boolean;
}

/**
 * Resolve or refine one managed invocation policy snapshot. Supplying `base`
 * keeps policy identity immutable while capability evidence is refined.
 */
export function resolveManagedSessionPolicySnapshot(options: {
  catId: string;
  evidence: ManagedSessionPolicyEvidence;
  base?: SessionPolicySnapshot;
}): SessionPolicySnapshot {
  const { evidence } = options;
  const resolved =
    options.base ??
    (() => {
      const policy = getSessionStrategyWithSource(options.catId);
      return {
        config: policy.effective,
        source: policy.source,
        revision: policy.revision,
        changedAt: policy.changedAt,
        execution: { status: 'unavailable' as const, missingCapabilities: [] },
      };
    })();
  const snapshot = evidence.capacitySnapshot;
  const capacity = snapshot?.capacity;
  const binding = snapshot?.binding;
  const carrierBinding = Boolean(
    snapshot &&
      capacity?.actionable &&
      (capacity.source === 'reported' ||
        (binding && binding.model === snapshot.model && binding.windowTokens === capacity.windowTokens)),
  );
  return {
    ...resolved,
    execution: resolveSessionExecutionStatus(resolved.config.strategy, {
      managedInvocationBoundary: true,
      effectiveInputCeiling: Boolean(
        capacity?.actionable && capacity.source !== 'unresolved' && capacity.inputCeilingTokens > 0,
      ),
      carrierBinding,
      authoritativeUsage: evidence.authoritativeUsage,
      sessionRotation: evidence.sessionRotation,
      continuityBootstrap: evidence.continuityBootstrap,
      observesCompression: snapshot?.capability.observesCompression ?? false,
    }),
  };
}
