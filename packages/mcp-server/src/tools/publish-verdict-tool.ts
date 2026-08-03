import { z } from 'zod';
import { callbackPost } from './callback-tools.js';
import { errorResult, type ToolResult } from './file-tools.js';
import { freshnessReplaySourceRefsShape } from './publish-verdict-freshness-source-refs.js';
import {
  handleRefreshVerdictAction,
  publishVerdictRefreshActionShape,
  validatePublishVerdictLifecycleInput,
} from './publish-verdict-refresh-action.js';
import { sopSourceRefsShape } from './publish-verdict-sop-source-refs.js';

const PUBLISH_VERDICT_FETCH_TIMEOUT_MS = 120_000;

/**
 * F192 Phase H AC-H4: cat_cafe_publish_verdict MCP tool.
 *
 * 砚砚 R3 P1 #1 cloud: previously DOMAIN_INSTRUCTIONS referenced this tool but
 * it wasn't registered anywhere — cats would loop. Now wired to
 * POST /api/eval-domains/:domainId/publish-verdict which calls
 * handlePublishVerdict (validates packet → resolves sourceRefs → invokes
 * isolated-worktree publisher → opens auto-PR).
 *
 * F192 Phase H 收尾 PR-2 (砚砚 R1 Q3): sourceRefs is now a discriminated union
 * supporting eval:a2a (snapshot/attribution YAML basenames),
 * eval:capability-wakeup (replayable window selector), eval:memory
 * (recall metrics selector), eval:sop (replayable SOP trace selector),
 * and eval:task-outcome (snapshot replay window). Tool routes to the same
 * API endpoint; per-domain generator dispatch happens in the route layer.
 */

const verdictPacketShape = z
  .object({
    id: z.string().min(1),
    domainId: z.string().min(1),
    createdAt: z.string().min(1),
    phenomenon: z.string().min(1),
    verdict: z.enum(['fix', 'build', 'keep_observe', 'delete_sunset']),
  })
  .passthrough()
  .describe(
    'VerdictHandoffPacket — 12 fields total (id, domainId, createdAt, phenomenon, harnessUnderEval, evidencePacket, dailyTrend, rootCauseHypothesis, verdict, ownerAsk, acceptanceReevalPlan, counterarguments; governance optional except delete_sunset). See instructions in your eval cat invocation packet for full schema.',
  );

/**
 * a2a sourceRefs: basenames of pre-sanitized snapshot/attribution YAML files.
 * `kind` is OPTIONAL for backward compat (eval:a2a cats publishing without kind
 * still routes correctly through the discriminated union default).
 */
const a2aSourceRefsShape = z
  .object({
    kind: z.literal('a2a-snapshot-attribution').optional(),
    snapshotName: z
      .string()
      .min(1)
      .describe('Basename of sanitized eval snapshot YAML inside <harnessFeedbackRoot>/snapshots/.'),
    attributionName: z
      .string()
      .min(1)
      .describe('Basename of sanitized attribution YAML inside <harnessFeedbackRoot>/attributions/.'),
  })
  .describe('eval:a2a sourceRefs — basenames only (path separators / .. rejected by API).');

/**
 * F192 Phase H 收尾 PR-2 (砚砚 R1 P1+P2): capability-wakeup sourceRefs is a
 * replayable trial-window selector. Provider replays session events via
 * buildCapabilityTrace → evaluateCapabilityWakeupTrace → classifyCapabilityWakeupTrials.
 *
 * PR-2 narrowed: `sessionIds` REQUIRED non-empty (no global window scan —
 * needs userId/thread enumeration, deferred to future PR with durable trial store).
 */
