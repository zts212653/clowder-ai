import { z } from 'zod';
import type { CatId } from './ids.js';

export const THREAD_PROGRESS_KINDS = ['milestone', 'decision', 'handoff', 'blocked', 'resumed', 'completed'] as const;

export const THREAD_PROGRESS_IMPACT_AXES = [
  'goal_or_scope',
  'verified_outcome',
  'blocker',
  'next_action',
  'ownership',
] as const;

export type ThreadProgressKind = (typeof THREAD_PROGRESS_KINDS)[number];
export type ThreadProgressImpactAxis = (typeof THREAD_PROGRESS_IMPACT_AXES)[number];

export const threadProgressSourceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invocation'), invocationId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('message'), messageId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('task'), taskId: z.string().trim().min(1) }).strict(),
]);

export const recordThreadProgressInputSchema = z
  .object({
    kind: z.enum(THREAD_PROGRESS_KINDS),
    impactAxes: z.array(z.enum(THREAD_PROGRESS_IMPACT_AXES)).min(1).max(5),
    headline: z.string().trim().min(1).max(160),
    detail: z.string().trim().min(1).max(1000).optional(),
    nextStep: z.string().trim().min(1).max(500).optional(),
    provenance: z.array(threadProgressSourceRefSchema).min(1).max(8),
  })
  .strict();

export type ThreadProgressSourceRef = z.infer<typeof threadProgressSourceRefSchema>;
export type RecordThreadProgressInput = z.infer<typeof recordThreadProgressInputSchema>;

export interface ThreadProgressReceiptV1 extends RecordThreadProgressInput {
  readonly v: 1;
  readonly id: string;
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly actor:
    | { readonly kind: 'cat'; readonly catId: CatId }
    | { readonly kind: 'system'; readonly producer: string };
  readonly sourceKey: string;
  readonly occurredAt: number;
  readonly createdAt: number;
}

export type ThreadBriefAvailability = 'ok' | 'partial' | 'unavailable';
export type ThreadBriefPresentationState = 'needs_user' | 'running' | 'waiting_external' | 'idle' | 'unknown';

export interface ThreadBriefCurrentExecution {
  readonly catId: string;
  readonly startedAt: number;
  readonly confidence: 'confirmed' | 'degraded';
  readonly action?: string;
}

export interface ThreadBriefAttentionItem {
  readonly kind: 'approval';
  readonly label: string;
  readonly createdAt: number;
}

export interface ThreadBriefWaitItem {
  readonly kind: 'external';
  readonly label: string;
  readonly createdAt: number;
  readonly wakeAt?: number;
}

export type ThreadProgressReceiptSummary = Pick<
  ThreadProgressReceiptV1,
  'id' | 'kind' | 'headline' | 'detail' | 'nextStep' | 'actor' | 'occurredAt'
>;

export interface ThreadBriefV1 {
  readonly v: 1;
  readonly thread: { readonly id: string; readonly title: string };
  readonly contextHeading: { readonly label: '会话' | '目标'; readonly text: string };
  readonly availability: ThreadBriefAvailability;
  readonly presentationState: ThreadBriefPresentationState;
  readonly currentExecutions: readonly ThreadBriefCurrentExecution[];
  readonly attention: readonly ThreadBriefAttentionItem[];
  readonly waits: readonly ThreadBriefWaitItem[];
  readonly recentProgress: readonly ThreadProgressReceiptSummary[];
  readonly lastProgressAt: number | null;
  readonly nextStep: string | null;
  readonly openWorkTaskCount: number;
  readonly hasHistory: boolean;
  readonly generatedAt: number;
}

/** Phase B owner-scoped collection. `current` is complete; only `recent` is paginated. */
export interface ThreadBriefCollectionV1 {
  readonly v: 1;
  readonly current: readonly ThreadBriefV1[];
  readonly recent: readonly ThreadBriefV1[];
  readonly nextCursor: string | null;
  readonly generatedAt: number;
}

export interface ThreadRuntimePlanItem {
  readonly id: string;
  readonly subject: string;
  readonly status: string;
  readonly activeForm?: string;
}

export interface ThreadRuntimeCurrentExecution {
  readonly catId: string;
  readonly startedAt: number;
  readonly confidence: 'confirmed' | 'degraded';
  readonly plan?: {
    readonly status: 'running' | 'completed' | 'interrupted';
    readonly updatedAt: number;
    readonly tasks: readonly ThreadRuntimePlanItem[];
  };
}

export interface ThreadRuntimeSessionSummary {
  readonly sessionId: string;
  readonly cliSessionId?: string;
  readonly catId: string;
  readonly status: 'active' | 'sealing' | 'sealed';
  readonly messageCount: number;
  readonly updatedAt: number;
  readonly sealedAt?: number;
  readonly workingDirectory?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly costUsd?: number;
  };
  readonly contextHealth?: {
    readonly fillRatio: number;
    readonly source: 'exact' | 'approx';
    readonly measuredAt: number;
  };
}

/** Phase C read-only projection. It is assembled on demand and is never persisted. */
export interface ThreadRuntimeBriefV1 {
  readonly v: 1;
  readonly thread: { readonly id: string; readonly title: string };
  readonly availability: ThreadBriefAvailability;
  readonly currentExecutions: readonly ThreadRuntimeCurrentExecution[];
  readonly recentSessions: readonly ThreadRuntimeSessionSummary[];
  readonly latestProgress: ThreadProgressReceiptSummary | null;
  readonly nextStep: string | null;
  readonly openWorkTaskCount: number;
  readonly anchors: {
    readonly worktrees: readonly string[];
    readonly prs: readonly { readonly repo: string; readonly number: number }[];
    readonly issues: readonly { readonly repo: string; readonly number: number }[];
    readonly features: readonly string[];
  };
  readonly generatedAt: number;
}
