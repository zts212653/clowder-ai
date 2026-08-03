/**
 * F152: First batch of OTel instruments for Clowder AI observability.
 *
 * All instruments use the `cat_cafe.` prefix and are bound by the
 * MetricAttributeAllowlist Views (D2 enforcement).
 */

import { metrics } from '@opentelemetry/api';
import {
  TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR,
  TURN_CUSTODY_METRIC_COMPARISON_ATTR,
  TURN_CUSTODY_METRIC_STATE_ATTR,
} from './turn-custody-shadow-telemetry.js';

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

export const coverageStageDuration = lazy(() =>
  meter().createHistogram('cat_cafe.memory.coverage.stage.duration', {
    description: 'Wall-clock duration of a bounded coverage-search stage',
    unit: 'ms',
  }),
);

export const coverageStageEventLoopLag = lazy(() =>
  meter().createHistogram('cat_cafe.memory.coverage.stage.event_loop_lag', {
    description: 'Maximum event-loop lag observed while a coverage-search stage ran',
    unit: 'ms',
  }),
);

export const coverageDeadlineTotal = lazy(() =>
  meter().createCounter('cat_cafe.memory.coverage.deadline', {
    description: 'Coverage-search stages stopped by deadline or propagated abort',
  }),
);

export const personMemoryStageDuration = lazy(() =>
  meter().createHistogram('cat_cafe.person_memory.stage.duration', {
    description: 'F276 person-memory stage duration without person-linkable attributes',
    unit: 'ms',
  }),
);

export const personMemoryOutcome = lazy(() =>
  meter().createCounter('cat_cafe.person_memory.outcome', {
    description: 'F276 person-memory bounded stage outcomes without person-linkable attributes',
  }),
);

export const proactiveMemoryScanTotal = lazy(() =>
  meter().createCounter('cat_cafe.proactive_memory.scan', {
    description: 'F282 canonical owner-window scans without owner or subject attributes',
  }),
);

export const proactiveMemoryScanDuration = lazy(() =>
  meter().createHistogram('cat_cafe.proactive_memory.scan.duration', {
    description: 'Wall-clock duration of an F282 canonical owner-window scan',
    unit: 'ms',
  }),
);

export const proactiveMemoryCandidateCount = lazy(() =>
  meter().createHistogram('cat_cafe.proactive_memory.candidate_count', {
    description: 'Lane-neutral candidates found by an F282 scan before registry filtering',
    unit: 'candidates',
  }),
);

export const pawFeelReconciliationDuration = lazy(() =>
  meter().createHistogram('cat_cafe.paw_feel.reconciliation.duration', {
    description: 'Duration of an F278 full or overlap reconciliation scan',
    unit: 'ms',
  }),
);

export const pawFeelReconciliationScannedMessages = lazy(() =>
  meter().createHistogram('cat_cafe.paw_feel.reconciliation.scanned_messages', {
    description: 'Messages inspected by an F278 reconciliation scan',
    unit: 'messages',
  }),
);

export const pawFeelReconciliationDiscovered = lazy(() =>
  meter().createCounter('cat_cafe.paw_feel.reconciliation.discovered', {
    description: 'Canonical paw-feel signals first discovered by reconciliation',
  }),
);

export const pawFeelReconciliationDuplicates = lazy(() =>
  meter().createCounter('cat_cafe.paw_feel.reconciliation.duplicates', {
    description: 'Canonical paw-feel signals idempotently replayed by reconciliation',
  }),
);

export const pawFeelReconciliationLag = lazy(() =>
  meter().createHistogram('cat_cafe.paw_feel.reconciliation.lag', {
    description: 'Lag between the proven timeline boundary and reconciliation completion',
    unit: 'ms',
  }),
);

export const pawFeelReconciliationUnavailable = lazy(() =>
  meter().createCounter('cat_cafe.paw_feel.reconciliation.unavailable', {
    description: 'F278 reconciliation runs that could not prove source or ledger coverage',
  }),
);

export const guideTransitions = lazy(() =>
  meter().createCounter('cat_cafe.guide.transitions', { description: 'Guide lifecycle state transitions' }),
);

export const conciergeVerifiedToolTargetsPerReply = lazy(() =>
  meter().createHistogram('cat_cafe.concierge.verified_tool_targets_per_reply', {
    description: 'Distinct identity-verified get_thread_context targets observed for one concierge reply',
    unit: 'targets',
  }),
);

