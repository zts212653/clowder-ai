import {
  MICRODUCK_CONTROL_CANDIDATE_ORDER,
  MICRODUCK_CONTROL_SUBJECT_ORDER,
  type MicroduckControlCandidateId,
  type MicroduckControlEvaluation,
  type MicroduckControlEvaluationReceipt,
  type MicroduckControlMetrics,
} from './microduck-control-evaluation-schemas.js';

export function isMeasuredControlEvaluation(
  value: MicroduckControlEvaluation | undefined,
): value is MicroduckControlEvaluation & { metrics: MicroduckControlMetrics } {
  return Boolean(
    value &&
      (value.status === 'passed' || value.status === 'failed') &&
      value.sampleCount !== null &&
      value.sampleCount >= 8 &&
      value.captureRef !== null &&
      value.metrics !== null &&
      value.refusal === null,
  );
}

function decision(candidate: MicroduckControlMetrics, control: MicroduckControlMetrics) {
  const primaryDelta = candidate.meanForwardDistanceM.estimate - control.meanForwardDistanceM.estimate;
  const primaryThreshold =
    2 * Math.hypot(candidate.meanForwardDistanceM.standardError, control.meanForwardDistanceM.standardError);
  const guardrailDelta = candidate.survivalRate.estimate - control.survivalRate.estimate;
  const primarySignal = primaryDelta > primaryThreshold;
  const guardrailPass = guardrailDelta >= 0;
  return {
    primaryDelta,
    primaryThreshold,
    guardrailDelta,
    primarySignal,
    guardrailPass,
    eligible: primarySignal && guardrailPass,
  };
}

const approximately = (left: number, right: number): boolean => Math.abs(left - right) <= 1e-12;

export function selectedPublicControlSubject(
  receipt: MicroduckControlEvaluationReceipt,
): MicroduckControlCandidateId | null | undefined {
  const control = receipt.subjects[1]?.evaluations[0];
  if (!isMeasuredControlEvaluation(control) || !receipt.publicDecision) return undefined;
  const computed = receipt.subjects.slice(2).map((subject) => {
    const evaluation = subject.evaluations[0];
    return isMeasuredControlEvaluation(evaluation)
      ? { subjectId: subject.id as MicroduckControlCandidateId, ...decision(evaluation.metrics, control.metrics) }
      : undefined;
  });
  if (computed.some((entry) => !entry)) return undefined;
  const entries = computed.filter((entry) => entry !== undefined);
  if (
    entries.some((entry, index) => {
      const claimed = receipt.publicDecision?.candidates[index];
      return (
        !claimed ||
        claimed.subjectId !== entry.subjectId ||
        claimed.eligible !== entry.eligible ||
        claimed.primarySignal !== entry.primarySignal ||
        claimed.guardrailPass !== entry.guardrailPass ||
        !approximately(claimed.primaryDelta, entry.primaryDelta) ||
        !approximately(claimed.primaryThreshold, entry.primaryThreshold) ||
        !approximately(claimed.guardrailDelta, entry.guardrailDelta)
      );
    })
  ) {
    return undefined;
  }
  const eligible = entries
    .filter((entry) => entry.eligible)
    .sort(
      (left, right) =>
        right.primaryDelta - left.primaryDelta ||
        MICRODUCK_CONTROL_SUBJECT_ORDER.indexOf(left.subjectId) -
          MICRODUCK_CONTROL_SUBJECT_ORDER.indexOf(right.subjectId),
    );
  const selected = eligible[0]?.subjectId ?? null;
  const outcome = selected ? 'candidate_preselected_for_holdout' : 'no_measured_improvement';
  return receipt.publicDecision.selectedSubjectId === selected && receipt.publicDecision.outcome === outcome
    ? selected
    : undefined;
}

export function selectedControlSubjectPassesHoldout(
  receipt: MicroduckControlEvaluationReceipt,
  selectedSubjectId: MicroduckControlCandidateId,
): boolean {
  const control = receipt.subjects[1]?.evaluations[1];
  const winner = receipt.subjects.find((subject) => subject.id === selectedSubjectId)?.evaluations[1];
  return (
    isMeasuredControlEvaluation(control) &&
    isMeasuredControlEvaluation(winner) &&
    decision(winner.metrics, control.metrics).eligible
  );
}

export const isMicroduckControlCandidateId = (value: string): value is MicroduckControlCandidateId =>
  MICRODUCK_CONTROL_CANDIDATE_ORDER.some((candidate) => candidate === value);
