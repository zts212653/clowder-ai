import {
  type ApprovalHubItem,
  approvalProducerMeta,
  type EntityConflictContext,
  type EntityConflictResolutionRequest,
} from '@cat-cafe/shared';
import { ApprovalProvenanceLinks } from './ApprovalProvenanceLinks';
import { EntityConflictResolutionPanel } from './EntityConflictResolutionPanel';
import { HarnessGovernanceDecisionActions } from './HarnessGovernanceDecisionActions';
import { PersonMemoryClaimSelector } from './PersonMemoryClaimSelector';

export function GenericApprovalDecisionActions({
  item,
  isStale,
  isPersonMemoryClaimSelect,
  entityConflict,
  decidingState,
  onApprove,
  onReject,
  onEntityResolution,
  onHarnessDecision,
  onBeforeNavigate,
}: {
  item: ApprovalHubItem;
  isStale: boolean;
  isPersonMemoryClaimSelect: boolean;
  entityConflict?: EntityConflictContext;
  decidingState?: string;
  onApprove: () => void;
  onReject: () => void;
  onEntityResolution: (resolution: EntityConflictResolutionRequest) => void;
  onHarnessDecision: (action: 'approve' | 'skip' | 'reject', note?: string) => void;
  onBeforeNavigate: () => void;
}) {
  const originCardOwnsPendingDecision = approvalProducerMeta(item.sourceFeatureId).decisionSurface === 'origin_card';
  const canDecide = item.resolution === 'open';
  const isHarnessGovernance = item.sourceFeatureId === 'F257' && item.decisionMode === 'approve-skip-reject';
  if (canDecide && isHarnessGovernance) {
    return (
      <div className="space-y-2">
        <HarnessGovernanceDecisionActions decidingState={decidingState} onDecide={onHarnessDecision} />
        <ApprovalProvenanceLinks navigation={item.navigation} onBeforeNavigate={onBeforeNavigate} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {canDecide && entityConflict && (
        <EntityConflictResolutionPanel
          key={entityConflict.fingerprint}
          conflict={entityConflict}
          error={typeof item.detail.conflictError === 'string' ? item.detail.conflictError : undefined}
          deciding={Boolean(decidingState)}
          onResolve={onEntityResolution}
          onReject={onReject}
        />
      )}
      {canDecide && isPersonMemoryClaimSelect && <PersonMemoryClaimSelector item={item} onReject={onReject} />}
      {(!isPersonMemoryClaimSelect || !canDecide) && (
        <div className="flex flex-wrap items-center gap-2">
          {canDecide && item.inlineApprovable && !entityConflict && (
            <button
              type="button"
              onClick={onApprove}
              disabled={Boolean(decidingState)}
              className="rounded-md bg-[var(--semantic-success)] px-3 py-1 text-micro font-medium text-[var(--cafe-accent-foreground)] disabled:opacity-50"
              data-testid="approve-btn"
            >
              {decidingState === 'approving' ? '...' : '批准'}
            </button>
          )}
          {canDecide && !entityConflict && !originCardOwnsPendingDecision && (
            <button
              type="button"
              onClick={onReject}
              disabled={Boolean(decidingState)}
              className="rounded-md border border-cafe px-3 py-1 text-micro font-medium hover:bg-[var(--semantic-error)] hover:text-[var(--cafe-accent-foreground)] disabled:opacity-50"
              data-testid="reject-btn"
            >
              {decidingState === 'rejecting' ? '...' : isStale ? '清除' : '拒绝'}
            </button>
          )}
          <ApprovalProvenanceLinks navigation={item.navigation} onBeforeNavigate={onBeforeNavigate} />
        </div>
      )}
      {canDecide && isPersonMemoryClaimSelect && (
        <ApprovalProvenanceLinks navigation={item.navigation} onBeforeNavigate={onBeforeNavigate} />
      )}
    </div>
  );
}
