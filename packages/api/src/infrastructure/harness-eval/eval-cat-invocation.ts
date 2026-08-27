import { type EvalDomainRegistryEntry, parseEvalDomainRegistryEntry } from './domain/eval-domain-registry.js';
import { PUBLISH_VERDICT_PACKET_INSTRUCTIONS } from './eval-cat-publish-instructions.js';
import { FRESHNESS_PUBLISH_SELECTOR_INSTRUCTIONS } from './freshness/freshness-eval-cat-instructions.js';
import {
  TRAJECTORY_INSPECTOR_DOMAIN_INSTRUCTIONS,
  TRAJECTORY_INSPECTOR_PUBLISH_SELECTOR_INSTRUCTIONS,
} from './trajectory-inspector/trajectory-inspector-eval-cat-instructions.js';

export interface LegacyCleanupStatus {
  status: 'not_checked' | 'dry_run_ready' | 'redirected' | 'disabled';
  reportRef?: string;
}

export interface EvalCatInvocationInput {
  domain: EvalDomainRegistryEntry;
  trendRefs: string[];
  verdictRefs: string[];
  legacyCleanup: LegacyCleanupStatus;
}

export interface EvalCatInvocationPacket {
  domainId: EvalDomainRegistryEntry['domainId'];
  targetThreadId: string;
  evalCat: EvalDomainRegistryEntry['evalCat'];
  instructions: string;
  context: {
    trendRefs: string[];
    verdictRefs: string[];
    sourceAdapter: EvalDomainRegistryEntry['sourceAdapter'];
    legacyScheduledTaskIds: string[];
    fixtures: EvalDomainRegistryEntry['fixtures'];
    legacyCleanup: LegacyCleanupStatus;
    sla: EvalDomainRegistryEntry['sla'];
  };
}