export const conciergeVerifiedToolActions = lazy(() =>
  meter().createCounter('cat_cafe.concierge.verified_tool_actions', {
    description: 'Concierge navigation actions authorized by one verified get_thread_context target',
  }),
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

// F167 Phase R: cross-thread coordination lifecycle telemetry.
export const coordinationActiveDispatchCount = lazy(() =>
  meter().createCounter('cat_cafe.a2a.coordination.active_dispatch_count', {
    description: 'Active cross-thread coordination messages persisted for routing',
  }),
);

export const coordinationTerminalDispatchCount = lazy(() =>
  meter().createCounter('cat_cafe.a2a.coordination.terminal_dispatch_count', {
    description: 'Terminal cross-thread coordination messages persisted for one final routing hop',
  }),
);

export const coordinationTerminalAckSuppressedCount = lazy(() =>
  meter().createCounter('cat_cafe.a2a.coordination.terminal_ack_suppressed_count', {
    description: 'Courtesy ACKs persisted after terminal without spawning a new invocation',
  }),
);

// F167 Phase S: action successor single-flight telemetry. Histograms preserve
// explicit parallel throughput while the eval layer grades only mode=single
// cardinality above one as friction.
export const successorUniqueCatsInvokedPerAction = lazy(() =>
  meter().createHistogram('cat_cafe.a2a.successor.unique_cats_invoked_per_action', {
    description: 'Distinct successor cats admitted for one action lease generation',
    unit: 'cats',
  }),
);

export const successorConcurrentSuccessors = lazy(() =>
  meter().createHistogram('cat_cafe.a2a.successor.concurrent_successors', {
    description: 'Successor holder cardinality admitted for one action lease generation',
    unit: 'cats',
  }),
);

export const successorResponsesAfterTerminalState = lazy(() =>
  meter().createCounter('cat_cafe.a2a.successor.responses_after_terminal_state', {
    description: 'Zero-tolerance late successor responses suppressed after external subject terminal truth',
  }),
);

export const successorSafeWait = lazy(() =>
  meter().createCounter('cat_cafe.a2a.successor.safe_wait', {
    description: 'Action successor dispatches refused because an active holder already owns the slot',
  }),
);

export const successorReplace = lazy(() =>
  meter().createCounter('cat_cafe.a2a.successor.replace', {
    description: 'Action successor generations atomically replaced after verified terminal or unavailable proof',
  }),
);

export const completedGenerationBlockedFreshRevisionTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.successor.completed_generation_blocked_fresh_revision', {
    description: 'Server-verified fresh subject revisions that failed to continue a completed action lease',
  }),
);

// Same-thread successor carrier migration: bounded counters avoid subject/cat
// labels while preserving enough signal to distinguish legacy single-target
// multi_mention usage from deliberate parallel fan-out.
export const successorMultiMentionTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.successor.multi_mention', {
    description: 'Schema-valid multi_mention carrier requests, including targets rejected before routing',
  }),
);

export const successorSingleTargetMultiMention = lazy(() =>
  meter().createCounter('cat_cafe.a2a.successor.single_target_multi_mention', {
    description: 'Schema-valid multi_mention requests with exactly one target',
  }),
);

export const successorUnfencedSingleTargetMultiMention = lazy(() =>
  meter().createCounter('cat_cafe.a2a.successor.unfenced_single_target_multi_mention', {
    description: 'Legacy single-target multi_mention requests without action successor metadata',
  }),
);

export const successorActionFenceUnavailable = lazy(() =>
  meter().createCounter('cat_cafe.a2a.successor.action_fence_unavailable', {
    description: 'Structured successor requests rejected because the durable action fence was unavailable',
  }),
);

export const successorAgentKeyActionRejected = lazy(() =>
  meter().createCounter('cat_cafe.a2a.successor.agent_key_action_rejected', {
    description: 'Agent-key structured successor attempts rejected because invocation provenance is required',
  }),
);

// F167 S.1 / Phase T denominator counters. They are created from S.1-a onward
// so the pre-cutover baseline exists before the custody stop gate enters shadow.
export const protocolActionWithoutCustodyTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.protocol_action_without_custody_total', {
    description: 'Structured protocol actions that could not obtain a durable custody fence',
  }),
);

export const userNudgeRequiredTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.user_nudge_required_total', {
    description: 'Active protocol custody that required an explicit operator wake to resume',
  }),
);

export const legacyGuardWithoutActiveCustodyTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.legacy_guard_without_active_custody_total', {
    description: 'Legacy stop-guard blocks observed without active turn-scoped protocol custody',
  }),
);

export const sameSubjectPostTerminalEnqueueTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.same_subject_post_terminal_enqueue_total', {
    description: 'Successor invocations enqueued after server-observed terminal subject truth',
  }),
);

export const leaseSucceededSubjectNonterminalTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.lease_succeeded_subject_nonterminal_total', {
    description: 'Succeeded custody leases whose independent subject truth remains nonterminal',
  }),
);

// F167 Phase T cutover counters. Low-cardinality state/comparison attributes keep
// the retired legacy guard as a behavior-delta observer without putting
// subject/thread identifiers into metrics.
export const turnCustodyProjectionTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.turn_custody_projection_total', {
    description: 'Turn-scoped custody projections opened by projection state',
  }),
);

export const turnCustodyShadowComparisonTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.turn_custody_shadow_comparison_total', {
    description: 'Legacy routing guard versus structured turn-custody decision comparisons',
  }),
);

export const turnCustodyShadowOldBlockTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.turn_custody_shadow_old_block_total', {
    description: 'Turns the retired legacy text routing guard would have blocked (observation only)',
  }),
);

export const turnCustodyShadowNewBlockTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.turn_custody_shadow_new_block_total', {
    description: 'Turns the active structured custody stop gate blocks',
  }),
);

// F167 S.1-c runtime-health signals. These are operational telemetry consumed
// by F153 dashboards/SLA alerting, not Eval Hub scores.
export const managedCommandCompletionUnconsumedTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.managed_command_completion_unconsumed_total', {
    description: 'Managed commands whose durable terminal result did not yet have a recoverable holder wake carrier',
  }),
);

export const managedCommandDispatchRetryTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.managed_command_dispatch_retry_total', {
    description: 'Idempotent re-dispatch attempts for durable managed-command completion messages',
  }),
);

export const managedCommandWakeSlaBreachTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.managed_command_wake_sla_breach_total', {
    description: 'Durable managed-command completions still lacking a recoverable wake carrier after the SLA',
  }),
);

export const userPingBeforeHolderTerminalTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.user_ping_before_holder_terminal_total', {
    description: 'User messages that arrived while a terminal managed-command completion remained unconsumed',
  }),
);

export const unresolvedSubjectWithoutActiveCustodyTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.unresolved_subject_without_active_custody_total', {
    description: 'Nonterminal action subjects observed without an active custody holder',
  }),
);

export const returnDeliveryOverdueTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.return_delivery_overdue_total', {
    description: 'ActionSuccessor return carriers that exceeded their delivery SLA before recovery',
  }),
);

/**
 * F192 eval:a2a verdict `2026-06-18-eval-a2a-c1-zombie-hold-semantics-fix`
 * (砚砚): split the original `c1.zombie_hold_count` into two metrics by
 * wake-delay-bucket semantics. Routed at fire time in
 * `callback-hold-ball-c1-emit.ts` based on the `bucketWakeDelay()` result:
 *
 *   - `prior_overdue` + `prior_imminent` → `c1.hold_zombie_count`
 *     (scheduler stuck or wake interrupted <60s — actionable signal,
 *     consumed under `frictionCounts` in f167-eval's `buildC1`)
 *   - `prior_short` + `prior_long` → `c1.hold_replacement_count`
 *     (benign single-slot replacement churn per F167 Phase G KD-23 —
 *     R1 P1 #1: consumed under `activationCounts` so the generic friction
 *     grader never sees it; pre-split shape would re-create the 06-18
 *     false positive under the renamed metric)
 *
 * No legacy alias; clean rename. Producer (callback-hold-ball-c1-emit),
 * sample extractor (c1-hold-sample-evidence), and eval consumer
 * (f167-eval / attribution) updated together — bundle PR avoids the
 * historical risk of partial migrations.
 */
export const c1HoldZombieCount = lazy(() =>
  meter().createCounter('cat_cafe.a2a.c1.hold_zombie_count', {
    description: 'Prior hold cancelled with wake-delay bucket overdue/imminent (true zombie suppression)',
  }),
);

export const c1HoldReplacementCount = lazy(() =>
  meter().createCounter('cat_cafe.a2a.c1.hold_replacement_count', {
    description: 'Prior hold cancelled with wake-delay bucket short/long (benign single-slot replacement churn)',
  }),
);

/**
 * F167 gate-keeping thread guard outcomes.
 *
 * Attributes:
 *   tool ∈ { register_pr_tracking, register_issue_tracking, hold_ball }
 *   outcome ∈ { blocked, override_used, guard_skipped }
 *
 * `blocked` = guard refused (守门 thread, no override) — desired enforcement; healthy ↑.
 * `override_used` = caller asserted downstream-owner role — review for misuse if rate > 30%.
 * `guard_skipped` = threadStore抖动 fail-open — should stay near zero in steady state.
 *
 * See gate-keeping-guard.ts + F167 Phase 6 in
 * docs/plans/2026-06-17-f167-gate-keeping-thread-guard.md.
 */
export const gateKeepingHarnessAttemptCount = lazy(() =>
  meter().createCounter('cat_cafe.harness.gate_keeping_attempt_count', {
    description:
      'F167 trigger-time gate-keeping thread guard outcomes (blocked / override_used / guard_skipped) per tool',
  }),
);

export const c1HoldCancelCount = lazy(() =>
  meter().createCounter('cat_cafe.a2a.c1.hold_cancel_count', {
    description: 'Pending hold cancelled by user message',
  }),
);

export const holdEventRetiredTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.hold_event_retired_total', {
    description: 'Pending hold timer retired because a structured event satisfied its wait source',
  }),
);

export const holdStaleWakeSuppressedTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.hold_stale_wake_suppressed_total', {
    description: 'Hold wake suppressed because its lifecycle was already retired before scheduler fire',
  }),
);

export const holdExpiredAfterSatisfiedTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.hold_expired_after_satisfied_total', {
    description: 'Invariant counter: hold timer expired after the wait source had already been satisfied',
  }),
);

/** F177 Phase J: verified event-backed routing-exit outcomes. */
export const routingEventWaitBypassTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.routing_event_wait.bypass_total', {
    description: 'Routing remedial bypasses backed by a consumer-verified event-wait proof',
  }),
);

