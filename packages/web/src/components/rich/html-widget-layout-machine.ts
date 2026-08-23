export const WIDGET_SIZE_MESSAGE = 'cat-cafe:html-widget-size';
export const WIDGET_PROOF_REQUEST_MESSAGE = 'cat-cafe:html-widget-proof-request';
export const WIDGET_PROOF_REQUEST_EVENT = 'catcafe:html-widget-export-proof-request';

const MAX_MEASURED_HEIGHT = 100_000;
const MAX_PROOF_REQUEST_ID_LENGTH = 128;
const HEIGHT_FEEDBACK_EPSILON = 2;

export type WidgetHeightMessageResult =
  | { status: 'ignored' }
  | { status: 'invalid' }
  | { status: 'pending'; cause: WidgetLayoutInvalidation }
  | { status: 'valid'; sample: WidgetHeightSample; proofRequestId: string | null };

export type WidgetLayoutInvalidation = 'content' | 'viewport';

export function isValidWidgetProofRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_PROOF_REQUEST_ID_LENGTH &&
    /^[A-Za-z0-9:_-]+$/.test(value)
  );
}

export interface WidgetHeightSample {
  contentHeight: number;
  bodyScrollHeight: number;
  rootScrollHeight: number;
  hasUnmeasurableVisualOverflow: boolean;
  viewportHeight: number;
  viewportWidth: number;
}

export type WidgetHeightProof = 'content' | 'body-scroll-overflow' | 'root-scroll-overflow';

export interface WidgetLayoutMachineState {
  phase: 'pending' | 'ready' | 'error';
  acceptedHeight: number | null;
  proof: WidgetHeightProof | null;
  sample: WidgetHeightSample | null;
  viewportConfirmed: boolean;
  error: 'invalid-sample' | 'viewport-feedback' | 'unmeasurable-visual-overflow' | null;
}

export type WidgetLayoutEvent =
  | { type: 'pending'; cause: WidgetLayoutInvalidation }
  | { type: 'measured'; sample: WidgetHeightSample }
  | { type: 'invalid' }
  | { type: 'reset' };

export function createInitialWidgetLayoutState(): WidgetLayoutMachineState {
  return {
    phase: 'pending',
    acceptedHeight: null,
    proof: null,
    sample: null,
    viewportConfirmed: false,
    error: null,
  };
}

function resolveHeightCandidate(sample: WidgetHeightSample): { height: number; proof: WidgetHeightProof } {
  let candidate = { height: sample.contentHeight, proof: 'content' as WidgetHeightProof };
  const scrollCandidates: Array<{ height: number; proof: WidgetHeightProof }> = [
    { height: sample.bodyScrollHeight, proof: 'body-scroll-overflow' },
    { height: sample.rootScrollHeight, proof: 'root-scroll-overflow' },
  ];
  for (const scrollCandidate of scrollCandidates) {
    const provesOverflow = scrollCandidate.height > sample.viewportHeight + HEIGHT_FEEDBACK_EPSILON;
    if (provesOverflow && scrollCandidate.height > candidate.height + HEIGHT_FEEDBACK_EPSILON) {
      candidate = scrollCandidate;
    }
  }
  return candidate;
}