const DOMAIN_INSTRUCTIONS: Partial<Record<string, string>> = {
  'eval:a2a':
    'Enter the eval:a2a domain thread, load the longitudinal context, compare day-over-day trends, and produce a verdict handoff packet when evidence supports fix/build/keep/delete_sunset. Include legacy scheduled task status in the analysis to prevent duplicate triggers. COUNTER RATE DENOMINATOR (F167 sibling-PR): OTel SDK counters reset to 0 on every API process restart, while the trace store is hydrated from Redis with up to 24h of history. The counter-window block is written as `counter_window` (snake_case) in raw snapshot YAML (`snapshots/*.yaml`) and as `counterWindow` (camelCase) in bundle JSON (`bundles/*/snapshot.json`) — both refer to the same field; check whichever artifact you are reading. If the counter-window block is present, use `counter_window.duration_hours` / `counterWindow.durationHours` — NOT `window.duration_hours` / `window.durationHours` — as the denominator for any counter-based rate (e.g. `activationCounts.X / counterWindow.durationHours`). When the counter-window duration is < 2 hours, downgrade counter-derived rate confidence by one level (recent restart = short accumulation window, rate is noisy). If the counter-window block is absent (older server build), flag as telemetry gap and accept that counter rates may underreport. GROUNDING SUBDOMAIN (F167 Phase O): examine the grounding-phase-o component — check grounding.check_total (shadow checks run on stateful tools), grounding.verdict_total (verdicts produced), grounding.mismatch_sample_count (claim-source mismatches). If mismatch_sample_count > 0, review groundingSampleEvidence for recurring patterns. Grounding runs in shadow mode (never blocks) — report whether shadow data suggests high-confidence mismatch patterns that warrant escalation to fail-closed, or whether the distribution is healthy (mostly verified/insufficient with few mismatches). PHASE Q HOLD LIFECYCLE: examine the hold-lifecycle-phase-q component — hold_lifecycle.event_retired_total and hold_lifecycle.stale_wake_suppressed_total are healthy activation counters, while hold_lifecycle.expired_after_satisfied_total is zero-tolerance: any nonzero value is a high-severity regression and should be reviewed with per-fire sample evidence when present. F167 EVENT-BACKED ROUTING EXIT: examine the event-backed-routing-exit component — compare event_wait.bypass_total, event_wait.rejected_stale_total, event_wait.rejected_unrelated_total, event_wait.rejected_uncovered_total, event_wait.rejected_query_failed_total, event_wait.rejected_other_total, and event_wait.redundant_hold_prevented_total; event_wait.rejected_other_total closes accounting for missing_invocation, no_candidate, and proof_invalid. event_wait.false_bypass_total is zero-tolerance and any nonzero value is a high-severity fail-closed regression. ACTION SUCCESSOR CARRIER MIGRATION: inspect successor.single_target_multi_mention_rate, successor.unfenced_single_target_multi_mention, successor.action_fence_unavailable, and successor.agent_key_action_rejected. A nonzero action_fence_unavailable now isolates durable admission/wiring failure and warrants a fix verdict. agent_key_action_rejected is expected fail-closed behavior because persistent-agent credentials lack invocation provenance; trend it as caller misuse, not a wiring regression. Trend single-target multi_mention toward zero while excluding legitimate explicit parallel observations. PHASE T TURN-CUSTODY STOP GATE: examine the turn-custody-stop-gate component. Record turn_custody.old_only_block_total and turn_custody.projected_block_increase_total only as behavior-delta observations, never as equivalence or correctness redlines; trend turn_custody.unknown_legacy_rate as migration context. The full authoritative turn_custody.new_only_block_total denominator must equal justified + unjustified + unexplained; any classification gap, unjustified row, or unexplained row is zero-tolerance. Also require zero protocol_action_without_custody, user_nudge_required, same_subject_post_terminal_enqueue, and lease_succeeded_subject_nonterminal. Bounded trace samples explain rows but never substitute for the metric denominator. no-data confidence on grounding-phase-o, event-backed-routing-exit, or turn-custody-stop-gate means the hook is not wired or required counters were not exposed — flag as telemetry gap.',
  'eval:memory':
    'Enter the eval:memory domain thread, load recall quality and library health trends, compare day-over-day recall metrics (MRR, precision@K, abandonment) and library health indicators (orphan edges, stale anchors, verification debt), and produce a verdict handoff packet when evidence supports fix/build/keep/delete_sunset.',
  'eval:sop':
    'Enter the eval:sop domain thread, load the SOP definition for the target domain, trace session commands / changedFiles / changedFileEvents / env / git state against machine-checkable predicates, and produce a per-rule violation report. `trace.changedFiles` is REQUIRED: include every changed repo-relative path observed in the session, or an explicit empty array `[]` when no files changed. For convention-surface edits, include `changedFileEvents` with path plus eventNo or timestamp, and include command ordering using the same coordinate (`eventNo` with `eventNo`, or `timestamp` with `timestamp`) so pre-edit graph evidence is replayable. Hand off actionable violations to the rule owner (skill maintainer) with trace evidence.',
  'eval:capability-wakeup':
    'Enter the eval:capability-wakeup domain thread, prioritize workspace-navigator first, compare weekly miss-rate trends across capability wakeup traces, separate cognitive / behavioral / attention-dilution misses, and produce a verdict handoff packet when evidence supports fix/build/keep/delete_sunset.',
  'eval:task-outcome':
    'Enter the eval:task-outcome domain thread. Analyze task outcome episodes: review permission cancel signals, proposal reject signals, magic word triggers, and A1 world truth events. Bind signals to episodes, compare weekly cancel rates and terminal-state distributions, identify patterns, and produce a verdict handoff packet. Packet verdict is fix/build/keep_observe/delete_sunset. Terminal-state and signal distributions are evidence, not the packet verdict. Assign 7-class episode verdicts only for terminal episodes you actually reviewed; publish them through sourceRefs.episodeVerdicts. Proxy signals navigate; they do not judge.',
  'eval:friction':
    'Enter the eval:friction domain thread. Review the periodic cross-channel friction rollup report (clusters aggregated from paw-feel markers, tool-call cancels, user feedback, and eval-domain metrics). For each Top-N cluster, weigh its sensor forms (provided in the report), channel diversity (cross-channel recurrence = stronger signal), count, severity, and member evidence refs. The report does NOT pre-assign root cause — YOU assign the 7-class root cause as your own verdict-layer attribution judgment (harness_misfit / tool_gap / environment_drift / vision_gap / translation_gap / execution_gap / taste_gap); do not fabricate attribution — if the evidence is thin, lower your confidence or say so. Phase D contract: `actionableCandidates` are the only clusters eligible for a repair-thread exit, and each may carry a prefilled `followupDraft` you can reuse when you decide a propose_thread is warranted. `referenceOnly` clusters are link-only context (currently eval-domain friction): list / cite them, but do NOT open a second repair thread for them. Produce a verdict handoff packet (fix/build/keep_observe/delete_sunset). Cluster counts + sensor forms are evidence, not the packet verdict. Do not over-fold the long tail — a low-count cluster on a high-severity channel can still warrant a fix verdict.',
  'eval:freshness':
    'Enter the eval:freshness domain thread. Review F254 freshness telemetry across the gate/notice/reinvoke/queued-read lifecycle. Track cat_cafe.freshness.queued_seen as full contiguous get_thread_context reads of same-target queued bodies, and cat_cafe.freshness.queued_handled as queued_seen entries closed by same-invocation cat-level success evidence. The v1 inference is succeeded=handled only when seen and succeeded are anchored to the same outer InvocationRecord id for the same cat; treat any widening of the read-to-handled gap as a possible false inference, crash/cancel preservation issue, or user-visible duplicate wake. Compare queued_seen, queued_handled, gate_held, notice_attached, notice_acked, reinvoke_triggered, and reinvoke_skipped trends. For D2, inspect providerNativeCoverage by provider, carrier, delivery semantics, and tool surface; opportunity, delivered, seen, handled, and missed are distinct. MCP-only cells are partial evidence and must never be reported as all-tool coverage. Replay all eight AC-E9 classes when validating structure. No-data is a telemetry gap with healthy=false, never proof the system is healthy. Publish support is available only when this runtime advertises the wired freshness-closure-replay selector.',
  'eval:qc':
    'Enter the eval:qc domain thread. Analyze the weekly QC pipeline metrics rollup: finding yield (average actionable findings per review), false positive rate (findings rejected by author / total), reviewer delta (formal reviewer new findings vs fresh-context pre-review coverage), and post-merge bug rate (hotfixes within 14-day window per merged PR). Phase C bootstrap provides zero-baseline data — produce a keep_observe verdict noting the zero-data state. As live telemetry sources are wired (future phases), compare week-over-week trends and produce fix/build/keep_observe/delete_sunset verdicts based on whether the QC loop is improving review quality.',
  'eval:anchor-first':
    'Enter the eval:anchor-first domain thread. Analyze the anchor-first preview↔drill open-rate telemetry rollup: per-tool preview response counts, previewed items, drilled unique items, open-rate (drilledUniqueItems / previewedItems), charsSaved (originalChars - returnedChars), drillChars, and double-sided netBenefit (charsSaved - drillChars). Each rollup covers the LATEST 24h in-memory snapshot (event buffer has 24h retention; the weekly firing frequency is how often the eval cat runs, NOT the data window). Compare per-tool stats across the 4 preview tools (pending-mentions, thread-context, list-tasks, get-message) and 2 drill tools (get-message, list-tasks). Also review Adoption Detail / activationCounts adoption_* fields: explicitAnchorCalls, explicitFullCalls, defaultAnchorCalls, defaultFullCalls, legacyEquivalentAnchorCalls, and uniqueCatsExplicitAnchor answer whether cats are actively choosing anchor or only hitting defaults / old equivalent controls. orphanDrills indicates drills whose itemId matched no preview in the window (stale drill pointers, drills outside window, items surfaced before the event log started, or drills that arrived before any preview of that item — temporal causality enforced). Track-1 aggregate snapshot is cross-referenced for volume sanity checks. SUNSET SIGNAL CRITERIA (AC-E3, 双信号 — both required for delete_sunset): The attribution bundle includes pre-computed sunsetSignals per tool and a sunsetAssessment summary. Signal 1 (anchor tax): sunsetSignals.anchorTax=true when openRateByItem > 80% AND netBenefit < 0 — cats drill almost everything, anchor saves nothing; frictionSignal.severity is escalated to high, proposedAction is fix (not sunset — generator cannot confirm Signal 2 blindness; only eval cat escalates to delete_sunset after cross-referencing task-outcome). Signal 2 (blindness — MORE dangerous, token account INVISIBLE): reference-read the latest eval:task-outcome verdict/trend — if task-outcome quality (corrected_success / needs_investigation rates) worsened after anchor deployment and correlates with anchor tool usage, this is the insidious signal that preview is causing judgment errors. F236 does NOT write to eval:task-outcome; cross-reference only. VERDICT MAPPING: Both signals (tax + blindness evidence) → delete_sunset with governance.cvoAcceptRequired=true; ownerAsk.requestedAction MUST specify WHICH tool(s) to sunset. Signal 1 only (tax, no blindness evidence) → fix (investigate whether preview quality can improve to reduce drill rate). Signal 2 only (blindness, no clear tax) → fix (urgent: preview may be causing judgment errors, investigate). Neither signal + healthy data → keep_observe (log as Phase C expansion data basis). Insufficient data (low confidence / few preview events) → keep_observe with note on sample size. For delete_sunset verdicts: specify per-tool sunset in ownerAsk (e.g. "sunset anchor on thread-context, keep anchor on pending-mentions").',
  'eval:design-gate':
    'Enter the eval:design-gate domain thread. Reconstruct eligible Feature/PR episodes only through the F303 canonical source-map adapter: admission plus exact HEAD, gate/self-check, non-author review, landed Alpha, and explicit no-escape consequence or linked incident/fix attribution. Opportunity, behavior, and consequence must all resolve; missing refs and silence are invalid, never success. Report the six-field estimator as a vector (eligible episodes, pre-review unique catches, post-merge divergence escapes, false-positive blocks, extra active minutes, extra review rounds) without a composite score or cat ranking. Discovery, attribution, and acceptance remain separate; same-batch replay is repeatability evidence, not independent acceptance. Until the first four weeks or twenty eligible episodes (whichever comes first) and measurement validity is usable, verdict must be keep_observe. Map keep/tune/missing-capability/sunset to keep_observe/fix/build/delete_sunset only when the source and validity gates authorize it.',
  'eval:trajectory-inspector': TRAJECTORY_INSPECTOR_DOMAIN_INSTRUCTIONS,
};