export const routingEventWaitRejectedTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.routing_event_wait.rejected_total', {
    description: 'Event-wait routing candidates rejected fail-closed, grouped by bounded reason',
  }),
);

export const routingEventWaitFalseBypassTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.routing_event_wait.false_bypass_total', {
    description: 'Zero-tolerance invariant: resolver bypass whose live-state proof failed consumer validation',
  }),
);

export const routingEventWaitRedundantHoldPreventedTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.routing_event_wait.redundant_hold_prevented_total', {
    description: 'Verified callback waits that avoided the routing guard forcing a second wait outlet',
  }),
);

export const routingTerminalReleaseCleanStopTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.routing_terminal_release.clean_stop_total', {
    description: 'Structured terminal coordination releases accepted as clean routing exits',
  }),
);

export const routingTerminalReleaseRemedialTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.routing_terminal_release.remedial_total', {
    description: 'Structured terminal coordination releases incorrectly sent through routing remedial',
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

// --- F236 Track-1: anchor-first telemetry (chars + request/response volume substrate) ---

/**
 * F236 Phase A made the anchor-first callback read-tools (pending-mentions /
 * thread-context / list-tasks) return head/tail previews + drill pointers
 * instead of full bodies, to shrink agent token load. The chars/省 signal was
 * previously only `app.log.info` (ephemeral stdout). Track-1 funnels it through
 * `anchor-telemetry.ts` so it ALSO lands as OTel metrics — a queryable
 * chars + request/response VOLUME substrate.
 *
 * Scope (砚砚 eval-owner ruling iii): Track-1 ships chars (the 省/savings signal)
 * and request/response volume ONLY. These are low-cardinality aggregate counters
 * with NO join keys, so they are NOT an open-rate numerator/denominator and do
 * NOT support a per-tool drill↔preview open-rate (that needs a cross-endpoint /
 * per-item correlated event model — Track-2's scope, not computed here).
 *
 * Attributes (allowlist-filtered): `anchor.tool` only (bounded 4-value set).
 */

/**
 * Counter: an anchor preview payload was returned, per tool.
 * Request/response VOLUME — explicitly NOT an open-rate numerator/denominator.
 */
export const anchorReturnedCount = lazy(() =>
  meter().createCounter('cat_cafe.anchor.returned.count', {
    description:
      'Anchor-first preview payload returned, by tool — request/response volume, NOT an open-rate numerator/denominator (F236 Track-1)',
  }),
);

/** Histogram: chars returned in an anchor preview payload, per tool (the 省/savings signal). */
export const anchorReturnedChars = lazy(() =>
  meter().createHistogram('cat_cafe.anchor.returned.chars', {
    description: 'Chars returned in an anchor-first preview payload, by tool — the 省/savings signal (F236 Track-1)',
    unit: 'characters',
  }),
);

/**
 * Counter: a full drill (mode=full body served) was served, per tool.
 * Request/response VOLUME — explicitly NOT an open-rate numerator/denominator.
 */
export const anchorFullDrillCount = lazy(() =>
  meter().createCounter('cat_cafe.anchor.full_drill.count', {
    description:
      'Anchor full-drill (full body served) by tool — request/response volume, NOT an open-rate numerator/denominator (F236 Track-1)',
  }),
);

/** Histogram: chars served in a full drill, per tool (the 省/savings signal). */
export const anchorFullDrillChars = lazy(() =>
  meter().createHistogram('cat_cafe.anchor.full_drill.chars', {
    description:
      'Chars served in an anchor full-drill (full body served) by tool — the 省/savings signal (F236 Track-1)',
    unit: 'characters',
  }),
);

// --- F231 AC-C3: Profile update eval counters (KD-10: zero-activation detection) ---

/** Counter: profile update proposed (cat → operator card). */
export const profileUpdateProposed = lazy(() =>
  meter().createCounter('cat_cafe.profile_update.proposed', {
    description: 'Profile update proposals created (F231 C3 eval)',
  }),
);

/** Counter: profile update approved (operator → primer written). */
export const profileUpdateApproved = lazy(() =>
  meter().createCounter('cat_cafe.profile_update.approved', {
    description: 'Profile update proposals approved and written (F231 C3 eval)',
  }),
);

/** Counter: profile update rejected (operator → no write). */
export const profileUpdateRejected = lazy(() =>
  meter().createCounter('cat_cafe.profile_update.rejected', {
    description: 'Profile update proposals rejected (F231 C3 eval)',
  }),
);

/** Counter: compiled L0 contained the logical current-persona profile pointer. */
export const profilePointerEmitted = lazy(() =>
  meter().createCounter('cat_cafe.profile.pointer_emitted', {
    description: 'Compiled L0 payloads containing the current relationship profile URI',
  }),
);

/** Counter: authenticated current-persona pointer resolved to primer content. */
export const profilePointerResolved = lazy(() =>
  meter().createCounter('cat_cafe.profile.pointer_resolved', {
    description: 'Authenticated current relationship profile reads resolved successfully',
  }),
);

