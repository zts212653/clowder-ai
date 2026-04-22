/**
 * F152: First batch of OTel instruments for Cat Cafe observability.
 *
 * All instruments use the `cat_cafe.` prefix and are bound by the
 * MetricAttributeAllowlist Views (D2 enforcement).
 */

import { metrics } from '@opentelemetry/api';

// Lazy meter: deferred until first use so the SDK's MeterProvider is registered.
// Static imports (e.g. AntigravityAgentService) cause this module to load before
// initTelemetry() → sdk.start(), which would bind instruments to NoopMeterProvider.
let _meter: ReturnType<typeof metrics.getMeter> | null = null;
function meter() {
  if (!_meter) _meter = metrics.getMeter('cat-cafe-api', '0.1.0');
  return _meter;
}

// Helper: create a lazy instrument that defers creation until first access.
function lazy<T extends object>(factory: () => T): T {
  let inst: T | undefined;
  return new Proxy({} as T, {
    get(_, prop) {
      if (!inst) inst = factory();
      return (inst as Record<string | symbol, unknown>)[prop];
    },
  });
}

export const invocationDuration = lazy(() =>
  meter().createHistogram('cat_cafe.invocation.duration', {
    description: 'Duration of a single cat invocation',
    unit: 's',
  }),
);

export const llmCallDuration = lazy(() =>
  meter().createHistogram('cat_cafe.llm.call.duration', {
    description: 'Duration of a single LLM API call',
    unit: 's',
  }),
);

export const agentLiveness = lazy(() =>
  meter().createObservableGauge('cat_cafe.agent.liveness', {
    description: 'Agent process liveness state (0=dead, 1=idle-silent, 2=busy-silent, 3=active)',
  }),
);

export const activeInvocations = lazy(() =>
  meter().createUpDownCounter('cat_cafe.invocation.active', { description: 'Number of currently active invocations' }),
);

export const tokenUsage = lazy(() =>
  meter().createCounter('cat_cafe.token.usage', { description: 'Cumulative token consumption', unit: 'tokens' }),
);

export const guideTransitions = lazy(() =>
  meter().createCounter('cat_cafe.guide.transitions', { description: 'Guide lifecycle state transitions' }),
);

export const inlineActionChecked = lazy(() =>
  meter().createCounter('cat_cafe.a2a.inline_action.checked', {
    description: 'Total inline action @mention detection invocations',
  }),
);

export const inlineActionDetected = lazy(() =>
  meter().createCounter('cat_cafe.a2a.inline_action.detected', {
    description: 'Inline action @mention strict detection hits',
  }),
);

export const inlineActionShadowMiss = lazy(() =>
  meter().createCounter('cat_cafe.a2a.inline_action.shadow_miss', {
    description: 'Shadow detection: inline @ found but no action keyword (potential vocab gap)',
  }),
);

export const inlineActionFeedbackWritten = lazy(() =>
  meter().createCounter('cat_cafe.a2a.inline_action.feedback_written', {
    description: 'Inline action mention routing feedback persisted',
  }),
);

export const inlineActionFeedbackWriteFailed = lazy(() =>
  meter().createCounter('cat_cafe.a2a.inline_action.feedback_write_failed', {
    description: 'Inline action mention routing feedback write failure',
  }),
);

export const inlineActionHintEmitted = lazy(() =>
  meter().createCounter('cat_cafe.a2a.inline_action.hint_emitted', {
    description: 'Inline action hint system message sent to user',
  }),
);

export const inlineActionHintEmitFailed = lazy(() =>
  meter().createCounter('cat_cafe.a2a.inline_action.hint_emit_failed', {
    description: 'Inline action hint system message send failure',
  }),
);

export const inlineActionRoutedSetSkip = lazy(() =>
  meter().createCounter('cat_cafe.a2a.inline_action.routed_set_skip', {
    description: 'Inline action @mention skipped because already routed via line-start',
  }),
);

export const lineStartDetected = lazy(() =>
  meter().createCounter('cat_cafe.a2a.line_start.detected', {
    description: 'Line-start @mention detected (baseline for model format compliance)',
  }),
);

export const antigravityStreamErrorBuffered = lazy(() =>
  meter().createCounter('cat_cafe.antigravity.stream_error.buffered_total', {
    description: 'Buffered Antigravity stream_error after partial text while waiting for a recovery tail',
  }),
);

export const antigravityStreamErrorRecovered = lazy(() =>
  meter().createCounter('cat_cafe.antigravity.stream_error.recovered_total', {
    description: 'Buffered Antigravity stream_error later recovered by additional streamed text',
  }),
);

export const antigravityStreamErrorExpired = lazy(() =>
  meter().createCounter('cat_cafe.antigravity.stream_error.expired_total', {
    description: 'Buffered Antigravity stream_error expired without recovery and was surfaced',
  }),
);

export const invocationCompleted = lazy(() =>
  meter().createCounter('cat_cafe.invocation.completed', {
    description: 'Invocation completion count by cat and outcome',
  }),
);

export const threadDuration = lazy(() =>
  meter().createHistogram('cat_cafe.thread.duration', {
    description: 'Thread age from creation to invocation end',
    unit: 's',
  }),
);

export const sessionRounds = lazy(() =>
  meter().createHistogram('cat_cafe.session.rounds', {
    description: 'Cumulative session round count reported each round',
  }),
);

export const catInvocationCount = lazy(() =>
  meter().createCounter('cat_cafe.cat.invocation.count', {
    description: 'Cat invocation count by agent and trigger type',
  }),
);

export const catResponseDuration = lazy(() =>
  meter().createHistogram('cat_cafe.cat.response.duration', {
    description: 'End-to-end cat response duration from message receipt to final reply',
    unit: 's',
  }),
);

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
let callbackRegistered = false;

function ensureCallback() {
  if (callbackRegistered) return;
  callbackRegistered = true;
  agentLiveness.addCallback((result) => {
    for (const [, probe] of activeProbes) {
      result.observe(livenessStateToNumber(probe.getState()), { 'agent.id': probe.catId });
    }
  });
}

/** Register a liveness probe for ObservableGauge polling. */
export function registerLivenessProbe(invocationId: string, catId: string, getState: () => LivenessState): void {
  ensureCallback();
  activeProbes.set(invocationId, { catId, getState });
}

/** Unregister a liveness probe when invocation ends. */
export function unregisterLivenessProbe(invocationId: string): void {
  activeProbes.delete(invocationId);
}