/** a2a-specific sourceRefs section (snapshot/attribution YAML basenames). */
const PUBLISH_VERDICT_INSTRUCTIONS_A2A = `${PUBLISH_VERDICT_PACKET_INSTRUCTIONS}
You must also supply \`sourceRefs\` (NOT part of packet, separate input field): \`{ snapshotName, attributionName }\` — BASENAMES of your sanitized evidence YAMLs inside \`<harnessFeedbackRoot>/snapshots/\` and \`<harnessFeedbackRoot>/attributions/\` respectively. Path separators / \`..\` will be rejected (allowlist). The tool will NOT fabricate evidence — if you don't provide refs, publish fails.

The MCP tool creates branch \`verdict/auto/{domainSlug}/{verdictId}\` + commits + opens PR. Returns commit SHA + PR URL.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;

/** F192 PR-2: capability-wakeup replay selector sourceRefs. */
const PUBLISH_VERDICT_INSTRUCTIONS_CAPABILITY_WAKEUP = `${PUBLISH_VERDICT_PACKET_INSTRUCTIONS}
You must also supply \`sourceRefs\` (NOT part of packet, separate input field) as a replayable selector:
\`\`\`json
{
  "kind": "capability-wakeup-trial-window",
  "capability": "rich-messaging",
  "windowStartMs": 1759276800000,
  "windowEndMs": 1759363200000
}
\`\`\`

Fields:
- \`kind\` — REQUIRED literal \`"capability-wakeup-trial-window"\` (other selector kinds reserved for future durable trial store)
- \`capability\` — REQUIRED non-empty (e.g. \`rich-messaging\` / \`workspace-navigator\` / \`browser-preview\`); no newlines
- \`windowStartMs\` / \`windowEndMs\` — REQUIRED finite ms epoch; \`windowEndMs\` must be > \`windowStartMs\`. Trial fire time (\`trial.timeSpan.startMs\`) must fall in \`[windowStartMs, windowEndMs)\`
- \`sessionIds\` — OPTIONAL narrowing. Omit it for the default unbiased runtime-session window scan; provide it only when investigating known sessions.
- \`ruleIds\` — OPTIONAL narrowing (filters to specific rule IDs in the static capability-wakeup-rules registry)

Tool resolves the selector by replaying session events via \`buildCapabilityTrace → evaluateCapabilityWakeupTrace → classifyCapabilityWakeupTrials\` — no need for you to pre-sanitize evidence YAMLs. Tool will NOT fabricate evidence — if selector yields zero classified trials, publish fails.

The MCP tool creates branch \`verdict/auto/{domainSlug}/{verdictId}\` + commits + opens PR. Returns commit SHA + PR URL.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;

const PUBLISH_VERDICT_INSTRUCTIONS_TASK_OUTCOME = `${PUBLISH_VERDICT_PACKET_INSTRUCTIONS}
You must also supply \`sourceRefs\` (NOT part of packet, separate input field) as a replayable task-outcome selector:
\`\`\`json
{
  "kind": "task-outcome-snapshot",
  "windowStartMs": 1759276800000,
  "windowEndMs": 1759363200000,
  "episodeVerdicts": [
    { "episodeId": "ep-...", "verdict": "corrected_success" }
  ]
}
\`\`\`

Fields:
- \`kind\` — REQUIRED literal \`"task-outcome-snapshot"\`
- \`windowStartMs\` / \`windowEndMs\` — REQUIRED finite ms epoch; \`windowEndMs\` must be > \`windowStartMs\`
- \`databasePath\` — OPTIONAL repo-relative DB override under repo root; absolute paths and \`..\` traversal are forbidden. Defaults to repo-root \`task-outcome-episodes.sqlite\`
- \`evidenceCatId\` — OPTIONAL cat filter for event-memory evidence linking
- \`episodeVerdicts\` — OPTIONAL explicit 7-class writeback list for terminal episodes in the selected window. Use only after reviewing the episode evidence. Valid verdicts: \`success\`, \`corrected_success\`, \`needs_investigation\`, \`harness_fix_needed\`, \`routing_failure\`, \`taste_mismatch\`, \`abandoned\`. Replacement publishes may repeat the exact stored verdict idempotently; any different value is rejected so audit history cannot be rewritten.

Tool resolves the selector by loading task-outcome episodes/signals for the time window, bundling replay data under \`docs/harness-feedback/bundles/<verdictId>/raw/\`, writing the live verdict artifacts in the isolated worktree, and applying any explicit \`episodeVerdicts\` to the task-outcome DB. Tool will NOT fabricate evidence — if the DB path is missing, the selector is invalid, or an \`episodeVerdicts[].episodeId\` is outside the selected terminal window, publish fails.

The MCP tool creates branch \`verdict/auto/{domainSlug}/{verdictId}\` + commits + opens PR. Returns commit SHA + PR URL.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;

/** F192 publish_verdict eval:memory replay selector sourceRefs. */
const PUBLISH_VERDICT_INSTRUCTIONS_MEMORY = `${PUBLISH_VERDICT_PACKET_INSTRUCTIONS}
You must also supply \`sourceRefs\` (NOT part of packet, separate input field) as a replayable selector:
\`\`\`json
{
  "kind": "memory-recall-snapshot",
  "windowDays": 30,
  "catId": "opus-47",
  "toolName": "cat_cafe_search_evidence"
}
\`\`\`

Fields:
- \`kind\` — REQUIRED literal \`"memory-recall-snapshot"\`
- \`windowDays\` — REQUIRED integer in range [1, 90] (matches the recall metrics API ceiling: \`GET /api/recall/metrics?days=...\`)
- \`catId\` — OPTIONAL non-empty (restrict to a specific cat id; no newlines)
- \`toolName\` — OPTIONAL non-empty (restrict to a specific recall tool, e.g. \`cat_cafe_search_evidence\`; no newlines)

Tool resolves the selector by calling \`RecallMetricsComputer.computeMetrics({days, catId, toolName})\` + \`computeLibraryHealth(...)\` — no need for you to pre-sanitize evidence YAMLs. Tool will NOT fabricate evidence — if the window yields zero recall events (\`totalEvents=0\`), publish fails with \`404 no_metrics_in_window\` so you widen the window or relax the filters before retrying.

The MCP tool creates branch \`verdict/auto/{domainSlug}/{verdictId}\` + commits + opens PR. Returns commit SHA + PR URL. Bundle contains snapshot.json + attribution.json + provenance.json (sha256 of \`generated/memory/{verdictId}/{recall-metrics,library-health}.json\` for replay).

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;

/** Only domains with wired generators get publish instructions and sourceRefs shape. */
const PUBLISH_VERDICT_INSTRUCTIONS_SOP = `${PUBLISH_VERDICT_PACKET_INSTRUCTIONS}
You must also supply \`sourceRefs\` (NOT part of packet, separate input field) as a replayable SOP trace selector:
\`\`\`json
{
  "kind": "sop-trace-eval",
  "sopDefinitionId": "development",
  "trace": {
    "sessionId": "sess-xxx",
    "sopDefinitionId": "development",
    "observedStage": "worktree",
    "commands": [
      {"command": "git worktree add ...", "exitCode": 0, "eventNo": 1},
      {
        "command": "pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool --name cat_cafe_post_message",
        "exitCode": 0,
        "eventNo": 4,
        "summary": {
          "targets": [{"domainId": "mcp-tool", "filePath": "packages/mcp-server/src/tools/callback-tools.ts"}],
          "freshness": {"stale": false}
        }
      }
    ],
    "changedFiles": ["packages/mcp-server/src/tools/callback-tools.ts"],
    "changedFileEvents": [{"path": "packages/mcp-server/src/tools/callback-tools.ts", "eventNo": 5}],
    "envSnapshot": {"REDIS_URL": "redis://localhost:6398"},
    "gitState": {"branch": "feat/x", "ahead": 0, "behind": 0, "clean": true},
    "handles": {"author": "opus", "reviewer": "codex"},
    "shaContext": {}
  }
}
\`\`\`

Fields: \`kind\` REQUIRED literal \`"sop-trace-eval"\`; \`sopDefinitionId\` REQUIRED non-empty catalog id; \`trace\` REQUIRED full SopTrace object with sessionId, sopDefinitionId, observedStage, commands, changedFiles (REQUIRED array; use explicit empty array \`[]\` when no files changed), optional changedFileEvents (path + eventNo or timestamp), envSnapshot, gitState ({branch, ahead, behind, clean}), handles, shaContext. Command entries may include \`eventNo\`/\`timestamp\`, \`stdout\` or parsed \`summary\`; for convention-graph \`code-consumers\` evidence, include command ordering that shares a coordinate with changedFileEvents (do not mix command \`timestamp\` with changed-file \`eventNo\` unless both sides also include a shared field) plus JSON result with \`targets[].domainId\` and \`targets[].filePath\` coverage for the changed convention surface so it is provably pre-edit and \`freshness.stale === false\` is replayable. Stale, missing target coverage, missing freshness, or missing comparable pre-edit ordering does not satisfy convention-surface blockers.

For F303 route/consumer admission, include optional \`diffContext\` with full 40-character \`baseSha\`/\`headSha\` and every changed file's \`path\` + \`addedLines\`. When added route/consumer lines touch auth/policy/resolver/cursor/lifecycle helpers, include \`designGateReviewPacket\`: \`exactHeadSha\`, typed \`riskClaims\` (including \`consumer_delta\`, canonical source, consumer evidence, and claim guard), plus one successful \`targetedSelfCheckReceipts\` entry per claim whose claimId, headSha, and command match. Partial diff coverage, duplicate claim IDs, mismatched HEAD, missing evidence, or failed/mismatched receipts fail closed.
Tool resolves the selector by building a SopTrace from the embedded trace data, loading the SOP definition from the shared catalog, running \`evaluateSopDefinition(definition, trace)\`, and writing the results as bundle artifacts (snapshot.json, attribution.json, provenance.json) + raw inputs (trace.json, eval-results.json). Tool will NOT fabricate evidence — if the trace fails schema validation or the definition ID is unknown, publish fails.

The MCP tool creates branch \`verdict/auto/{domainSlug}/{verdictId}\` + commits + opens PR. Returns commit SHA + PR URL.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;

const PUBLISH_VERDICT_INSTRUCTIONS_FRICTION = `${PUBLISH_VERDICT_PACKET_INSTRUCTIONS}
You must also supply \`sourceRefs\` (NOT part of packet, separate input field) as a replayable friction-rollup selector:
\`\`\`json
{
  "kind": "friction-rollup-snapshot",
  "windowStartMs": 1759276800000,
  "windowEndMs": 1759363200000,
  "topN": 10,
  "tokenCap": 4000
}
\`\`\`

Fields:
- \`kind\` — REQUIRED literal \`"friction-rollup-snapshot"\`
- \`windowStartMs\` / \`windowEndMs\` — REQUIRED finite ms epoch; \`windowEndMs\` must be > \`windowStartMs\` (the rollup window over which cross-channel friction signals are aggregated)
- \`topN\` — OPTIONAL deep-dive quota override (positive integer; default 10 — Top-N clusters keep full member evidence, the long tail is folded into a summary)
- \`tokenCap\` — OPTIONAL token hard-cap override (positive integer; default 4000)

Tool resolves the selector by composing the 4 read-only friction channels (paw-feel markers / tool-call cancels / user feedback / eval-domain metrics) over the window, aggregating + clustering into a FrictionRollupReport, and bundling replay data under \`docs/harness-feedback/bundles/<verdictId>/raw/\`. Read-only (KD-4): no writeback to any source store. Tool will NOT fabricate evidence — an empty window yields a no-finding record, not invented clusters.

The MCP tool creates branch \`verdict/auto/{domainSlug}/{verdictId}\` + commits + opens PR. Returns commit SHA + PR URL.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;

const PUBLISH_VERDICT_INSTRUCTIONS_ANCHOR_FIRST = `${PUBLISH_VERDICT_PACKET_INSTRUCTIONS}
You must also supply \`sourceRefs\` (NOT part of packet, separate input field) as a replayable anchor-telemetry selector:
\`\`\`json
{
  "kind": "anchor-telemetry-snapshot",
  "windowStartMs": 1759276800000,
  "windowEndMs": 1759363200000
}
\`\`\`

Fields:
- \`kind\` — REQUIRED literal \`"anchor-telemetry-snapshot"\`
- \`windowStartMs\` / \`windowEndMs\` — REQUIRED finite ms epoch; \`windowEndMs\` must be > \`windowStartMs\` (the window over which preview↔drill events are aggregated into the open-rate rollup)

Tool resolves the selector by computing the anchor telemetry rollup over the specified window (per-tool preview↔drill join, open-rate, double-sided netBenefit, orphanDrills) and bundling the rollup snapshot + Track-1 aggregate cross-reference. Tool will NOT fabricate evidence — if the window yields zero preview events, the rollup is empty (no perTool entries).

The MCP tool creates branch \`verdict/auto/{domainSlug}/{verdictId}\` + commits + opens PR. Returns commit SHA + PR URL.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;

const PUBLISH_VERDICT_INSTRUCTIONS_QC = `${PUBLISH_VERDICT_PACKET_INSTRUCTIONS}
You must also supply \`sourceRefs\` (NOT part of packet, separate input field) as a replayable QC metrics selector:
\`\`\`json
{
  "kind": "qc-metrics-rollup",
  "windowStartMs": 1759276800000,
  "windowEndMs": 1759363200000
}
\`\`\`

Fields:
- \`kind\` — REQUIRED literal \`"qc-metrics-rollup"\`
- \`windowStartMs\` / \`windowEndMs\` — REQUIRED finite ms epoch; \`windowEndMs\` must be > \`windowStartMs\` (the window over which QC metrics — finding yield, false positive rate, reviewer delta, post-merge bug rate — are aggregated)

Use the canonical QC \`metricRefs\`: \`metric:finding_yield\`, \`metric:false_positive_rate\`, \`metric:reviewer_delta\`, \`metric:post_merge_bug_rate\`, and \`metric:pr_count\`.

Tool resolves the selector by computing the QC metrics rollup over the specified window and bundling the snapshot. Phase C bootstrap: metrics are zero-baseline (no live data source wired yet). Tool will NOT fabricate evidence.

The MCP tool creates branch \`verdict/auto/{domainSlug}/{verdictId}\` + commits + opens PR. Returns commit SHA + PR URL.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;

const PUBLISH_VERDICT_INSTRUCTIONS_FRESHNESS = `${PUBLISH_VERDICT_PACKET_INSTRUCTIONS}${FRESHNESS_PUBLISH_SELECTOR_INSTRUCTIONS}`;

const PUBLISH_VERDICT_INSTRUCTIONS_DESIGN_GATE = `${PUBLISH_VERDICT_PACKET_INSTRUCTIONS}
You must also supply \`sourceRefs\` as the server-owned \`design-gate-episode-source-map\` selector. Discover candidate maps under \`docs/harness-feedback/design-gate/source-maps/\`; choose the unique cumulative map with the greatest \`window.endMs\`, and pass its filename stem as \`sourceMapId\`. The API rejects stale, ambiguous, or non-cumulative selections instead of silently replaying a frozen bootstrap window.
The source map contains canonical refs only. The API re-resolves admission, GitHub exact HEAD and self-check, persisted non-author review, landed Alpha, and consequence sources. Do not copy source prose or submit caller-authored episode facts. Use the six canonical metric refs for the vector. Missing/invalid sources, immature observation, or insufficient validity allow only \`keep_observe\`.

The MCP tool creates the existing isolated evidence branch and PR. Do not write or push verdict artifacts directly.
`;