/** Counter: authenticated pointer could not resolve current-persona content. */
export const profilePointerMissing = lazy(() =>
  meter().createCounter('cat_cafe.profile.pointer_missing', {
    description: 'Authenticated current relationship profile reads with no resolvable persona content',
  }),
);

/** Counter: distillation trigger fired on session seal (KD-10 eval). */
export const profileDistillationTriggered = lazy(() =>
  meter().createCounter('cat_cafe.profile_update.distillation_triggered', {
    description: 'Profile distillation trigger fired on session-seal event (F231 C3/KD-10 eval)',
  }),
);

// --- F167 Phase O PR-O2: Claim Grounding Shadow Telemetry ---

/**
 * Total grounding checks initiated per tool call.
 * Attributes: callback.tool (hold_ball / register_pr_tracking / register_issue_tracking)
 */
export const groundingCheckTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.grounding.check_total', {
    description: 'F167 Phase O grounding check invocations per stateful tool call (shadow mode)',
  }),
);

/**
 * Claim-level verdict outcomes.
 * Attributes: grounding.claim_type × grounding.verdict × callback.tool
 */
export const groundingVerdictTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.grounding.verdict_total', {
    description: 'F167 Phase O claim grounding verdict outcomes (verified/mismatch/insufficient)',
  }),
);

/**
 * Per-resolver invocation count.
 * Attributes: grounding.source_tier × status (resolver id)
 */
export const groundingResolverTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.grounding.resolver_total', {
    description: 'F167 Phase O resolver invocations (per resolver × source tier)',
  }),
);

/**
 * Resolver cache hits.
 * Attributes: status (resolver id)
 */
export const groundingCacheHitTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.grounding.cache_hit_total', {
    description: 'F167 Phase O resolver cache hits',
  }),
);

/**
 * Budget exhaustion events per grounding check.
 * Attributes: callback.tool × grounding.action_family
 */
export const groundingBudgetExhaustedTotal = lazy(() =>
  meter().createCounter('cat_cafe.a2a.grounding.budget_exhausted_total', {
    description: 'F167 Phase O resolver budget exhausted (verdict forced to insufficient)',
  }),
);

// --- F167 Phase O PR-O3: Hold-ball misuse detection counters ---

/**
 * Counts attempts to call hold_ball with wakeAfterMs but no waitSourceRef.
 * Schema now rejects these (PR-O3), so this counter tracks how often cats
 * still TRY the misuse pattern — feeds F192 weekly verdict to measure
 * whether the cognitive fix (soft layer) is landing.
 */
export const holdBallUngroundedTimerReject = lazy(() =>
  meter().createCounter('cat_cafe.a2a.hold_ball.ungrounded_timer_reject', {
    description: 'F167 PR-O3: hold_ball called with wakeAfterMs but no waitSourceRef (schema rejected)',
  }),
);

/**
 * Counts attempts to use the removed 'pending_input' kind in waitSourceRef.
 * This backdoor let cats express "wait for human reply" through hold_ball
 * instead of using @co-creator.
 */
export const holdBallPendingInputReject = lazy(() =>
  meter().createCounter('cat_cafe.a2a.hold_ball.pending_input_reject', {
    description: 'F167 PR-O3: hold_ball called with pending_input kind (backdoor removed, schema rejected)',
  }),
);

// --- F254 AC-B5: Freshness gate + notice + re-invoke telemetry ---

export const codexAppServerLifecycleTransition = lazy(() =>
  meter().createCounter('cat_cafe.codex_app_server.lifecycle_transition', {
    description: 'Codex app-server lifecycle stage transitions',
  }),
);

export const codexAppServerStageDuration = lazy(() =>
  meter().createHistogram('cat_cafe.codex_app_server.stage_duration', {
    description: 'Time spent in each Codex app-server lifecycle stage',
    unit: 's',
  }),
);

export const codexAppServerRecovery = lazy(() =>
  meter().createCounter('cat_cafe.codex_app_server.recovery', {
    description: 'Bounded Codex app-server recovery attempts and terminal recovery outcomes',
  }),
);

export const codexAppServerInterrupt = lazy(() =>
  meter().createCounter('cat_cafe.codex_app_server.interrupt', {
    description: 'Protocol-level Codex app-server turn interrupt requests',
  }),
);

export const codexAppServerForcedCleanup = lazy(() =>
  meter().createCounter('cat_cafe.codex_app_server.forced_cleanup', {
    description: 'OS-level Codex app-server cleanup fallbacks after protocol or close failure',
  }),
);

export const codexAppServerHostColdSpawn = lazy(() =>
  meter().createCounter('cat_cafe.codex_app_server.host.cold_spawn', {
    description: 'Codex app-server hosts created because no eligible warm host was available',
  }),
);

export const codexAppServerHostWarmReuse = lazy(() =>
  meter().createCounter('cat_cafe.codex_app_server.host.warm_reuse', {
    description: 'Codex app-server invocations served by an existing idle host',
  }),
);

export const codexAppServerHostLive = lazy(() =>
  meter().createUpDownCounter('cat_cafe.codex_app_server.host.live', {
    description: 'Number of live pooled Codex app-server host processes',
  }),
);

