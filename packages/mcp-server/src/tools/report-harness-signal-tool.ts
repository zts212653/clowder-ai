import { z } from 'zod';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

/**
 * F257 V1: cat_cafe_report_harness_signal — manual_observation 写入支
 * (redesign §4.8② 语义上报层).
 *
 * Contract single source of truth: T-C (§3.6). The server injects
 * recordedBy/ownerUserId from the callback principal and enforces the three
 * anchor validations — this tool only ships the observation payload.
 * KEEP IN SYNC: packages/api/src/infrastructure/harness-eval/deviation/
 * report-harness-signal.ts reportHarnessSignalBodySchema.
 */

const unitRefShape = z.object({
  unitType: z
    .string()
    .min(1)
    .describe("Registered unit type. V1 registry: 'segment' only (skill/sop/mcp_gotcha land with later slices)."),
  unitId: z.string().min(1).describe('Unit instance id, e.g. a segment id from the segment registry.'),
});

const attributionShape = z.object({
  objectiveId: z.string().min(1).describe('Objective this deviation counts against (e.g. obj-routing-delivery).'),
  unitRefs: z.array(unitRefShape).min(1).describe('Units (e.g. prompt segments) this observation attributes to.'),
  weight: z
    .number()
    .gt(0)
    .max(1)
    .describe(
      'Attribution weight in (0,1]. NOT part of incident identity — re-reporting with a different weight is still the same incident.',
    ),
});

const sourceAnchorShape = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('thread_message'),
      messageId: z.string().min(1).describe('Message the observation is anchored to (must exist, same owner).'),
    }),
    z.object({
      kind: z.literal('operator_confirmation'),
      confirmationId: z
        .string()
        .min(1)
        .describe('Operator confirmation id (candidate 转正通道 — not yet backed in V1).'),
    }),
  ])
  .describe(
    'REQUIRED evidence anchor. Anchor-less verbal corrections stay candidates and are NOT reportable via this tool.',
  );

export const reportHarnessSignalInputSchema = {
  sourceAnchor: sourceAnchorShape,
  subjectCatId: z.string().min(1).describe('Cat the observation is ABOUT (independent of who reports it).'),
  source: z
    .enum(['operator', 'peer', 'self'])
    .describe(
      'Who made the semantic judgement: operator (relaying an operator correction — anchor author must then be the operator), peer (you observed another cat), self (self-report).',
    ),
  note: z.string().min(1).describe('What deviated, in one or two sentences. Stored verbatim as governance evidence.'),
  attributions: z.array(attributionShape).min(1).describe('objectiveId must be unique across entries.'),
  idempotencyKey: z
    .string()
    .min(1)
    .optional()
    .describe('Optional network-retry token (scoped to you + thread). Reuse ONLY when retrying the same call.'),
  agentKeyCatId: z
    .string()
    .min(1)
    .optional()
    .describe('Persistent-agent identity selector. Required for shared Antigravity MCP.'),
};

interface ReportHarnessSignalToolInput {
  sourceAnchor:
    | { kind: 'thread_message'; messageId: string }
    | { kind: 'operator_confirmation'; confirmationId: string };
  subjectCatId: string;
  source: 'operator' | 'peer' | 'self';
  note: string;
  attributions: Array<{ objectiveId: string; unitRefs: Array<{ unitType: string; unitId: string }>; weight: number }>;
  idempotencyKey?: string;
  agentKeyCatId?: string;
}

export async function handleReportHarnessSignalTool(input: ReportHarnessSignalToolInput): Promise<ToolResult> {
  const { agentKeyCatId, ...body } = input;
  return callbackPost('/api/callbacks/harness-signals/report', body, {
    ...(agentKeyCatId ? { agentKeyCatId } : {}),
    // T-C await-append: the write is synchronous and idempotency-guarded server-side;
    // auto-retry replaying a non-idempotent POST is the failure mode to avoid.
    retryDelaysMs: [],
  });
}

export const reportHarnessSignalTools = [
  {
    name: 'cat_cafe_report_harness_signal',
    description:
      'F257: report a SEMANTIC deviation observation (manual_observation) into the harness deviation ledger. ' +
      'Use when you observe behavior drifting from an objective (跑歪/绕路/身份漂移/该退不退…) and the judgement ' +
      'cannot be expressed as a static predicate — operator corrections you are relaying (source=operator), ' +
      'observations about another cat (source=peer), or self-reports (source=self). ' +
      'Your identity is attached server-side from your callback principal (recordedBy) — subjectCatId is who the observation is ABOUT. ' +
      'GOTCHA: sourceAnchor is REQUIRED and must point at an existing same-owner message; source=operator additionally requires that message to be authored by the operator. No anchor → do not report; ask the operator to confirm first. ' +
      'GOTCHA: outcome=incident_claimed means the same incident (same anchor+subject+objective/unit set) is already recorded under the returned eventId — this is dedup, not an error; do not retry with tweaked weights. ' +
      'GOTCHA: this is a governance evidence ledger (TTL=0) — report observed deviations, not speculation; put the reasoning in note. ' +
      'F257 V2 (撞到 4xx 锅拦截 → anomaly 上报引用 ledger id): when a tool call was REJECTED (4xx) and the rejection ' +
      'response carried a `ledgerId` (e.g. mcp/hold-ball-rate-limit), quote that EXACT ledgerId string in your note — ' +
      'it attributes the friction to that guard pot (idempotent stats + eval:friction guard-anomaly channel).',
    inputSchema: reportHarnessSignalInputSchema,
    handler: handleReportHarnessSignalTool,
  },
] as const;
