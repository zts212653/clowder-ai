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

export const geminiContextFallback = lazy(() =>
  meter().createCounter('cat_cafe.gemini.context_fill_fallback', {
    description: 'Gemini cumulative-only context signal observed without per-turn token data',
  }),
);

export const l1StreakWarnCount = lazy(() =>
  meter().createCounter('cat_cafe.a2a.l1.streak_warn_count', {
    description: 'L1 ping-pong streak warning threshold reached',
  }),
);

export const l1StreakBreakCount = lazy(() =>
  meter().createCounter('cat_cafe.a2a.l1.streak_break_count', {
    description: 'L1 ping-pong circuit-break triggered',
  }),
);

export const c1ZombieHoldCount = lazy(() =>
  meter().createCounter('cat_cafe.a2a.c1.zombie_hold_count', {
    description: 'Hold registered but previous hold for same (thread, cat) was unreleased',
  }),
);

export const c1HoldCancelCount = lazy(() =>
  meter().createCounter('cat_cafe.a2a.c1.hold_cancel_count', {
    description: 'Pending hold cancelled by user message',
  }),
);

export const c2VerdictHintEmitted = lazy(() =>
  meter().createCounter('cat_cafe.a2a.c2.verdict_hint_emitted', {
    description: 'C2 exit-check verdict-no-pass hint emitted (split from mixed hint_emitted)',
  }),
);

export const c2VoidHoldHintEmitted = lazy(() =>
  meter().createCounter('cat_cafe.a2a.c2.void_hold_hint_emitted', {
    description: 'C2 exit-check void-hold hint emitted (split from mixed hint_emitted)',
  }),
);

export const c2VerdictWithoutPassCount = lazy(() =>
  meter().createCounter('cat_cafe.a2a.c2.verdict_without_pass_count', {
    description: 'C2 forced-pass trigger count (verdict issued without explicit pass)',
  }),
);

// Denominator for C2 friction ratios. Incremented every time the verdict-without-pass
// exit-check actually evaluates a turn, so attribution can compute a real
// `verdict_without_pass_count / c2.checked` ratio instead of fabricating 100% when no
// denominator exists (F167 eval:a2a 2026-05-29 over-escalation root cause).
export const c2ExitChecked = lazy(() =>
  meter().createCounter('cat_cafe.a2a.c2.exit_checked', {
    description: 'C2 exit-check evaluations performed (denominator for verdict_without_pass ratio)',
  }),
);

// Separate denominator for the void-hold check, which runs as its own guard later in
// the route (not the verdict-without-pass exit check). Grading void_hold_hint_emitted
// against c2.exit_checked would divide by the wrong count and suppress real void-hold
// signals (cloud review PR #1941 P2).
export const c2VoidHoldChecked = lazy(() =>
  meter().createCounter('cat_cafe.a2a.c2.void_hold_checked', {
    description: 'C2 void-hold check evaluations performed (denominator for void_hold_hint ratio)',
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

// --- F153 Phase I: Step Summary counters ---

/**
 * Counter: A2A mention_dispatch span occurrences.
 * Increments at every `cat_cafe.mention_dispatch` span creation (in-process or callback path).
 * Attributes (allowlist-filtered): only `agent.id` (mentioner cat) — never invocationId/threadId
 * (metric-allowlist forbids high-cardinality). Omit `agent.id` when source cat is unknown
 * (e.g. callback path without sourceCatId).
 */
export const a2aDispatchCount = lazy(() =>
  meter().createCounter('cat_cafe.a2a.dispatch.count', {
    description: 'A2A mention_dispatch span occurrences (F153 Phase I)',
  }),
);

// --- F174 Phase D1: callback auth observability ---

/**
 * Counter: callback auth failures by reason / tool / cat.
 * Attributes (allowlist-filtered):
 *   - callback.reason: expired | invalid_token | unknown_invocation | missing_creds | stale_invocation
 *   - callback.tool: refresh-token | post-message | register-pr-tracking | retain-memory | ...
 *   - agent.id: cat that experienced the failure (omitted when unknown)
 */
export const callbackAuthFailures = lazy(() =>
  meter().createCounter('cat_cafe.callback_auth.failures', {
    description: 'Callback auth 401 failures by reason / tool / cat (F174 Phase D1)',
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

// Pre-touch counters that may never fire in normal operation so they
// appear in Prometheus output (eval can distinguish 0 from absent).
export function warmupCounters(): void {
  l1StreakWarnCount.add(0);
  l1StreakBreakCount.add(0);
  c1ZombieHoldCount.add(0);
  c1HoldCancelCount.add(0);
  c2VerdictHintEmitted.add(0);
  c2VoidHoldHintEmitted.add(0);
  c2VerdictWithoutPassCount.add(0);
  c2ExitChecked.add(0);
  c2VoidHoldChecked.add(0);
}