export function reduceWidgetLayout(
  previous: WidgetLayoutMachineState,
  event: WidgetLayoutEvent,
  requireViewportConfirmation: boolean,
): WidgetLayoutMachineState {
  if (event.type === 'reset') return createInitialWidgetLayoutState();
  if (event.type === 'invalid') {
    return {
      ...previous,
      phase: 'error',
      proof: null,
      sample: null,
      viewportConfirmed: false,
      error: 'invalid-sample',
    };
  }
  if (event.type === 'pending') {
    const mustDiscardProof = event.cause === 'content' || previous.phase === 'error';
    return {
      ...previous,
      phase: 'pending',
      proof: mustDiscardProof ? null : previous.proof,
      sample: mustDiscardProof ? null : previous.sample,
      viewportConfirmed: false,
      error: null,
    };
  }

  const sample = event.sample;
  if (sample.hasUnmeasurableVisualOverflow) {
    return {
      ...previous,
      phase: 'error',
      proof: null,
      sample: null,
      viewportConfirmed: false,
      error: 'unmeasurable-visual-overflow',
    };
  }

  const candidate = resolveHeightCandidate(sample);
  const parentAppliedPreviousHeight =
    previous.acceptedHeight !== null &&
    Math.abs(sample.viewportHeight - previous.acceptedHeight) <= HEIGHT_FEEDBACK_EPSILON;
  const proofScrollHeight =
    previous.proof === 'body-scroll-overflow'
      ? sample.bodyScrollHeight
      : previous.proof === 'root-scroll-overflow'
        ? sample.rootScrollHeight
        : null;
  const confirmsOverflowWitness =
    proofScrollHeight !== null &&
    parentAppliedPreviousHeight &&
    Math.abs(proofScrollHeight - (previous.acceptedHeight ?? 0)) <= HEIGHT_FEEDBACK_EPSILON &&
    proofScrollHeight <= sample.viewportHeight + HEIGHT_FEEDBACK_EPSILON;
  if (confirmsOverflowWitness && previous.acceptedHeight !== null) {
    return {
      phase: 'ready',
      acceptedHeight: previous.acceptedHeight,
      proof: previous.proof,
      sample,
      viewportConfirmed: true,
      error: null,
    };
  }

  if (previous.sample && previous.acceptedHeight !== null) {
    const viewportDelta = sample.viewportHeight - previous.sample.viewportHeight;
    const candidateDelta = candidate.height - previous.acceptedHeight;
    const widthStable = Math.abs(sample.viewportWidth - previous.sample.viewportWidth) <= HEIGHT_FEEDBACK_EPSILON;
    const parentChildFeedback =
      widthStable &&
      parentAppliedPreviousHeight &&
      Math.abs(viewportDelta) > HEIGHT_FEEDBACK_EPSILON &&
      Math.abs(candidateDelta) > HEIGHT_FEEDBACK_EPSILON &&
      Math.sign(viewportDelta) === Math.sign(candidateDelta) &&
      Math.abs(candidateDelta) >= Math.abs(viewportDelta) - HEIGHT_FEEDBACK_EPSILON;
    if (parentChildFeedback) {
      return {
        ...previous,
        phase: 'error',
        viewportConfirmed: false,
        error: 'viewport-feedback',
      };
    }
  }

  const viewportConfirmed = Math.abs(candidate.height - sample.viewportHeight) <= HEIGHT_FEEDBACK_EPSILON;
  return {
    phase: !requireViewportConfirmation || viewportConfirmed ? 'ready' : 'pending',
    acceptedHeight: candidate.height,
    proof: candidate.proof,
    sample,
    viewportConfirmed,
    error: null,
  };
}

export function readWidgetHeightMessage(
  event: MessageEvent<unknown>,
  expected: { source: Window | null; blockId: string; instanceId: string },
): WidgetHeightMessageResult {
  if (!expected.source || event.source !== expected.source || event.origin !== 'null') return { status: 'ignored' };
  if (!event.data || typeof event.data !== 'object') return { status: 'ignored' };

  const message = event.data as Record<string, unknown>;
  if (
    message.type !== WIDGET_SIZE_MESSAGE ||
    message.v !== 6 ||
    message.blockId !== expected.blockId ||
    message.instanceId !== expected.instanceId
  ) {
    return { status: 'ignored' };
  }
  if (message.phase === 'pending') {
    if (message.cause !== 'content' && message.cause !== 'viewport') return { status: 'ignored' };
    return { status: 'pending', cause: message.cause };
  }
  if (message.phase !== 'measured') return { status: 'ignored' };

  const proofRequestId = message.proofRequestId ?? null;
  if (proofRequestId !== null && !isValidWidgetProofRequestId(proofRequestId)) return { status: 'invalid' };

  const values = [
    message.contentHeight,
    message.bodyScrollHeight,
    message.rootScrollHeight,
    message.viewportHeight,
    message.viewportWidth,
  ];
  if (
    values.some(
      (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > MAX_MEASURED_HEIGHT,
    ) ||
    typeof message.hasUnmeasurableVisualOverflow !== 'boolean'
  ) {
    return { status: 'invalid' };
  }
  return {
    status: 'valid',
    proofRequestId,
    sample: {
      contentHeight: Math.ceil(message.contentHeight as number),
      bodyScrollHeight: Math.ceil(message.bodyScrollHeight as number),
      rootScrollHeight: Math.ceil(message.rootScrollHeight as number),
      hasUnmeasurableVisualOverflow: message.hasUnmeasurableVisualOverflow,
      viewportHeight: Math.ceil(message.viewportHeight as number),
      viewportWidth: Math.ceil(message.viewportWidth as number),
    },
  };
}
