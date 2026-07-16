import { loadDomains } from '../hub/eval-hub-read-model.js';
import { generateSessionRecoveryLiveVerdict } from '../session-recovery/eval-session-recovery-live-verdict.js';
import type {
  SessionRecoveryAssessment,
  SessionRecoverySourceSelector,
  SessionRecoveryTrial,
} from '../session-recovery/session-recovery-types.js';
import type { VerdictGenerator } from './types.js';
import { isSessionRecoverySourceRefs, validateSessionRecoveryPublishSelector } from './validation.js';

interface SessionRecoveryTrialResolver {
  resolve(selector: SessionRecoverySourceSelector, scope: { ownerUserId: string }): Promise<SessionRecoveryTrial[]>;
}

export function createSessionRecoveryGeneratorAdapter(provider: SessionRecoveryTrialResolver): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    if (!isSessionRecoverySourceRefs(sourceRefs)) {
      const kind = (sourceRefs as { kind?: string }).kind;
      throw new Error(
        `session_recovery_adapter_wrong_kind: received sourceRefs with kind='${kind ?? '(omitted)'}'; expected 'session-recovery-window'`,
      );
    }
    const selectorError = validateSessionRecoveryPublishSelector(sourceRefs);
    if (selectorError) throw new Error(`invalid_source_ref: ${selectorError}`);
    if (!deps.ownerUserId) {
      throw new Error('owner_user_required: session-recovery publish requires ownerUserId');
    }

    const trials = await provider.resolve(sourceRefs, { ownerUserId: deps.ownerUserId });
    if (trials.length === 0) {
      throw new Error(
        `no_trials_in_window: session-recovery window=[${sourceRefs.windowStartMs},${sourceRefs.windowEndMs}) yielded zero trials`,
      );
    }
    assertResolvedAssessments(trials, sourceRefs.assessments ?? []);

    const domains = loadDomains(deps.harnessFeedbackRoot);
    const domain = domains.get(packet.domainId);
    if (!domain) throw new Error(`unknown_domain: ${packet.domainId} not in registry`);

    const artifact = generateSessionRecoveryLiveVerdict({
      verdictId: packet.id,
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      domain,
      selector: sourceRefs,
      trials,
      submittedPacket: packet,
    });
    return { verdictPath: artifact.path, bundleDir: artifact.bundleDir };
  };
}

function assertResolvedAssessments(
  trials: SessionRecoveryTrial[],
  submittedAssessments: SessionRecoveryAssessment[],
): void {
  const submittedByTrial = new Map(submittedAssessments.map((assessment) => [assessment.trialId, assessment]));
  const seen = new Set<string>();
  for (const trial of trials) {
    if (seen.has(trial.trialId)) {
      throw new Error(`duplicate_session_recovery_trial: ${trial.trialId}`);
    }
    seen.add(trial.trialId);
    const submitted = submittedByTrial.get(trial.trialId);
    if (!submitted || !trial.assessment) {
      throw new Error(`missing_session_recovery_assessment: ${trial.trialId}`);
    }
    assertAssessmentMatches(trial, submitted);
  }
  for (const trialId of submittedByTrial.keys()) {
    if (!seen.has(trialId)) throw new Error(`unknown assessment trial: ${trialId}`);
  }
}

function assertAssessmentMatches(trial: SessionRecoveryTrial, submitted: SessionRecoveryAssessment): void {
  const resolved = trial.assessment;
  if (!resolved) throw new Error(`missing_session_recovery_assessment: ${trial.trialId}`);
  const labelsMatch =
    resolved.stateReconstruction === submitted.stateReconstruction &&
    resolved.firstMeaningfulAction === submitted.firstMeaningfulAction &&
    resolved.outcome === submitted.outcome;
  const refsMatch =
    resolved.evidenceRefs.length === submitted.evidenceRefs.length &&
    resolved.evidenceRefs.every((ref, index) => ref === submitted.evidenceRefs[index]);
  if (!labelsMatch || !refsMatch || resolved.rationale !== submitted.rationale.trim()) {
    throw new Error(`session_recovery_assessment_mismatch: ${trial.trialId}`);
  }
  const allowedRefs = new Set(trial.evidenceRefs);
  for (const ref of submitted.evidenceRefs) {
    if (!allowedRefs.has(ref)) throw new Error(`foreign assessment evidence ref: ${ref}`);
  }
}
