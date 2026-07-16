import type { SessionRecord } from '@cat-cafe/shared';
import type {
  SessionRecoveryStructuralGrade,
  SessionRecoveryTrial,
  SessionRecoveryTrialGrade,
} from './session-recovery-types.js';

const SHA256_RECEIPT = /^sha256:[a-f0-9]{64}$/;

export function gradeSessionRecoveryStructure(input: {
  source: SessionRecord;
  explicitTargets: SessionRecord[];
  inferredTarget?: SessionRecord;
}): SessionRecoveryStructuralGrade {
  const { source, explicitTargets, inferredTarget } = input;
  if (explicitTargets.length > 1) {
    return {
      lineage: 'duplicate',
      transitionIntegrity: 'fail',
      delivery: 'unknown',
      issues: ['duplicate_targets'],
    };
  }
  const target = explicitTargets[0];
  if (!target) return gradeAbsentExplicitTarget(inferredTarget);
  return gradeExplicitTarget(source, target);
}

function gradeAbsentExplicitTarget(inferredTarget?: SessionRecord): SessionRecoveryStructuralGrade {
  if (inferredTarget) {
    return {
      lineage: 'legacy_unlinked',
      transitionIntegrity: 'unknown',
      delivery: inferredTarget.recoveryDelivery ? 'unknown' : 'missing_receipt',
      issues: ['legacy_unlinked_target'],
    };
  }
  return {
    lineage: 'missing',
    transitionIntegrity: 'fail',
    delivery: 'missing_target',
    issues: ['missing_target'],
  };
}

function gradeExplicitTarget(source: SessionRecord, target: SessionRecord): SessionRecoveryStructuralGrade {
  const structuralIssues = collectTargetIssues(source, target);
  const originIssues = collectOriginIssues(source, target);
  const deliveryGrade = gradeDelivery(source, target);
  const issues = [...structuralIssues, ...originIssues, ...deliveryGrade.issues];

  return {
    lineage: 'explicit',
    transitionIntegrity: issues.length === 0 ? 'pass' : 'fail',
    delivery: deliveryGrade.delivery,
    issues,
  };
}

function collectTargetIssues(source: SessionRecord, target: SessionRecord): string[] {
  const issues: string[] = [];
  if (source.status !== 'sealed' && source.status !== 'sealing') issues.push('source_not_sealed');
  if (target.threadId !== source.threadId || target.catId !== source.catId || target.userId !== source.userId) {
    issues.push('target_identity_mismatch');
  }
  if (target.seq !== source.seq + 1) issues.push('target_sequence_mismatch');
  if (!target.openedByInvocationId) issues.push('missing_opened_by_invocation');
  return issues;
}

function collectOriginIssues(source: SessionRecord, target: SessionRecord): string[] {
  const origin = target.continuationOrigin;
  if (!origin || origin.sourceSessionId !== source.id || origin.sourceSeq !== source.seq) return ['origin_mismatch'];
  const issues: string[] = [];
  if (origin.sealReason !== (source.sealReason ?? 'unknown')) issues.push('seal_reason_mismatch');
  if (origin.kind === 'cat_initiated_handoff') {
    if (!origin.proposalId) issues.push('missing_handoff_proposal');
    if (source.catHandoffNote?.proposalId && origin.proposalId !== source.catHandoffNote.proposalId) {
      issues.push('handoff_proposal_mismatch');
    }
  } else if (origin.proposalId) {
    issues.push('unexpected_handoff_proposal');
  }
  return issues;
}

function gradeDelivery(
  source: SessionRecord,
  target: SessionRecord,
): { delivery: SessionRecoveryStructuralGrade['delivery']; issues: string[] } {
  const receipt = target.recoveryDelivery;
  if (!receipt) return { delivery: 'missing_receipt', issues: [] };
  const issues: string[] = [];
  if (receipt.sourceSessionId !== source.id) issues.push('delivery_source_mismatch');
  if (receipt.bootstrapIncludedInPrompt !== true) issues.push('bootstrap_not_in_prompt');
  if (!SHA256_RECEIPT.test(receipt.bootstrapContentHash)) issues.push('invalid_bootstrap_hash');
  if (source.sealedAt !== undefined && receipt.providerDispatchAt < source.sealedAt) {
    issues.push('dispatch_before_source_seal');
  }
  if (target.createdAt < receipt.providerDispatchAt) issues.push('target_created_before_dispatch');
  const handoffExpected = target.continuationOrigin?.kind === 'cat_initiated_handoff';
  if (receipt.handoffNoteIncluded !== handoffExpected) issues.push('handoff_note_delivery_mismatch');
  return { delivery: issues.length === 0 ? 'provider_dispatched' : 'unknown', issues };
}

export function gradeSessionRecoveryTrial(trial: SessionRecoveryTrial): SessionRecoveryTrialGrade {
  const assessment = trial.assessment;
  let semantic: SessionRecoveryTrialGrade['semantic'] = 'unknown';
  if (assessment) {
    if (
      assessment.stateReconstruction === 'stale' ||
      assessment.firstMeaningfulAction === 'repeated' ||
      assessment.firstMeaningfulAction === 'misaligned' ||
      assessment.outcome === 'failed'
    ) {
      semantic = 'fail';
    } else if (
      assessment.stateReconstruction === 'recovered' &&
      assessment.firstMeaningfulAction === 'aligned' &&
      (assessment.outcome === 'continued' || assessment.outcome === 'completed')
    ) {
      semantic = 'pass';
    }
  }

  return {
    structural: trial.transitionIntegrity,
    semantic,
    stateReconstruction: assessment?.stateReconstruction ?? 'unknown',
    firstMeaningfulAction: assessment?.firstMeaningfulAction ?? 'unknown',
    outcome: assessment?.outcome ?? 'unknown',
    issues: [...trial.structuralIssues],
  };
}

export function summarizeSessionRecoveryTrials(trials: SessionRecoveryTrial[]): {
  total: number;
  structuralPass: number;
  structuralFail: number;
  structuralUnknown: number;
  semanticPass: number;
  semanticFail: number;
  semanticUnknown: number;
} {
  const summary = {
    total: trials.length,
    structuralPass: 0,
    structuralFail: 0,
    structuralUnknown: 0,
    semanticPass: 0,
    semanticFail: 0,
    semanticUnknown: 0,
  };
  for (const trial of trials) {
    const grade = gradeSessionRecoveryTrial(trial);
    if (grade.structural === 'pass') summary.structuralPass++;
    else if (grade.structural === 'fail') summary.structuralFail++;
    else summary.structuralUnknown++;
    if (grade.semantic === 'pass') summary.semanticPass++;
    else if (grade.semantic === 'fail') summary.semanticFail++;
    else summary.semanticUnknown++;
  }
  return summary;
}
