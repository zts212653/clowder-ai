import type { ExactAssetVersionRefV1 } from '@cat-cafe/shared';
import { refIdentity } from '@cat-cafe/shared';
import type {
  EvalRepairCaseAction,
  EvalRepairOwnerLineage,
} from '../../harness-eval/eval-repair-approval-contracts.js';
import type { EvalRepairApprovalRecord } from '../../harness-eval/eval-repair-approval-projection.js';
import {
  isRequestReviewAssetVersionRef,
  REQUEST_REVIEW_EVOLUTION_PROGRAM_ID,
  REQUEST_REVIEW_OWNER_FEATURE_ID,
  REQUEST_REVIEW_TARGET_STATE_REF,
} from '../adapters/request-review/request-review-owner-identity.js';

interface ResolverOptions {
  readBindings(): Promise<RequestReviewLineageBinding[]>;
  resolveCaseAction(caseActionRef: string): Promise<EvalRepairCaseAction | null>;
  versionReader: { currentVersionRef(): Promise<ExactAssetVersionRefV1> };
}

export interface RequestReviewLineageBinding {
  programRef: EvalRepairOwnerLineage['programRef'];
  cycleRef: EvalRepairOwnerLineage['cycleRef'];
  interventionRef: EvalRepairOwnerLineage['interventionRef'];
  assetVersionRef: ExactAssetVersionRefV1;
  caseActionRef: string;
}

type Resolution =
  | { status: 'resolved'; caseActionRef: string }
  | { status: 'blocked'; reason: 'lineage_missing' | 'lineage_ambiguous' | 'lineage_mismatch' };

export interface RequestReviewProposalScope {
  caseId: string;
  proposal: Pick<
    EvalRepairApprovalRecord['proposal'],
    'caseActionRef' | 'verdictId' | 'requestSnapshot' | 'ownerLineage'
  >;
}

function sameRef(left: unknown, right: unknown): boolean {
  try {
    return refIdentity(left as never) === refIdentity(right as never);
  } catch {
    return false;
  }
}

function actionMatches(action: EvalRepairCaseAction, version: string): boolean {
  return (
    action.analysisDisposition === 'repair' &&
    action.repairTarget.featureId === REQUEST_REVIEW_OWNER_FEATURE_ID &&
    action.repairTarget.componentId === REQUEST_REVIEW_TARGET_STATE_REF &&
    action.repairTarget.version === version
  );
}

function canonicalLineage(lineage: EvalRepairOwnerLineage): boolean {
  const cyclePrefix = `evolution-cycle:${REQUEST_REVIEW_EVOLUTION_PROGRAM_ID}:`;
  const cycle = lineage.cycleRef.ownerStateRef.slice(cyclePrefix.length);
  return (
    lineage.programRef.ownerFeatureId === 'F311' &&
    lineage.programRef.ownerStateRef === REQUEST_REVIEW_EVOLUTION_PROGRAM_ID &&
    lineage.cycleRef.ownerFeatureId === 'F311' &&
    lineage.cycleRef.ownerStateRef.startsWith(cyclePrefix) &&
    /^[1-9]\d*$/u.test(cycle) &&
    lineage.interventionRef.ownerFeatureId === REQUEST_REVIEW_OWNER_FEATURE_ID &&
    lineage.interventionRef.ownerStateRef === REQUEST_REVIEW_TARGET_STATE_REF
  );
}

export class RequestReviewLineageBindingResolver {
  constructor(private readonly options: ResolverOptions) {}

  private async resolveBinding(
    lineage: EvalRepairOwnerLineage,
    assetVersionRef: ExactAssetVersionRefV1,
    expected?: { caseActionRef: string; caseId: string; verdictId: string },
  ): Promise<Resolution> {
    if (!canonicalLineage(lineage) || !isRequestReviewAssetVersionRef(assetVersionRef)) {
      return { status: 'blocked', reason: 'lineage_mismatch' };
    }
    const bindings = await this.options.readBindings();
    const matches = bindings.filter(
      (binding) =>
        sameRef(binding.programRef, lineage.programRef) &&
        sameRef(binding.cycleRef, lineage.cycleRef) &&
        sameRef(binding.interventionRef, lineage.interventionRef) &&
        sameRef(binding.assetVersionRef, assetVersionRef) &&
        (expected === undefined || binding.caseActionRef === expected.caseActionRef),
    );
    if (matches.length === 0) return { status: 'blocked', reason: 'lineage_missing' };
    if (matches.length > 1) return { status: 'blocked', reason: 'lineage_ambiguous' };
    const action = await this.options.resolveCaseAction(matches[0].caseActionRef);
    if (
      !action ||
      !actionMatches(action, assetVersionRef.version) ||
      (expected !== undefined && (action.caseId !== expected.caseId || action.verdictId !== expected.verdictId))
    ) {
      return { status: 'blocked', reason: 'lineage_mismatch' };
    }
    return { status: 'resolved', caseActionRef: matches[0].caseActionRef };
  }

  async resolve(lineage: EvalRepairOwnerLineage): Promise<Resolution> {
    const current = await this.options.versionReader.currentVersionRef();
    return this.resolveBinding(lineage, current);
  }

  async resolveProposalScope(input: RequestReviewProposalScope): Promise<Resolution> {
    const lineage = input.proposal.ownerLineage;
    const targetVersionRef = input.proposal.requestSnapshot.targetVersionRef;
    if (!lineage) return { status: 'blocked', reason: 'lineage_mismatch' };
    return this.resolveBinding(lineage, targetVersionRef, {
      caseActionRef: input.proposal.caseActionRef,
      caseId: input.caseId,
      verdictId: input.proposal.verdictId,
    });
  }
}