const PUBLISH_VERDICT_INSTRUCTIONS_TRAJECTORY_INSPECTOR = `${PUBLISH_VERDICT_PACKET_INSTRUCTIONS}${TRAJECTORY_INSPECTOR_PUBLISH_SELECTOR_INSTRUCTIONS}`;

const PUBLISH_VERDICT_INSTRUCTIONS_BY_DOMAIN: Partial<Record<string, string>> = {
  'eval:a2a': PUBLISH_VERDICT_INSTRUCTIONS_A2A,
  'eval:capability-wakeup': PUBLISH_VERDICT_INSTRUCTIONS_CAPABILITY_WAKEUP,
  'eval:memory': PUBLISH_VERDICT_INSTRUCTIONS_MEMORY,
  'eval:sop': PUBLISH_VERDICT_INSTRUCTIONS_SOP,
  'eval:task-outcome': PUBLISH_VERDICT_INSTRUCTIONS_TASK_OUTCOME,
  'eval:friction': PUBLISH_VERDICT_INSTRUCTIONS_FRICTION,
  'eval:anchor-first': PUBLISH_VERDICT_INSTRUCTIONS_ANCHOR_FIRST,
  'eval:qc': PUBLISH_VERDICT_INSTRUCTIONS_QC,
  'eval:freshness': PUBLISH_VERDICT_INSTRUCTIONS_FRESHNESS,
  'eval:design-gate': PUBLISH_VERDICT_INSTRUCTIONS_DESIGN_GATE,
  'eval:trajectory-inspector': PUBLISH_VERDICT_INSTRUCTIONS_TRAJECTORY_INSPECTOR,
};

