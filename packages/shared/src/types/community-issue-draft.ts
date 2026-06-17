/**
 * F235: Community Issue Draft — shared types.
 *
 * Generic pipeline for publishing local feedback to community GitHub issues.
 * Phase A source: FrustrationIssue (F222). Pipeline is source-agnostic (KD-6).
 */

import { generateId } from './ids.js';

// ── Draft Status ──────────────────────────────────────────────

/**
 * Status lifecycle:
 *   draft → published   (user submitted to GitHub)
 *   draft → cancelled   (user dismissed the preview)
 * Both published and cancelled are terminal.
 */
export type CommunityIssueDraftStatus = 'draft' | 'published' | 'cancelled';

// ── Source Type ────────────────────────────────────────────────

/** Extensible source discriminator. Phase A: frustration_issue only. */
export type CommunityIssueDraftSourceType = 'frustration_issue';

// ── Draft ─────────────────────────────────────────────────────

export interface CommunityIssueDraft {
  readonly draftId: string;
  readonly status: CommunityIssueDraftStatus;

  // Source tracking (generic pipeline, KD-6)
  readonly sourceType: CommunityIssueDraftSourceType;
  readonly sourceId: string;

  // Content (sanitized)
  readonly title: string;
  readonly bodyMarkdown: string;

  // Target
  readonly targetRepo: string;
  readonly labels: readonly string[];

  // Result (after publish)
  readonly githubIssueNumber?: number;
  readonly githubIssueUrl?: string;

  // Thread context (for rich block rendering)
  readonly threadId: string;
  readonly userId: string;

  // Lifecycle
  readonly createdAt: number;
  readonly publishedAt?: number;
  readonly cancelledAt?: number;
}

// ── Input Types ───────────────────────────────────────────────

export interface CreateCommunityIssueDraftInput {
  readonly sourceType: CommunityIssueDraftSourceType;
  readonly sourceId: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly targetRepo: string;
  readonly labels: readonly string[];
  readonly threadId: string;
  readonly userId: string;
}

// ── ID Generator ──────────────────────────────────────────────

export type CommunityIssueDraftId = string;

export function generateCommunityIssueDraftId(): CommunityIssueDraftId {
  return generateId('cid');
}

// ── Factory ───────────────────────────────────────────────────

export function createCommunityIssueDraft(input: CreateCommunityIssueDraftInput): CommunityIssueDraft {
  if (!input.sourceId) throw new Error('sourceId is required');
  if (!input.title) throw new Error('title is required');
  if (!input.targetRepo) throw new Error('targetRepo is required');
  if (!input.threadId) throw new Error('threadId is required');
  if (!input.userId) throw new Error('userId is required');

  return {
    draftId: generateCommunityIssueDraftId(),
    status: 'draft',
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    title: input.title,
    bodyMarkdown: input.bodyMarkdown,
    targetRepo: input.targetRepo,
    labels: [...input.labels],
    threadId: input.threadId,
    userId: input.userId,
    createdAt: Date.now(),
  };
}