export const codexAppServerLeaseActive = lazy(() =>
  meter().createUpDownCounter('cat_cafe.codex_app_server.lease.active', {
    description: 'Number of active exclusive leases on pooled Codex app-server hosts',
  }),
);

export const codexAppServerHostEviction = lazy(() =>
  meter().createCounter('cat_cafe.codex_app_server.host.eviction', {
    description: 'Codex app-server hosts evicted from the warm pool, partitioned by bounded status reason',
  }),
);

/** Gate held: post_message/cross_post blocked because thread has unseen messages. */
export const freshnessGateHeld = lazy(() =>
  meter().createCounter('cat_cafe.freshness.gate_held', {
    description: 'F254 freshness gate held decisions (unseen messages blocked side-effect)',
  }),
);

/** Gate forward: post_message/cross_post allowed (no unseen, or acknowledged). */
export const freshnessGateForward = lazy(() =>
  meter().createCounter('cat_cafe.freshness.gate_forward', {
    description: 'F254 freshness gate forward decisions (side-effect allowed)',
  }),
);

/** Typed relevance exclusions that prevented false freshness work. */
export const freshnessRelevanceSuppressed = lazy(() =>
  meter().createCounter('cat_cafe.freshness.relevance_suppressed', {
    description: 'F254 messages excluded from freshness work by a bounded typed relevance reason',
  }),
);

/** Notice attached: content-free "you have unseen messages" notice delivered to cat. */
export const freshnessNoticeAttached = lazy(() =>
  meter().createCounter('cat_cafe.freshness.notice_attached', {
    description: 'F254 content-free freshness notice attached to read-only tool response',
  }),
);

/** Provider-native safe-boundary notice lifecycle, split by provider/carrier/surface. */
export const freshnessProviderNotice = lazy(() =>
  meter().createCounter('cat_cafe.freshness.provider_notice', {
    description: 'F254 D2 provider-native freshness opportunity, delivery, and miss outcomes',
  }),
);

/** Notice acked: cat advanced seenCursor past notice (implicitly read the messages). */
export const freshnessNoticeAcked = lazy(() =>
  meter().createCounter('cat_cafe.freshness.notice_acked', {
    description: 'F254 freshness notice implicitly acked (seenCursor caught up)',
  }),
);

/** Notice deferred: cat held_ball despite unresolved notices (chose to exit without reading). */
export const freshnessNoticeDeferred = lazy(() =>
  meter().createCounter('cat_cafe.freshness.notice_deferred', {
    description: 'F254 freshness notice deferred at hold_ball (cat exited without reading)',
  }),
);

/** Re-invoke triggered: invocation ended with unresolved high-priority notices → re-invoke queued. */
export const freshnessReinvokeTriggered = lazy(() =>
  meter().createCounter('cat_cafe.freshness.reinvoke_triggered', {
    description: 'F254 freshness re-invoke triggered (unresolved notices → new invocation)',
  }),
);

/** Re-invoke skipped: invocation ended but re-invoke not needed (cursor caught up, quota, etc). */
export const freshnessReinvokeSkipped = lazy(() =>
  meter().createCounter('cat_cafe.freshness.reinvoke_skipped', {
    description: 'F254 freshness re-invoke skipped (cursor caught up / quota / already handled)',
  }),
);

/** Queued seen: full contiguous thread-context read marked a same-target queued entry seen. */
export const freshnessQueuedSeen = lazy(() =>
  meter().createCounter('cat_cafe.freshness.queued_seen', {
    description: 'F254 queued body seen transitions from full contiguous thread-context reads',
  }),
);

/** Queued handled: a seen queued entry closed via same-invocation successful completion evidence. */
export const freshnessQueuedHandled = lazy(() =>
  meter().createCounter('cat_cafe.freshness.queued_handled', {
    description: 'F254 queued handled closures inferred from queued_seen plus successful invocation evidence',
  }),
);

/** Phase E catch-closure lifecycle, replayable alongside the TTL=0 aggregate. */
export const freshnessClosureTransition = lazy(() =>
  meter().createCounter('cat_cafe.freshness.closure_transition', {
    description: 'F254 Phase E catch-closure lifecycle transitions',
  }),
);

/** Blind replay prevented because the stale attempt had replay-unsafe tool activity. */
export const freshnessReplayFence = lazy(() =>
  meter().createCounter('cat_cafe.freshness.replay_fence', {
    description: 'F254 stale-output automatic replay blocked after replay-unsafe tool activity',
  }),
);

/** Redundant typed successors canceled before model execution. */
export const freshnessSuccessorPreflightCanceled = lazy(() =>
  meter().createCounter('cat_cafe.freshness.successor_preflight_canceled', {
    description: 'F254 Phase E redundant closure successors canceled before model execution',
  }),
);

/** Observable custody stages for F254 v1.2 incident replay and verdicts. */
export const freshnessClosureStage = lazy(() =>
  meter().createCounter('cat_cafe.freshness.closure_stage', {
    description: 'F254 v1.2 formal commit and retry-preflight custody stages',
  }),
);

