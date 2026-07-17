import { z } from 'zod';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const singleLine = (label: string) =>
  z
    .string()
    .min(1)
    .refine((value) => !/[\r\n]/.test(value), `${label} must be a single-line value`);

export const previewSessionRecoveryTrialsInputSchema = {
  windowStartMs: z
    .number()
    .finite()
    .nonnegative()
    .describe('Inclusive target Session creation time, epoch milliseconds.'),
  windowEndMs: z
    .number()
    .finite()
    .nonnegative()
    .describe('Exclusive target Session creation time, epoch milliseconds; must be after windowStartMs, max 31 days.'),
  catId: singleLine('catId').optional().describe('Optional cat identity filter.'),
  threadId: singleLine('threadId').optional().describe('Optional thread filter.'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum projected trials; defaults to 50.'),
  agentKeyCatId: singleLine('agentKeyCatId')
    .optional()
    .describe('Persistent-agent identity selector. Required for shared Antigravity MCP.'),
};

export interface PreviewSessionRecoveryTrialsInput {
  windowStartMs: number;
  windowEndMs: number;
  catId?: string;
  threadId?: string;
  limit?: number;
  agentKeyCatId?: string;
}

const evidenceKind = z.enum(['source_digest', 'source_events', 'target_opening_invocation']);

export const readSessionRecoveryEvidenceInputSchema = {
  ...previewSessionRecoveryTrialsInputSchema,
  trialId: singleLine('trialId')
    .refine((value) => value.startsWith('session-recovery:'), 'trialId must be a session-recovery anchor')
    .describe('Trial anchor returned by cat_cafe_preview_session_recovery_trials.'),
  evidenceKind: evidenceKind.describe(
    'Fixed trial-relative evidence surface; callers cannot supply an arbitrary sessionId or invocationId.',
  ),
  cursor: z.number().int().nonnegative().optional().describe('Event cursor for source_events.'),
  eventLimit: z.number().int().min(1).max(200).optional().describe('Event page size; defaults to 50.'),
  view: z.enum(['raw', 'chat', 'handoff']).optional().describe('Event view; defaults to raw.'),
};

export interface ReadSessionRecoveryEvidenceInput extends PreviewSessionRecoveryTrialsInput {
  trialId: string;
  evidenceKind: z.infer<typeof evidenceKind>;
  cursor?: number;
  eventLimit?: number;
  view?: 'raw' | 'chat' | 'handoff';
}

export async function handlePreviewSessionRecoveryTrials(
  input: PreviewSessionRecoveryTrialsInput,
): Promise<ToolResult> {
  return callbackPost(
    `/api/eval-domains/${encodeURIComponent('eval:session-recovery')}/preview-trials`,
    {
      selector: {
        kind: 'session-recovery-window',
        windowStartMs: input.windowStartMs,
        windowEndMs: input.windowEndMs,
        ...(input.catId ? { catId: input.catId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export async function handleReadSessionRecoveryEvidence(input: ReadSessionRecoveryEvidenceInput): Promise<ToolResult> {
  return callbackPost(
    `/api/eval-domains/${encodeURIComponent('eval:session-recovery')}/read-evidence`,
    {
      selector: {
        kind: 'session-recovery-window',
        windowStartMs: input.windowStartMs,
        windowEndMs: input.windowEndMs,
        ...(input.catId ? { catId: input.catId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      trialId: input.trialId,
      evidenceKind: input.evidenceKind,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.eventLimit !== undefined ? { eventLimit: input.eventLimit } : {}),
      ...(input.view ? { view: input.view } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export const sessionRecoveryEvalTools = [
  {
    name: 'cat_cafe_preview_session_recovery_trials',
    description:
      'Preview replayable eval:session-recovery trials for a bounded owner-scoped window. ' +
      'Returns compact observed source/target/invocation/event anchors; it never returns transcript bodies or fabricates missing-target trials. ' +
      'Inspect source and target with cat_cafe_read_session_recovery_evidence, select the first substantive target event yourself, and submit firstMeaningfulEventRef with the assessment to cat_cafe_publish_verdict. ' +
      'This tool is read-only and does not save assessments. Window maximum is 31 days; result limit maximum is 200. If filtering exceeds the bounded scan, it reports window_too_broad instead of returning incomplete results.',
    inputSchema: previewSessionRecoveryTrialsInputSchema,
    handler: handlePreviewSessionRecoveryTrials,
  },
  {
    name: 'cat_cafe_read_session_recovery_evidence',
    description:
      'Read evidence for one trial returned by cat_cafe_preview_session_recovery_trials. ' +
      'Only the domain evaluator selected by the registry or active OQ-20 override is authorized. The API re-resolves the trial inside the authenticated owner and selector window, then chooses the source/target Session and opening invocation server-side. ' +
      'No arbitrary sessionId or invocationId is accepted. Use source_digest/source_events for prior intent and target_opening_invocation for current-state checks, firstMeaningfulEventRef, and opening outcome evidence. ' +
      'Source events are read-only context and advertise only the submit-ready source Session ref in evidenceRefs; the opening view is capped to the same first 100 event anchors accepted by publish.',
    inputSchema: readSessionRecoveryEvidenceInputSchema,
    handler: handleReadSessionRecoveryEvidence,
  },
] as const;
