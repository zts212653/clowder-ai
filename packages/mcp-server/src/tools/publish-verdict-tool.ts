import { z } from 'zod';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

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
 * eval:capability-wakeup (replayable window selector), and the PR1 schema-only
 * task-outcome selector surface. Tool routes to the same
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
      .describe('Optional explicit per-episode writeback list. Omit when no terminal episodes are ready.'),
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

const sourceRefsShape = z
  .union([a2aSourceRefsShape, capabilityWakeupSourceRefsShape, taskOutcomeSourceRefsShape, memorySourceRefsShape])
  .describe(
    'Discriminated union by `kind` field. a2a kind is default (backward compat); capability-wakeup-trial-window kind wired in PR-2; memory-recall-snapshot kind wired in F192 memory wire-up; task-outcome-snapshot kind is PR1 schema-only until its generator lands.',
  );

export const publishVerdictInputSchema = {
  domainId: z
    .string()
    .min(1)
    .describe('Your assigned eval domain (eval:a2a / eval:capability-wakeup in v2). Must match packet.domainId.'),
  packet: verdictPacketShape,
  sourceRefs: sourceRefsShape,
  // 砚砚 R4 P1 + cloud R4 P1: catId is NOT a cat-supplied field — server
  // derives it from the trusted callback principal (invocationId → registry).
  // Removed from input schema; agentKeyCatId stays for shared-MCP routing.
  agentKeyCatId: z
    .string()
    .min(1)
    .optional()
    .describe('Persistent-agent identity selector. Required for shared Antigravity MCP.'),
};

/** Inferred input type (matches discriminated union). */
type PublishVerdictToolInput = {
  domainId: string;
  packet: Record<string, unknown>;
  sourceRefs:
    | { kind?: 'a2a-snapshot-attribution'; snapshotName: string; attributionName: string }
    | {
        kind: 'capability-wakeup-trial-window';
        capability: string;
        windowStartMs: number;
        windowEndMs: number;
        sessionIds: string[];
        ruleIds?: string[];
      }
    | {
        kind: 'task-outcome-snapshot';
        windowStartMs: number;
        windowEndMs: number;
        databasePath?: string;
        evidenceCatId?: string;
      }
    | {
        kind: 'memory-recall-snapshot';
        windowDays: number;
        catId?: string;
        toolName?: string;
      };
  agentKeyCatId?: string | undefined;
};

export async function handlePublishVerdict(input: PublishVerdictToolInput): Promise<ToolResult> {
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
      'F192 Phase H: publish your eval verdict as a structured commit + auto-PR. ' +
      'Use after your analysis converges to a verdict for your assigned eval domain. ' +
      'Pass the complete VerdictHandoffPacket + sourceRefs (shape depends on your domain — see your eval cat invocation instructions for the exact selector shape). ' +
      'The handler validates schema, dispatches to the per-domain generator inside an isolated git worktree, commits + pushes the branch verdict/auto/<domain-slug>/<verdict-id>, and opens an auto-PR. Returns { commitSha, prUrl }. ' +
      'GOTCHA: wired domains: eval:a2a (snapshot/attribution YAML basenames) + eval:capability-wakeup (replayable trial-window selector) + eval:memory (memory-recall-snapshot selector with windowDays + optional catId/toolName filters) + eval:task-outcome (task-outcome-snapshot replay window). Other domains return 501. ' +
      'GOTCHA: catId must match the registered eval cat for the domain (or its OQ-20 Redis override); 403 not_allowed otherwise. ' +
      'GOTCHA: DO NOT run git push/commit/add yourself; this tool owns the publish lifecycle.',
    inputSchema: publishVerdictInputSchema,
    handler: handlePublishVerdict,
  },
] as const;