const capabilityWakeupSourceRefsShape = z
  .object({
    kind: z.literal('capability-wakeup-trial-window'),
    capability: z
      .string()
      .min(1)
      .refine((v) => !/[\r\n]/.test(v), 'capability must not contain newlines (markdown bullet injection)')
      .describe('Capability the verdict is about (e.g. rich-messaging / workspace-navigator / browser-preview).'),
    windowStartMs: z.number().finite().describe('Inclusive — trials with timeSpan.startMs >= this qualify (epoch ms).'),
    windowEndMs: z
      .number()
      .finite()
      .describe('Exclusive — trials with timeSpan.startMs < this qualify. Must be > windowStartMs.'),
    sessionIds: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'REQUIRED non-empty — session IDs to replay (PR-2 narrowed; global window scan deferred to future PR).',
      ),
    ruleIds: z
      .array(z.string().min(1))
      .optional()
      .describe('Optional narrowing — restrict to specific rule IDs in the static capability-wakeup-rules registry.'),
  })
  .describe(
    'eval:capability-wakeup sourceRefs — replayable selector (砚砚 R0 narrowing: window edges + sessionIds required).',
  );

// KEEP IN SYNC: packages/api/src/infrastructure/harness-eval/task-outcome/task-outcome-episode.ts VERDICT_CLASSES.
const taskOutcomeVerdictShape = z.enum([
  'success',
  'corrected_success',
  'needs_investigation',
  'harness_fix_needed',
  'routing_failure',
  'taste_mismatch',
  'abandoned',
]);

const taskOutcomeSourceRefsShape = z
  .object({
    kind: z.literal('task-outcome-snapshot'),
    windowStartMs: z.number().finite().describe('Inclusive epoch ms window start for task-outcome episode replay.'),
    windowEndMs: z
      .number()
      .finite()
      .describe('Exclusive epoch ms window end for task-outcome episode replay. Must be > windowStartMs.'),
    databasePath: z
      .string()
      .min(1)
      .optional()
      .describe('Optional DB path override for replay; PR1 schema-only surface, real generator lands in PR2.'),
    evidenceCatId: z
      .string()
      .min(1)
      .optional()
      .describe('Optional evidence anchor catId for cross-thread linking; PR1 schema-only surface.'),
    episodeVerdicts: z
      .array(
        z.object({
          episodeId: z.string().min(1).describe('Task Outcome episodeId selected by this replay window.'),
          verdict: taskOutcomeVerdictShape.describe('7-class per-episode task outcome verdict assigned by eval cat.'),
        }),
      )
      .min(1)
      .optional()
      .describe(
        'Optional explicit per-episode writeback list. Exact same-value replays are idempotent for replacement publishes; a different value is rejected to preserve audit history.',
      ),
  })
  .describe('eval:task-outcome sourceRefs — replay window selector with optional episode verdict writeback.');

/**
 * F192 publish_verdict eval:memory wire-up — memory-recall-snapshot sourceRefs.
 * Replayable selector against the recall metrics API (`GET /api/recall/metrics`):
 *   - windowDays: integer [1, 90] (API ceiling)
 *   - catId / toolName: optional filters (no newlines — markdown injection guard)
 *
 * Provider resolves selector → {recallMetrics, libraryHealth} which the generator
 * writes into bundle/snapshot.json + bundle/attribution.json + provenance.json
 * + raw inputs at `<repoRoot>/generated/memory/<verdictId>/`.
 */
const memorySourceRefsShape = z
  .object({
    kind: z.literal('memory-recall-snapshot'),
    windowDays: z
      .number()
      .int()
      .min(1)
      .max(90)
      .describe('Inclusive window in days [1, 90] — recall API ceiling (packages/api/src/routes/recall-metrics.ts).'),
    catId: z
      .string()
      .min(1)
      .refine((v) => !/[\r\n]/.test(v), 'catId must not contain newlines (markdown bullet injection)')
      .optional()
      .describe('Optional — restrict to a specific cat id (matches RecallMetricsComputer filters.catId).'),
    toolName: z
      .string()
      .min(1)
      .refine((v) => !/[\r\n]/.test(v), 'toolName must not contain newlines (markdown bullet injection)')
      .optional()
      .describe('Optional — restrict to a specific recall tool (e.g. cat_cafe_search_evidence).'),
  })
  .describe('eval:memory sourceRefs — replayable recall metrics selector (windowDays + optional filters).');

