/**
 * F152: First batch of OTel instruments for Cat Cafe observability.
 *
 * All instruments use the `cat_cafe.` prefix and are bound by the
 * MetricAttributeAllowlist Views (D2 enforcement).
 */

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('cat-cafe-api', '0.1.0');

/** Histogram: invocation duration (seconds). */
export const invocationDuration = meter.createHistogram('cat_cafe.invocation.duration', {
  description: 'Duration of a single cat invocation',
  unit: 's',
});

/** Histogram: individual LLM API call duration (seconds). */
export const llmCallDuration = meter.createHistogram('cat_cafe.llm.call.duration', {
  description: 'Duration of a single LLM API call',
  unit: 's',
});

/**
 * Gauge: agent liveness state.
 * 0=dead, 1=idle-silent, 2=busy-silent, 3=active.
 */
export const agentLiveness = meter.createObservableGauge('cat_cafe.agent.liveness', {
  description: 'Agent process liveness state (0=dead, 1=idle-silent, 2=busy-silent, 3=active)',
});

/** UpDownCounter: currently active invocations. */
export const activeInvocations = meter.createUpDownCounter('cat_cafe.invocation.active', {
  description: 'Number of currently active invocations',
});

/** Counter: token usage (split by input/output via attributes). */
export const tokenUsage = meter.createCounter('cat_cafe.token.usage', {
  description: 'Cumulative token consumption',
  unit: 'tokens',
});

/** Counter: guide lifecycle transitions (A-4). */
export const guideTransitions = meter.createCounter('cat_cafe.guide.transitions', {
  description: 'Guide lifecycle state transitions',
});

// --- clowder-ai#489: Inline @mention detection observability ---

/** Counter: total inline action mention detection runs. */
export const inlineActionChecked = meter.createCounter('cat_cafe.a2a.inline_action.checked', {
  description: 'Total inline action @mention detection invocations',
});

/** Counter: inline action mention detected (strict match). */
export const inlineActionDetected = meter.createCounter('cat_cafe.a2a.inline_action.detected', {
  description: 'Inline action @mention strict detection hits',
});

/** Counter: shadow miss — relaxed match found but strict missed. */
export const inlineActionShadowMiss = meter.createCounter('cat_cafe.a2a.inline_action.shadow_miss', {
  description: 'Shadow detection: inline @ found but no action keyword (potential vocab gap)',
});

/** Counter: routing feedback written successfully. */
export const inlineActionFeedbackWritten = meter.createCounter('cat_cafe.a2a.inline_action.feedback_written', {
  description: 'Inline action mention routing feedback persisted',
});

/** Counter: routing feedback write failed. */
export const inlineActionFeedbackWriteFailed = meter.createCounter('cat_cafe.a2a.inline_action.feedback_write_failed', {
  description: 'Inline action mention routing feedback write failure',
});

/** Counter: hint system message emitted. */
export const inlineActionHintEmitted = meter.createCounter('cat_cafe.a2a.inline_action.hint_emitted', {
  description: 'Inline action hint system message sent to user',
});

/** Counter: hint emit failed. */
export const inlineActionHintEmitFailed = meter.createCounter('cat_cafe.a2a.inline_action.hint_emit_failed', {
  description: 'Inline action hint system message send failure',
});

/** Counter: routedSet already covered the mention — skipped. */
export const inlineActionRoutedSetSkip = meter.createCounter('cat_cafe.a2a.inline_action.routed_set_skip', {
  description: 'Inline action @mention skipped because already routed via line-start',
});

/** Counter: baseline — line-start @mention detected (model compliance). */
export const lineStartDetected = meter.createCounter('cat_cafe.a2a.line_start.detected', {
  description: 'Line-start @mention detected (baseline for model format compliance)',
});

// --- F061 Phase 2d: Antigravity stream_error grace recovery ---

/** Counter: stream_error buffered after partial text while waiting for recovery tail. */
export const antigravityStreamErrorBuffered = meter.createCounter('cat_cafe.antigravity.stream_error.buffered_total', {
  description: 'Buffered Antigravity stream_error after partial text while waiting for a recovery tail',
});

/** Counter: buffered stream_error recovered by later text. */
export const antigravityStreamErrorRecovered = meter.createCounter(
  'cat_cafe.antigravity.stream_error.recovered_total',
  {
    description: 'Buffered Antigravity stream_error later recovered by additional streamed text',
  },
);

/** Counter: buffered stream_error expired without recovery and was surfaced to the user. */
export const antigravityStreamErrorExpired = meter.createCounter('cat_cafe.antigravity.stream_error.expired_total', {
  description: 'Buffered Antigravity stream_error expired without recovery and was surfaced',
});

/** Liveness state type. */
export type LivenessState = 'dead' | 'idle-silent' | 'busy-silent' | 'active';

/** Map liveness state string to numeric gauge value. */
export function livenessStateToNumber(state: LivenessState): number {
  switch (state) {
    case 'dead':
      return 0;
    case 'idle-silent':
      return 1;
    case 'busy-silent':
      return 2;
    case 'active':
      return 3;
  }
}

// --- Liveness probe registry for ObservableGauge ---

interface LivenessProbeRef {
  catId: string;
  getState: () => LivenessState;
}

const activeProbes = new Map<string, LivenessProbeRef>();

/** Register a liveness probe for ObservableGauge polling. */
export function registerLivenessProbe(invocationId: string, catId: string, getState: () => LivenessState): void {
  activeProbes.set(invocationId, { catId, getState });
}

/** Unregister a liveness probe when invocation ends. */
export function unregisterLivenessProbe(invocationId: string): void {
  activeProbes.delete(invocationId);
}

// Register the ObservableGauge callback — polls all active probes
agentLiveness.addCallback((result) => {
  for (const [, probe] of activeProbes) {
    result.observe(livenessStateToNumber(probe.getState()), {
      'agent.id': probe.catId,
    });
  }
});
