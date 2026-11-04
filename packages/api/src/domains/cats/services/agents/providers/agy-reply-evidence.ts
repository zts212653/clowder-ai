import { classifyCliError } from '../../../../../utils/cli-diagnostics.js';
import type { AgyStepState } from './agy-stream-json-parser.js';

interface ReplyStep {
  readonly type: string;
  readonly state: AgyStepState;
  readonly text: string;
  readonly anonymousCompletion: boolean;
}

/** Reply delivery evidence is separate from operation identity and tool success. */
export function agyReplyEvidence(input: {
  steps: ReadonlyMap<number, ReplyStep>;
  lastStepIndex: number | null;
  finalText: string;
  deltaText: string;
  upstreamStatus: string | null;
  upstreamError: string | null;
  hasDeniedActions: boolean;
}) {
  const { lastStepIndex, finalText } = input;
  const steps = [...input.steps.entries()];
  const inputs = steps.filter(([, step]) => step.type === 'user_input' && step.state === 'DONE');
  const inputIndex = inputs.length === 1 ? inputs[0]?.[0] : undefined;
  const finalStep = lastStepIndex === null ? undefined : input.steps.get(lastStepIndex);
  // Preserve actual observation order; revisiting an earlier index is not completion.
  const finalStepIsLatest = lastStepIndex !== null && steps.every(([index]) => index <= lastStepIndex);
  const errorSteps = steps.filter(([, step]) => step.type === 'error_message');
  const errorsPrecedeCompletion =
    inputIndex !== undefined &&
    lastStepIndex !== null &&
    errorSteps.every(([index, step]) => step.state === 'DONE' && index > inputIndex && index < lastStepIndex);
  const completedCurrentStep =
    inputIndex !== undefined &&
    lastStepIndex !== null &&
    lastStepIndex > inputIndex &&
    finalStepIsLatest &&
    finalStep?.state === 'DONE' &&
    errorsPrecedeCompletion &&
    steps.every(([, step]) =>
      step.type === 'error_message'
        ? true
        : ['user_input', 'system_message', 'agent_response', 'tool', 'checkpoint'].includes(step.type) &&
          (step.type === 'tool' || step.state !== 'ERROR'),
    );
  const responseSteps = steps.filter(([, step]) => step.type === 'agent_response');
  const completedResponseText =
    responseSteps.at(-1)?.[0] === lastStepIndex &&
    responseSteps.every(
      ([index, step], n) =>
        step.state === 'DONE' && index > (responseSteps[n - 1]?.[0] ?? inputIndex ?? Number.POSITIVE_INFINITY),
    )
      ? responseSteps.map(([, step]) => step.text).join('')
      : null;
  const matchingResponse =
    finalStep?.type === 'agent_response' &&
    finalStep.text.trim().length > 0 &&
    completedResponseText?.trim() === finalText.trim();
  const completedResponseStep = completedCurrentStep && matchingResponse ? lastStepIndex : null;
  const completedCompactionStep = completedCurrentStep && finalStep?.type === 'checkpoint' ? lastStepIndex : null;

  // Natural boot62 source197: the CLI retained an earlier attempt's EOF alongside
  // a completed reply and an unidentified DONE. This only permits delivery with
  // explicit uncertainty; neither tool identity nor auth/replay authority follows.
  const errorClass = classifyCliError(input.upstreamError ?? '');
  const retainedAttemptEOF =
    input.upstreamStatus === 'ERROR' &&
    /^API error \(attempt [1-9]\d*\): [^\r\n]+: EOF$/.test(input.upstreamError ?? '') &&
    errorClass !== 'auth_failed' &&
    errorClass !== 'upstream_policy_reject' &&
    !input.hasDeniedActions &&
    errorSteps.length > 0 &&
    errorsPrecedeCompletion;
  const anonymousIndices = steps.filter(([, step]) => step.anonymousCompletion).map(([index]) => index);
  const anonymousReplyComplete =
    inputIndex !== undefined &&
    lastStepIndex !== null &&
    lastStepIndex > inputIndex &&
    finalStepIsLatest &&
    anonymousIndices.every((index) => index > inputIndex && index < lastStepIndex) &&
    finalStep?.state === 'DONE' &&
    matchingResponse &&
    input.deltaText.trim() === finalText.trim() &&
    steps.every(
      ([, step]) =>
        (step.state === 'DONE' || (step.type === 'tool' && step.state === 'ERROR')) &&
        (step.type !== 'error_message' || retainedAttemptEOF),
    );
  return {
    completedResponseStep,
    completedCompactionStep,
    recoveredErrorSteps:
      completedResponseStep !== null || completedCompactionStep !== null ? errorSteps.map(([index]) => index) : [],
    anonymousReplyComplete,
    retainedAttemptEOF,
  };
}