/**
 * F245 Phase C PR1b — friction-rollup-snapshot sourceRefs. Replayable rollup
 * selector: a window the provider resolves to a live FrictionRollupInput (4-channel
 * collect → cluster). Generator writes the Top-N rollup report into bundle/snapshot.json
 * + bundle/attribution.json + provenance.json + raw report under bundle/raw/.
 *
 * KEEP IN SYNC: packages/shared/src/types/friction-signal.ts FrictionRollupSourceSelector
 * + packages/api/.../publish-verdict/validation.ts validateFrictionRollupSelector.
 */
const frictionRollupSourceRefsShape = z
  .object({
    kind: z.literal('friction-rollup-snapshot'),
    windowStartMs: z.number().finite().describe('Inclusive epoch ms window start for friction signal collection.'),
    windowEndMs: z
      .number()
      .finite()
      .describe('Exclusive epoch ms window end for friction signal collection. Must be > windowStartMs.'),
    topN: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Optional deep-dive quota for the rollup report (producer default 10).'),
    tokenCap: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Optional hard token ceiling for the serialized rollup report (producer default 4000).'),
  })
  .describe('eval:friction sourceRefs — replayable rollup window selector (window + optional topN/tokenCap).');

/**
 * F236 Track-2 AC-E4 — anchor-telemetry-snapshot sourceRefs. Replayable rollup
 * window selector: provider resolves to live AnchorTelemetryRollup (per-tool
 * open-rate, charsSaved, drillChars, double-sided netBenefit). Generator writes
 * rollup snapshot + verdict into bundle.
 *
 * KEEP IN SYNC: packages/api/.../publish-verdict/types.ts AnchorTelemetrySourceSelector
 * + packages/api/.../publish-verdict/validation.ts validateAnchorTelemetrySelector.
 */
const anchorTelemetrySourceRefsShape = z
  .object({
    kind: z.literal('anchor-telemetry-snapshot'),
    windowStartMs: z.number().finite().describe('Inclusive epoch ms window start for anchor telemetry rollup.'),
    windowEndMs: z
      .number()
      .finite()
      .describe('Exclusive epoch ms window end for anchor telemetry rollup. Must be > windowStartMs.'),
  })
  .describe('eval:anchor-first sourceRefs — replayable anchor telemetry rollup window selector.');

/**
 * F253 Phase C — qc-metrics-rollup sourceRefs. Replayable QC pipeline metrics
 * window selector: provider resolves finding yield, false positive rate,
 * reviewer delta, and post-merge bug rate over the specified window.
 *
 * KEEP IN SYNC: packages/api/.../publish-verdict/validation.ts validateQcMetricsSelector
 * + packages/api/.../harness-eval/qc-metrics-provider.ts QcMetricsSelector.
 */
const qcMetricsSourceRefsShape = z
  .object({
    kind: z.literal('qc-metrics-rollup'),
    windowStartMs: z.number().finite().describe('Inclusive epoch ms window start for QC metrics rollup.'),
    windowEndMs: z
      .number()
      .finite()
      .describe('Exclusive epoch ms window end for QC metrics rollup. Must be > windowStartMs.'),
  })
  .describe('eval:qc sourceRefs — replayable QC metrics rollup window selector.');

const sourceRefsShape = z
  .union([
    a2aSourceRefsShape,
    capabilityWakeupSourceRefsShape,
    taskOutcomeSourceRefsShape,
    memorySourceRefsShape,
    sopSourceRefsShape,
    frictionRollupSourceRefsShape,
    anchorTelemetrySourceRefsShape,
    qcMetricsSourceRefsShape,
    freshnessReplaySourceRefsShape,
  ])
  .describe(
    'Discriminated union by `kind` field. a2a kind is the backward-compatible default; replayable selectors are wired for capability wakeup, memory, task outcome, SOP, friction, anchor telemetry, QC metrics, and F254 freshness closures.',
  );