/** ADR-042 publish-then-supplement lifecycle events. */
export const freshnessGlassBoxTransition = lazy(() =>
  meter().createCounter('cat_cafe.freshness.glass_box_transition', {
    description: 'F254 ADR-042 published-with-unseen and supplement lifecycle transitions',
  }),
);

// ── F260 Phase B: entity nudge telemetry (AC-B5) ────────────────────────

/** Entity nudge detected: InputEntityDetector found entity reference in user input. */
export const entityNudgeDetected = lazy(() =>
  meter().createCounter('cat_cafe.entity_nudge.detected', {
    description: 'F260 entity nudge detected in user input',
  }),
);

/** Entity nudge delivered: nudge payload sent to cat (passed cooldown + noise control). */
export const entityNudgeDelivered = lazy(() =>
  meter().createCounter('cat_cafe.entity_nudge.delivered', {
    description: 'F260 entity nudge delivered after cooldown/noise filtering',
  }),
);

/** Entity nudge suppressed: nudge blocked by cooldown, context dedup, or maxResults cap. */
export const entityNudgeSuppressed = lazy(() =>
  meter().createCounter('cat_cafe.entity_nudge.suppressed', {
    description: 'F260 entity nudge suppressed (cooldown/context/cap)',
  }),
);

/** Entity nudge privacy blocked: nudge blocked by privacy gate (KD-7). */
export const entityNudgePrivacyBlocked = lazy(() =>
  meter().createCounter('cat_cafe.entity_nudge.privacy_blocked', {
    description: 'F260 entity nudge privacy-blocked (KD-7: private entity in non-authorized thread)',
  }),
);

// F168 F-Step3: external case closure activation, zero-tolerance violations,
// and latency. Counter warmup below lets eval distinguish no traffic from a
// traffic window with zero violations.
export const externalCaseHeadObserved = lazy(() =>
  meter().createCounter('cat_cafe.external_case.head_observed', {
    description: 'Distinct external PR HEAD observations admitted to the F168 event log',
  }),
);

export const externalCaseVerdictRecorded = lazy(() =>
  meter().createCounter('cat_cafe.external_case.verdict_recorded', {
    description: 'Atomic external review verdict and delivery-custody events recorded',
  }),
);

export const externalCaseReviewerWakeDelivered = lazy(() =>
  meter().createCounter('cat_cafe.external_case.reviewer_wake_delivered', {
    description: 'Current-HEAD reviewer wake messages delivered by F168',
  }),
);

export const externalCaseVerdictReadyWithoutDelivery = lazy(() =>
  meter().createCounter('cat_cafe.external_case.verdict_ready_without_delivery', {
    description: 'Zero-tolerance external verdict attempts without delivered or pending_delivery custody',
  }),
);

export const externalCaseNoisyWakeDuringCloudReview = lazy(() =>
  meter().createCounter('cat_cafe.external_case.noisy_wake_during_cloud_review', {
    description: 'Zero-tolerance reviewer wakes delivered while current-head cloud review is unsatisfied',
  }),
);

export const externalCaseDuplicateReviewerWakePerHead = lazy(() =>
  meter().createCounter('cat_cafe.external_case.duplicate_reviewer_wake_per_head', {
    description: 'Zero-tolerance extra reviewer wake identities delivered for one subject and HEAD',
  }),
);

export const externalCaseUserNudgeRequired = lazy(() =>
  meter().createCounter('cat_cafe.external_case.user_nudge_required', {
    description: 'operator reminders required to resume an accepted external issue or PR',
  }),
);

export const externalCasePendingDeliveryAgeSeconds = lazy(() =>
  meter().createHistogram('cat_cafe.external_case.pending_delivery_age', {
    description: 'Observed age of durable external review pending_delivery responsibility',
    unit: 's',
  }),
);

