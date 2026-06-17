/**
 * F235: Community Issue Draft API routes.
 *
 * POST .../from-frustration-issue/:issueId — create draft from confirmed issue
 * GET  .../:draftId                        — get draft status + content
 * POST .../:draftId/publish                — user edits + publish to GitHub
 * POST .../:draftId/cancel                 — cancel draft
 *
 * All routes require user auth via X-Cat-Cafe-User.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ICommunityIssueDraftStore } from '../domains/cats/services/stores/ports/CommunityIssueDraftStore.js';
import type { IFrustrationIssueStore } from '../domains/cats/services/stores/ports/FrustrationIssueStore.js';
import { sanitize } from '../domains/community/CommunityIssueSanitizer.js';
import { createDraftFromFrustrationIssue } from '../domains/community/FrustrationIssueSourceAdapter.js';
import type { IGitHubIssuePublisher } from '../domains/community/GitHubIssuePublisher.js';
import { resolveStrictUserId, resolveUserId } from '../utils/request-identity.js';

// ── Options ───────────────────────────────────────────────────

export interface CommunityIssueDraftRoutesOptions {
  communityIssueDraftStore: ICommunityIssueDraftStore;
  frustrationIssueStore: IFrustrationIssueStore;
  publisher: IGitHubIssuePublisher;
  config: {
    defaultRepo: string;
    repoAllowlist: string[];
  };
}

// ── Schemas ───────────────────────────────────────────────────

const issueIdParamsSchema = z.object({
  issueId: z.string().min(1).max(200),
});

const draftIdParamsSchema = z.object({
  draftId: z.string().min(1).max(200),
});

const publishBodySchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    bodyMarkdown: z.string().trim().min(1).max(10000).optional(),
  })
  .strict()
  .optional();

// ── In-process publish debounce (Phase A: single-process guard against double-click /
// two-tab / retry race conditions. NOT a distributed lock — adequate for alpha single-
// process deployment. If scaled to multi-process, replace with store-level claim.) ──

const publishingDrafts = new Set<string>();

// ── Routes ────────────────────────────────────────────────────

export const communityIssueDraftRoutes: FastifyPluginAsync<CommunityIssueDraftRoutesOptions> = async (app, opts) => {
  const { communityIssueDraftStore, frustrationIssueStore, publisher, config } = opts;

  // ── POST /api/community-issue-drafts/from-frustration-issue/:issueId ──

  app.post('/api/community-issue-drafts/from-frustration-issue/:issueId', async (request, reply) => {
    // R8-P1-1 audit: strict identity for all mutations (no default-user fallback)
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }

    const paramsParse = issueIdParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid params', details: paramsParse.error.issues };
    }

    const { issueId } = paramsParse.data;

    // Look up the FrustrationIssue
    const issue = await frustrationIssueStore.getById(issueId);
    if (!issue) {
      reply.status(404);
      return { error: 'Frustration issue not found' };
    }
    if (issue.userId !== userId) {
      reply.status(403);
      return { error: 'Not your issue' };
    }
    if (issue.status !== 'confirmed') {
      reply.status(400);
      return { error: `Issue is ${issue.status}, must be confirmed` };
    }

    // Create draft via source adapter
    try {
      const draft = await createDraftFromFrustrationIssue(issue, {
        draftStore: communityIssueDraftStore,
        config,
      });
      // Link draft back to frustration issue for persistence recovery (Iron Law #5:
      // after refresh, FrustrationIssueCard reads communityIssueDraftId to restore preview)
      await frustrationIssueStore.setCommunityIssueDraftId(issueId, draft.draftId);
      return { draft };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already has')) {
        // Return existing draft so frontend can recover (409 recovery path)
        const existingDraft = await communityIssueDraftStore.getBySourceId(issueId);
        reply.status(409);
        return { error: 'Draft already exists for this issue', draft: existingDraft };
      }
      reply.status(500);
      return { error: msg };
    }
  });

  // ── GET /api/community-issue-drafts/:draftId ──

  app.get('/api/community-issue-drafts/:draftId', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }

    const paramsParse = draftIdParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid params', details: paramsParse.error.issues };
    }

    const draft = await communityIssueDraftStore.getById(paramsParse.data.draftId);
    if (!draft) {
      reply.status(404);
      return { error: 'Draft not found' };
    }
    if (draft.userId !== userId) {
      reply.status(403);
      return { error: 'Not your draft' };
    }

    return { draft };
  });

  // ── POST /api/community-issue-drafts/:draftId/publish ──

  app.post('/api/community-issue-drafts/:draftId/publish', async (request, reply) => {
    // R8-P1-1: strict identity — publish is an external side effect, no default-user
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }

    const paramsParse = draftIdParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid params', details: paramsParse.error.issues };
    }

    const bodyParse = publishBodySchema.safeParse(request.body);
    if (!bodyParse.success) {
      reply.status(400);
      return { error: 'Invalid body', details: bodyParse.error.issues };
    }

    const { draftId } = paramsParse.data;
    const edits = bodyParse.data;

    // Get current draft
    let draft = await communityIssueDraftStore.getById(draftId);
    if (!draft) {
      reply.status(404);
      return { error: 'Draft not found' };
    }
    if (draft.userId !== userId) {
      reply.status(403);
      return { error: 'Not your draft' };
    }
    if (draft.status !== 'draft') {
      reply.status(409);
      return { error: `Draft is ${draft.status}, cannot publish` };
    }

    // In-process debounce — prevent double-click/retry/two-tab duplicates.
    // Guard BEFORE the irreversible GitHub API call so only one request proceeds.
    if (publishingDrafts.has(draftId)) {
      reply.status(409);
      return { error: 'Publish already in progress for this draft' };
    }
    publishingDrafts.add(draftId);

    try {
      // Apply user edits if provided
      const finalTitle = edits?.title ?? draft.title;
      const finalBody = edits?.bodyMarkdown ?? draft.bodyMarkdown;

      // Re-sanitize (KD-4: defense in depth — user edits could re-introduce internal info)
      const sanitized = sanitize(finalTitle, finalBody);

      // Fail-closed: if sanitizer reports patterns survived redaction, reject (KD-4)
      if (!sanitized.passed) {
        reply.status(422);
        return { error: 'Content contains forbidden patterns that could not be fully redacted' };
      }

      // Update draft content if user edited
      if (edits?.title || edits?.bodyMarkdown) {
        draft = await communityIssueDraftStore.updateContent(draftId, sanitized.title, sanitized.bodyMarkdown);
      }

      // Publish to GitHub (irreversible external side effect)
      const result = await publisher.publish({
        repo: draft.targetRepo,
        title: sanitized.title,
        body: sanitized.bodyMarkdown,
        labels: draft.labels,
      });

      // R7-P1-4: Record GitHub result durably — if store.publish() fails after GitHub
      // succeeds, return partial success with the GitHub URL so the user doesn't retry
      // and create duplicates. The draft stays in 'draft' but the external issue exists.
      try {
        const published = await communityIssueDraftStore.publish({
          draftId,
          githubIssueNumber: result.issueNumber,
          githubIssueUrl: result.issueUrl,
        });
        return { draft: published, githubIssueUrl: result.issueUrl };
      } catch (storeErr: unknown) {
        // GitHub issue was created but store write failed (e.g. Redis outage/restart).
        // One-shot retry: if the failure was transient, this prevents the draft from
        // staying in 'draft' status and allowing duplicate GitHub issues on retry.
        const publishInput = {
          draftId,
          githubIssueNumber: result.issueNumber,
          githubIssueUrl: result.issueUrl,
        };
        try {
          const retried = await communityIssueDraftStore.publish(publishInput);
          app.log.warn(`F235: store.publish() succeeded on retry for draft ${draftId}`);
          return { draft: retried, githubIssueUrl: result.issueUrl };
        } catch {
          // Retry also failed — return partial success with the GitHub URL so UI
          // shows the link. Draft stays in 'draft' (known Phase A limitation for
          // persistent store outages; cross-session retry could create duplicates).
          const storeMsg = storeErr instanceof Error ? storeErr.message : String(storeErr);
          app.log.error(
            `F235: GitHub issue created (#${result.issueNumber}) but store.publish() failed after retry: ${storeMsg}`,
          );
          return {
            draft: {
              ...draft,
              status: 'published',
              githubIssueNumber: result.issueNumber,
              githubIssueUrl: result.issueUrl,
            },
            githubIssueUrl: result.issueUrl,
            warning:
              'GitHub issue created but local state update failed — issue may show as draft until next page load',
          };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!reply.sent) {
        reply.status(502);
      }
      return { error: `GitHub publish failed: ${msg}` };
    } finally {
      publishingDrafts.delete(draftId);
    }
  });

  // ── POST /api/community-issue-drafts/:draftId/cancel ──

  app.post('/api/community-issue-drafts/:draftId/cancel', async (request, reply) => {
    // R8-P1-1 audit: strict identity for all mutations
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }

    const paramsParse = draftIdParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid params', details: paramsParse.error.issues };
    }

    const { draftId } = paramsParse.data;
    const draft = await communityIssueDraftStore.getById(draftId);
    if (!draft) {
      reply.status(404);
      return { error: 'Draft not found' };
    }
    if (draft.userId !== userId) {
      reply.status(403);
      return { error: 'Not your draft' };
    }
    // R8-P1-2: Block cancel while publish is in-flight (prevents source-mapping race)
    if (publishingDrafts.has(draftId)) {
      reply.status(409);
      return { error: 'Publish in progress for this draft, cannot cancel' };
    }
    if (draft.status !== 'draft') {
      reply.status(409);
      return { error: `Draft is ${draft.status}, cannot cancel` };
    }

    const cancelled = await communityIssueDraftStore.cancel(draftId);
    return { draft: cancelled };
  });
};