export const publishVerdictInputSchema = {
  domainId: z.string().min(1).describe('Your assigned registered eval domain. Must match packet.domainId.'),
  packet: verdictPacketShape.optional(),
  sourceRefs: sourceRefsShape.optional(),
  action: publishVerdictRefreshActionShape.optional(),
  // 砚砚 R4 P1 + cloud R4 P1: catId is NOT a cat-supplied field — server
  // derives it from the trusted callback principal (invocationId → registry).
  // Removed from input schema; agentKeyCatId stays for shared-MCP routing.
  agentKeyCatId: z
    .string()
    .min(1)
    .optional()
    .describe('Persistent-agent identity selector. Required for shared Antigravity MCP.'),
};

const publishVerdictInputObjectSchema = z.object(publishVerdictInputSchema);
type PublishVerdictToolInput = z.input<typeof publishVerdictInputObjectSchema>;

export async function handlePublishVerdict(input: PublishVerdictToolInput): Promise<ToolResult> {
  const lifecycleError = validatePublishVerdictLifecycleInput(input);
  if (lifecycleError) return errorResult(lifecycleError);
  if (input.action?.kind === 'refresh_pr') {
    return handleRefreshVerdictAction({
      domainId: input.domainId,
      action: input.action,
      ...(input.agentKeyCatId ? { agentKeyCatId: input.agentKeyCatId } : {}),
    });
  }
  return callbackPost(
    `/api/eval-domains/${encodeURIComponent(input.domainId)}/publish-verdict`,
    {
      packet: input.packet,
      sourceRefs: input.sourceRefs,
    },
    {
      agentKeyCatId: input.agentKeyCatId,
      // publish_verdict is long-running and non-idempotent: let the original
      // POST finish instead of timing out at 10s and replaying the same packet.
      retryDelaysMs: [],
      fetchTimeoutMs: PUBLISH_VERDICT_FETCH_TIMEOUT_MS,
    },
  );
}

export const publishVerdictTools = [
  {
    name: 'cat_cafe_publish_verdict',
    description:
      'Publish a converged eval-domain verdict as a structured commit and auto-PR. ' +
      'Use when: your analysis has converged for the eval domain assigned to you. ' +
      'NOT for: manually writing verdict files or running git add/commit/push; this tool owns that publish lifecycle. ' +
      'For initial publish, pass packet + sourceRefs. For an open auto-verdict PR whose base moved, pass action={kind:"refresh_pr", verdictId, expectedHeadSha}; do not replay packet/writeback. ' +
      'Output: validates the packet, generates evidence in an isolated worktree, pushes verdict/auto/<domain-slug>/<verdict-id>, opens an auto-PR, and returns { commitSha, prUrl }. ' +
      'GOTCHA: wired domains include eval:a2a plus replayable capability-wakeup, memory, SOP, task-outcome, friction, anchor-first, freshness, and QC generators. Unregistered or runtime-unwired domains return 501. ' +
      'GOTCHA: catId must match the registered eval cat for the domain (or its OQ-20 Redis override); 403 not_allowed otherwise. ' +
      'GOTCHA: every evidencePacket.metricRefs entry must resolve against the selected domain glossary; unknown refs return 400 before any evidence branch or PR is created. ' +
      'GOTCHA: refresh_pr verifies exact HEAD, auto-verdict provenance, target-only diff scope, and only auto-resolves the derived measurement census conflict; any other conflict fails closed. ' +
      'GOTCHA: replacement publishes may repeat an exact stored episode verdict, but refresh_pr is preferred when the existing PR only needs a current-base census refresh.',
    inputSchema: publishVerdictInputSchema,
    handler: handlePublishVerdict,
  },
] as const;
