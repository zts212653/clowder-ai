/**
 * F222: Frustration Auto-Issue user-side routes.
 *
 * POST /api/frustration-issues/:issueId/confirm  — user confirms the auto-issue
 * POST /api/frustration-issues/:issueId/skip     — user dismisses the auto-issue
 * GET  /api/frustration-issues/pending           — list user's draft issues
 *
 * All routes require user auth via X-Cat-Cafe-User.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IFrustrationIssueStore } from '../domains/cats/services/stores/ports/FrustrationIssueStore.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface FrustrationIssueRoutesOptions {
  frustrationIssueStore: IFrustrationIssueStore;
}

const issueParamsSchema = z.object({
  issueId: z.string().min(1).max(200),
});

const confirmBodySchema = z
  .object({
    userDescription: z.string().trim().max(2000).optional(),
  })
  .strict()
  .optional();

export const frustrationIssueRoutes: FastifyPluginAsync<FrustrationIssueRoutesOptions> = async (app, opts) => {
  const { frustrationIssueStore } = opts;

  // ── GET /api/frustration-issues/:issueId/status ────────────

  app.get('/api/frustration-issues/:issueId/status', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }

    const paramsParse = issueParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid params', details: paramsParse.error.issues };
    }

    const { issueId } = paramsParse.data;
    const issue = await frustrationIssueStore.getById(issueId);
    if (!issue) {
      reply.status(404);
      return { error: 'Issue not found' };
    }
    if (issue.userId !== userId) {
      reply.status(403);
      return { error: 'Not your issue' };
    }

    return { issue };
  });

  // ── POST /api/frustration-issues/:issueId/confirm ──────────

  app.post('/api/frustration-issues/:issueId/confirm', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }

    const paramsParse = issueParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid params', details: paramsParse.error.issues };
    }

    const bodyParse = confirmBodySchema.safeParse(request.body);
    if (!bodyParse.success) {
      reply.status(400);
      return { error: 'Invalid body', details: bodyParse.error.issues };
    }

    const { issueId } = paramsParse.data;
    const userDescription = bodyParse.data?.userDescription;

    const issue = await frustrationIssueStore.getById(issueId);
    if (!issue) {
      reply.status(404);
      return { error: 'Issue not found' };
    }
    if (issue.userId !== userId) {
      reply.status(403);
      return { error: 'Not your issue' };
    }
    if (issue.status !== 'draft') {
      reply.status(409);
      return { error: `Issue already ${issue.status}` };
    }

    const confirmed = await frustrationIssueStore.confirm({ issueId, userDescription });
    return { ok: true, issue: confirmed };
  });

  // ── POST /api/frustration-issues/:issueId/skip ─────────────

  app.post('/api/frustration-issues/:issueId/skip', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }

    const paramsParse = issueParamsSchema.safeParse(request.params);
    if (!paramsParse.success) {
      reply.status(400);
      return { error: 'Invalid params', details: paramsParse.error.issues };
    }

    const { issueId } = paramsParse.data;

    const issue = await frustrationIssueStore.getById(issueId);
    if (!issue) {
      reply.status(404);
      return { error: 'Issue not found' };
    }
    if (issue.userId !== userId) {
      reply.status(403);
      return { error: 'Not your issue' };
    }
    if (issue.status !== 'draft') {
      reply.status(409);
      return { error: `Issue already ${issue.status}` };
    }

    const skipped = await frustrationIssueStore.skip(issueId);
    return { ok: true, issue: skipped };
  });

  // ── GET /api/frustration-issues/pending ─────────────────────

  app.get('/api/frustration-issues/pending', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }
    const drafts = await frustrationIssueStore.listDraft(userId);
    return { issues: drafts };
  });

  // ── GET /api/frustration-issues (AC-C3: user issue list) ───

  app.get('/api/frustration-issues', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Not authenticated' };
    }
    const query = request.query as { status?: string; threadId?: string };

    // Fetch base set: all user issues (includes draft + confirmed + skipped)
    let issues = await frustrationIssueStore.listAll(userId);

    // Apply optional filters (combinable: threadId AND/OR status)
    if (query.threadId) {
      issues = issues.filter((i) => i.threadId === query.threadId);
    }
    if (query.status) {
      issues = issues.filter((i) => i.status === query.status);
    }

    return { issues };
  });
};