/** Registry census hook: report instruction wiring without duplicating either map. */
export function hasEvalDomainInstructions(domainId: string): boolean {
  return DOMAIN_INSTRUCTIONS[domainId] !== undefined;
}

/** Registry census hook: report publish-generator wiring without duplicating either map. */
export function hasEvalDomainPublishInstructions(domainId: string): boolean {
  return PUBLISH_VERDICT_INSTRUCTIONS_BY_DOMAIN[domainId] !== undefined;
}

/** Emit publish instructions only when a domain generator is wired in this runtime. */
function domainInstructions(
  domainId: EvalDomainRegistryEntry['domainId'],
  wiredDomains?: ReadonlySet<EvalDomainRegistryEntry['domainId']>,
): string {
  const base = DOMAIN_INSTRUCTIONS[domainId];
  if (!base) {
    throw new Error(`No eval-cat instructions registered for domain '${domainId}' (fail-closed)`);
  }
  const publishSection = PUBLISH_VERDICT_INSTRUCTIONS_BY_DOMAIN[domainId];
  if (!publishSection) return base;
  // If wiredDomains explicitly provided, gate on actual runtime support.
  if (wiredDomains !== undefined && !wiredDomains.has(domainId)) return base;
  return base + publishSection;
}

export interface BuildEvalCatInvocationOpts {
  /** Omit publish instructions for unwired domains; undefined preserves legacy default. */
  wiredPublishDomains?: ReadonlySet<EvalDomainRegistryEntry['domainId']>;
}

export function buildEvalCatInvocation(
  input: EvalCatInvocationInput,
  opts: BuildEvalCatInvocationOpts = {},
): EvalCatInvocationPacket {
  const domain = parseEvalDomainRegistryEntry(input.domain);
  return {
    domainId: domain.domainId,
    targetThreadId: domain.systemThreadId,
    evalCat: domain.evalCat,
    instructions: domainInstructions(domain.domainId, opts.wiredPublishDomains),
    context: {
      trendRefs: input.trendRefs,
      verdictRefs: input.verdictRefs,
      sourceAdapter: domain.sourceAdapter,
      legacyScheduledTaskIds: domain.legacyScheduledTaskIds,
      fixtures: domain.fixtures,
      legacyCleanup: input.legacyCleanup,
      sla: domain.sla,
    },
  };
}
