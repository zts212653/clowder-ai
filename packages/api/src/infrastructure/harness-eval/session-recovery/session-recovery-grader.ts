import type { SessionRecoveryTrial, SessionRecoveryTrialGrade } from './session-recovery-types.js';

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
    semantic,
    stateReconstruction: assessment?.stateReconstruction ?? 'unknown',
    firstMeaningfulAction: assessment?.firstMeaningfulAction ?? 'unknown',
    outcome: assessment?.outcome ?? 'unknown',
  };
}

export function summarizeSessionRecoveryTrials(trials: SessionRecoveryTrial[]): {
  total: number;
  semanticPass: number;
  semanticFail: number;
  semanticUnknown: number;
} {
  const summary = {
    total: trials.length,
    semanticPass: 0,
    semanticFail: 0,
    semanticUnknown: 0,
  };
  for (const trial of trials) {
    const grade = gradeSessionRecoveryTrial(trial);
    if (grade.semantic === 'pass') summary.semanticPass++;
    else if (grade.semantic === 'fail') summary.semanticFail++;
    else summary.semanticUnknown++;
  }
  return summary;
}