export const externalCaseAuthorUpdateToReadyWakeSeconds = lazy(() =>
  meter().createHistogram('cat_cafe.external_case.author_update_to_ready_wake', {
    description: 'Latency from current external PR HEAD observation to reviewer wake delivery',
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

// Pre-touch counters that may never fire in normal operation so they
// appear in Prometheus output (eval can distinguish 0 from absent).
export function warmupCounters(): void {
  coverageDeadlineTotal.add(0);
  l1StreakWarnCount.add(0);
  l1StreakBreakCount.add(0);
  coordinationActiveDispatchCount.add(0);
  coordinationTerminalDispatchCount.add(0);
  coordinationTerminalAckSuppressedCount.add(0);
  successorResponsesAfterTerminalState.add(0);
  successorSafeWait.add(0);
  successorReplace.add(0);
  completedGenerationBlockedFreshRevisionTotal.add(0);
  successorMultiMentionTotal.add(0);
  successorSingleTargetMultiMention.add(0);
  successorUnfencedSingleTargetMultiMention.add(0);
  successorActionFenceUnavailable.add(0);
  successorAgentKeyActionRejected.add(0);
  protocolActionWithoutCustodyTotal.add(0);
  userNudgeRequiredTotal.add(0);
  legacyGuardWithoutActiveCustodyTotal.add(0);
  sameSubjectPostTerminalEnqueueTotal.add(0);
  leaseSucceededSubjectNonterminalTotal.add(0);
  turnCustodyProjectionTotal.add(0, { [TURN_CUSTODY_METRIC_STATE_ATTR]: 'covered_active' });
  turnCustodyProjectionTotal.add(0, { [TURN_CUSTODY_METRIC_STATE_ATTR]: 'covered_empty' });
  turnCustodyProjectionTotal.add(0, { [TURN_CUSTODY_METRIC_STATE_ATTR]: 'unknown_legacy' });
  for (const comparison of ['agree_allow', 'agree_block', 'old_only_block']) {
    turnCustodyShadowComparisonTotal.add(0, {
      [TURN_CUSTODY_METRIC_COMPARISON_ATTR]: comparison,
      [TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR]: 'not_applicable',
    });
  }
  for (const classification of ['justified', 'unjustified', 'unexplained']) {
    turnCustodyShadowComparisonTotal.add(0, {
      [TURN_CUSTODY_METRIC_COMPARISON_ATTR]: 'new_only_block',
      [TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR]: classification,
    });
  }
  turnCustodyShadowOldBlockTotal.add(0);
  turnCustodyShadowNewBlockTotal.add(0);
  managedCommandCompletionUnconsumedTotal.add(0);
  managedCommandDispatchRetryTotal.add(0);
  managedCommandWakeSlaBreachTotal.add(0);
  userPingBeforeHolderTerminalTotal.add(0);
  unresolvedSubjectWithoutActiveCustodyTotal.add(0);
  returnDeliveryOverdueTotal.add(0);
  c1HoldZombieCount.add(0);
  c1HoldReplacementCount.add(0);
  c1HoldCancelCount.add(0);
  holdEventRetiredTotal.add(0);
  holdStaleWakeSuppressedTotal.add(0);
  holdExpiredAfterSatisfiedTotal.add(0);
  routingEventWaitBypassTotal.add(0);
  routingEventWaitRejectedTotal.add(0);
  routingEventWaitFalseBypassTotal.add(0);
  routingEventWaitRedundantHoldPreventedTotal.add(0);
  routingTerminalReleaseCleanStopTotal.add(0);
  routingTerminalReleaseRemedialTotal.add(0);
  c2VerdictHintEmitted.add(0);
  c2VoidHoldHintEmitted.add(0);
  c2VerdictWithoutPassCount.add(0);
  c2ExitChecked.add(0);
  c2VoidHoldChecked.add(0);
  // F231 AC-C3: profile update pipeline counters
  profileUpdateProposed.add(0);
  profileUpdateApproved.add(0);
  profileUpdateRejected.add(0);
  profilePointerEmitted.add(0);
  profilePointerResolved.add(0);
  profilePointerMissing.add(0);
  profileDistillationTriggered.add(0);
  // F167 Phase O PR-O2: claim grounding shadow telemetry
  groundingCheckTotal.add(0);
  groundingVerdictTotal.add(0);
  groundingResolverTotal.add(0);
  groundingCacheHitTotal.add(0);
  groundingBudgetExhaustedTotal.add(0);
  // F167 PR-O3: hold_ball misuse detection
  holdBallUngroundedTimerReject.add(0);
  holdBallPendingInputReject.add(0);
  // F254 AC-B5: freshness gate + notice + re-invoke
  codexAppServerLifecycleTransition.add(0);
  codexAppServerRecovery.add(0);
  codexAppServerInterrupt.add(0);
  codexAppServerForcedCleanup.add(0);
  codexAppServerHostColdSpawn.add(0);
  codexAppServerHostWarmReuse.add(0);
  codexAppServerHostLive.add(0);
  codexAppServerLeaseActive.add(0);
  codexAppServerHostEviction.add(0);
  freshnessGateHeld.add(0);
  freshnessGateForward.add(0);
  freshnessRelevanceSuppressed.add(0);
  freshnessNoticeAttached.add(0);
  freshnessNoticeAcked.add(0);
  freshnessNoticeDeferred.add(0);
  freshnessReinvokeTriggered.add(0);
  freshnessReinvokeSkipped.add(0);
  freshnessQueuedSeen.add(0);
  freshnessQueuedHandled.add(0);

  // F260 Phase B: entity nudge (AC-B5)
  entityNudgeDetected.add(0);
  entityNudgeDelivered.add(0);
  entityNudgeSuppressed.add(0);
  entityNudgePrivacyBlocked.add(0);
  // F168 F-Step3: activation + zero-tolerance external-case closure counters.
  externalCaseHeadObserved.add(0);
  externalCaseVerdictRecorded.add(0);
  externalCaseReviewerWakeDelivered.add(0);
  externalCaseVerdictReadyWithoutDelivery.add(0);
  externalCaseNoisyWakeDuringCloudReview.add(0);
  externalCaseDuplicateReviewerWakePerHead.add(0);
  externalCaseUserNudgeRequired.add(0);
}
