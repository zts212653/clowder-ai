/**
 * F192 Phase G — Task Outcome Episode schema.
 *
 * Episode is the evaluation unit: a bounded task lifecycle with
 * attached signals (A1 world truth, A2 interaction decisions, proxy).
 * Verdict is filled by eval cat, not by the system.
 *
 * Design source: docs/discussions/2026-06-03-eval-task-outcome-plan.md
 */
import { z } from 'zod';

// ---- Verdict classes (not scores — categorical) ----

export const VERDICT_CLASSES = [
  'success',
  'corrected_success',
  'needs_investigation',
  'harness_fix_needed',
  'routing_failure',
  'taste_mismatch',
  'abandoned',
] as const;

export type TaskOutcomeVerdict = (typeof VERDICT_CLASSES)[number];

// ---- A1 World Truth (automatic, zero cost) ----

const a1WorldTruthRecordSchema = z.object({
  type: z.enum(['merge', 'revert', 'test_pass', 'test_fail', 'build_pass', 'build_fail']),
  ref: z.string().min(1),
  outcome: z.enum(['success', 'failure']),
  timestamp: z.string().min(1),
});

export type A1WorldTruthRecord = z.infer<typeof a1WorldTruthRecordSchema>;

// ---- A2 Permission Cancel (embedded interaction decision) ----

export const CANCEL_REASONS = ['should_not_do', 'wrong_direction', 'i_will_do_it', 'skip'] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

const permissionCancelRecordSchema = z.object({
  type: z.literal('permission_cancel'),
  toolName: z.string().min(1),
  paramsSummary: z.string().optional(),
  reason: z.enum(CANCEL_REASONS),
  timestamp: z.string().min(1),
  catId: z.string().min(1),
  threadId: z.string().min(1),
  sessionId: z.string().optional(),
});

export type PermissionCancelRecord = z.infer<typeof permissionCancelRecordSchema>;

// ---- A2 Magic Word (embedded interaction decision) ----

const magicWordRecordSchema = z.object({
  type: z.literal('magic_word'),
  word: z.string().min(1),
  timestamp: z.string().min(1),
  threadId: z.string().min(1),
  catId: z.string().min(1),
  precedingMessageSummary: z.string().optional(),
  followingMessageSummary: z.string().optional(),
});

export type MagicWordRecord = z.infer<typeof magicWordRecordSchema>;

// ---- A2 union (extensible — user_edit / re_route added in v1) ----

const a2InteractionDecisionSchema = z.discriminatedUnion('type', [permissionCancelRecordSchema, magicWordRecordSchema]);

export type A2InteractionDecision = z.infer<typeof a2InteractionDecisionSchema>;

// ---- Proxy signals (navigation pointers, not verdicts) ----

const proxySignalSchema = z.object({
  type: z.string().min(1),
  value: z.number(),
});

export type ProxySignal = z.infer<typeof proxySignalSchema>;

// ---- Episode ----

const taskOutcomeEpisodeSchema = z.object({
  episodeId: z.string().min(1),
  trigger: z.enum(['user_ask', 'task_created', 'cat_initiated']),
  threadId: z.string().min(1),
  participants: z.array(z.string().min(1)).default([]),
  artifacts: z.array(z.string().min(1)).default([]),
  signals: z.object({
    a1WorldTruth: z.array(a1WorldTruthRecordSchema).default([]),
    a2InteractionDecisions: z.array(a2InteractionDecisionSchema).default([]),
    proxy: z.array(proxySignalSchema).default([]),
  }),
  terminalState: z.enum(['in_progress', 'completed', 'abandoned', 'escalated_cvo', 'corrected_then_completed']),
  verdict: z.enum(VERDICT_CLASSES).nullable(),
  createdAt: z.string().min(1),
});

export type TaskOutcomeEpisode = z.infer<typeof taskOutcomeEpisodeSchema>;

// ---- Parsers ----

export function parseTaskOutcomeEpisode(input: unknown): TaskOutcomeEpisode {
  return taskOutcomeEpisodeSchema.parse(input);
}

export function parsePermissionCancelRecord(input: unknown): PermissionCancelRecord {
  return permissionCancelRecordSchema.parse(input);
}

export function parseMagicWordRecord(input: unknown): MagicWordRecord {
  return magicWordRecordSchema.parse(input);
}

export function parseA1WorldTruthRecord(input: unknown): A1WorldTruthRecord {
  return a1WorldTruthRecordSchema.parse(input);
}
