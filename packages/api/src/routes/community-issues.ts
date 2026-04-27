/**
 * Community Issue + Board Routes (F168)
 *
 * POST   /api/community-issues              → 创建 issue 台账
 * GET    /api/community-issues?repo=xxx      → 列出 repo 下 issues
 * GET    /api/community-issues/:id           → 获取单个
 * PATCH  /api/community-issues/:id           → 更新状态/字段
 * DELETE /api/community-issues/:id           → 删除
 * POST   /api/community-issues/:id/dispatch  → 手动触发 triage
 * POST   /api/community-issues/:id/triage-complete → 猫上报 triage 结果
 * POST   /api/community-issues/:id/resolve   → 铲屎官拍板 accept/decline
 * GET    /api/community-board?repo=xxx       → 聚合看板（issues + PR projection）
 */

import { createHash, randomUUID } from 'node:crypto';
import { type CatId, createCatId, DEFAULT_INTAKE_CHECKLIST, validateIntakeChecklist } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getRoster } from '../config/cat-config-loader.js';
import type { VerifyResult } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { ICommunityIssueStore } from '../domains/cats/services/stores/ports/CommunityIssueStore.js';
import type { ICommunityPrStore } from '../domains/cats/services/stores/ports/CommunityPrStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { derivePrGroup } from '../domains/community/derivePrGroup.js';
import { type GhIssueFull, mapGitHubIssue } from '../domains/community/GitHubIssueFetcher.js';
import { type GhPrFull, type GhPrReview, mapGitHubPr } from '../domains/community/GitHubPrFetcher.js';
import { resolveGuardian } from '../domains/community/GuardianMatcher.js';
import { TriageOrchestrator } from '../domains/community/TriageOrchestrator.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveUserId } from '../utils/request-identity.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';

interface CallbackAuthVerifier {
  verify(invocationId: string, callbackToken: string): Promise<VerifyResult>;
}

export interface CommunityIssuesRoutesOptions {
  communityIssueStore: ICommunityIssueStore;
  taskStore: ITaskStore;
  socketManager: SocketManager;
  threadStore?: Pick<IThreadStore, 'create'>;
  registry?: CallbackAuthVerifier;
  fetchIssues?: (repo: string) => Promise<GhIssueFull[]>;
  communityPrStore?: ICommunityPrStore;
  fetchPrs?: (repo: string) => Promise<GhPrFull[]>;
  fetchPrReviews?: (repo: string, prNumber: number) => Promise<GhPrReview[]>;
}

const VALID_ISSUE_TYPES = ['bug', 'feature', 'enhancement', 'question'] as const;
const VALID_ISSUE_STATES = ['unreplied', 'discussing', 'pending-decision', 'accepted', 'declined', 'closed'] as const;
const VALID_REPLY_STATES = ['unreplied', 'replied'] as const;
const VALID_CONSENSUS_STATES = ['discussing', 'consensus-reached', 'stalled'] as const;

const createSchema = z.object({
  repo: z.string().min(1),
  issueNumber: z.number().int().positive(),
  issueType: z.enum(VALID_ISSUE_TYPES),
  title: z.string().min(1).max(300),
});

const updateSchema = z
  .object({
    state: z.enum(VALID_ISSUE_STATES).optional(),
    replyState: z.enum(VALID_REPLY_STATES).optional(),
    consensusState: z.enum(VALID_CONSENSUS_STATES).optional(),
    issueType: z.enum(VALID_ISSUE_TYPES).optional(),
    title: z.string().min(1).max(300).optional(),
    assignedThreadId: z.string().nullable().optional(),
    assignedCatId: z.string().nullable().optional(),
    linkedPrNumbers: z.array(z.number().int().positive()).optional(),
    directionCard: z.record(z.unknown()).nullable().optional(),
    ownerDecision: z.enum(['accepted', 'declined']).nullable().optional(),
    relatedFeature: z.string().nullable().optional(),
    lastActivity: z.object({ at: z.number(), event: z.string() }).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const communityIssueRoutes: FastifyPluginAsync<CommunityIssuesRoutesOptions> = async (app, opts) => {
  const { communityIssueStore, taskStore, socketManager } = opts;

  if (opts.registry) {
    registerCallbackAuthHook(app, opts.registry);
  }

  app.post('/api/community-issues', async (request, reply) => {
    const result = createSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: result.error.issues };
    }

    const item = await communityIssueStore.create(result.data);
    if (!item) {
      const existing = await communityIssueStore.getByRepoAndNumber(result.data.repo, result.data.issueNumber);
      reply.status(409);
      return { error: 'Issue already tracked', existingId: existing?.id ?? null };
    }

    reply.status(201);
    return item;
  });

  app.get('/api/community-issues', async (request) => {
    const { repo } = request.query as { repo?: string };
    if (repo) {
      return { issues: await communityIssueStore.listByRepo(repo) };
    }
    return { issues: await communityIssueStore.listAll() };
  });

  app.get('/api/community-issues/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const item = await communityIssueStore.get(id);
    if (!item) {
      reply.status(404);
      return { error: 'Community issue not found' };
    }
    return item;
  });

  app.patch('/api/community-issues/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: result.error.issues };
    }

    const updated = await communityIssueStore.update(id, result.data);
    if (!updated) {
      reply.status(404);
      return { error: 'Community issue not found' };
    }

    return updated;
  });

  app.delete('/api/community-issues/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await communityIssueStore.delete(id);
    if (!deleted) {
      reply.status(404);
      return { error: 'Community issue not found' };
    }
    reply.status(204);
  });

  app.post('/api/community-issues/:id/dispatch', async (request, reply) => {
    const { id } = request.params as { id: string };
    const item = await communityIssueStore.get(id);
    if (!item) {
      reply.status(404);
      return { error: 'Community issue not found' };
    }
    if (item.state !== 'unreplied') {
      reply.status(409);
      return { error: 'Issue already dispatched or assigned' };
    }
    const { threadId } = (request.body ?? {}) as { threadId?: string };
    const updated = await communityIssueStore.update(id, {
      state: 'discussing',
      ...(threadId && { assignedThreadId: threadId }),
    });
    return updated;
  });

  app.post('/api/community-issues/sync', async (request, reply) => {
    const { repo } = request.query as { repo?: string };
    if (!repo) {
      reply.status(400);
      return { error: 'Missing repo query parameter' };
    }
    if (!opts.fetchIssues) {
      reply.status(501);
      return { error: 'GitHub issue fetching not configured' };
    }

    const ghIssues = await opts.fetchIssues(repo);
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    const LOCAL_LIFECYCLE_STATES = new Set(['pending-decision', 'accepted', 'declined']);

    for (const gh of ghIssues) {
      const mapped = mapGitHubIssue(gh);
      const replyState = mapped.state === 'unreplied' ? 'unreplied' : 'replied';
      const existing = await communityIssueStore.getByRepoAndNumber(repo, gh.number);
      if (!existing) {
        await communityIssueStore.create({
          repo,
          issueNumber: gh.number,
          issueType: mapped.issueType,
          title: gh.title,
        });
        if (mapped.state !== 'unreplied' || replyState !== 'unreplied') {
          const fresh = await communityIssueStore.getByRepoAndNumber(repo, gh.number);
          if (fresh) await communityIssueStore.update(fresh.id, { state: mapped.state, replyState });
        }
        created++;
      } else if (LOCAL_LIFECYCLE_STATES.has(existing.state) && mapped.state !== 'closed') {
        const titleChanged = existing.title !== gh.title;
        if (titleChanged) {
          await communityIssueStore.update(existing.id, { title: gh.title });
          updated++;
        } else {
          unchanged++;
        }
      } else if (existing.state !== mapped.state || existing.title !== gh.title || existing.replyState !== replyState) {
        await communityIssueStore.update(existing.id, { state: mapped.state, title: gh.title, replyState });
        updated++;
      } else {
        unchanged++;
      }
    }

    return { repo, created, updated, unchanged, total: ghIssues.length };
  });

  app.post('/api/community-issues/sync-prs', async (request, reply) => {
    const { repo } = request.query as { repo?: string };
    if (!repo) {
      reply.status(400);
      return { error: 'Missing repo query parameter' };
    }
    if (!opts.fetchPrs || !opts.communityPrStore) {
      reply.status(501);
      return { error: 'GitHub PR fetching not configured' };
    }

    const ghPrs = await opts.fetchPrs(repo);
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    const openPrs = ghPrs.filter((p) => p.state === 'open');
    const CONCURRENCY = 5;
    const reviewsByNumber = new Map<number, Array<{ user: string; state: string; commit_id: string }>>();
    if (opts.fetchPrReviews && openPrs.length > 0) {
      for (let i = 0; i < openPrs.length; i += CONCURRENCY) {
        const batch = openPrs.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map((p) => opts.fetchPrReviews!(repo, p.number).catch(() => [])));
        for (let j = 0; j < batch.length; j++) reviewsByNumber.set(batch[j].number, results[j]);
      }
    }

    for (const pr of ghPrs) {
      const reviews = reviewsByNumber.get(pr.number) ?? [];
      const mapped = mapGitHubPr(pr, reviews);
      const existing = await opts.communityPrStore.getByRepoAndNumber(repo, pr.number);

      if (!existing) {
        await opts.communityPrStore.create({
          repo,
          prNumber: pr.number,
          title: pr.title,
          author: pr.user,
          state: mapped.state,
          replyState: mapped.replyState,
          headSha: pr.head_sha,
          draft: pr.draft,
        });
        if (mapped.lastReviewedSha) {
          const fresh = await opts.communityPrStore.getByRepoAndNumber(repo, pr.number);
          if (fresh) await opts.communityPrStore.update(fresh.id, { lastReviewedSha: mapped.lastReviewedSha });
        }
        created++;
      } else if (
        existing.state !== mapped.state ||
        existing.replyState !== mapped.replyState ||
        existing.title !== pr.title ||
        existing.headSha !== pr.head_sha
      ) {
        await opts.communityPrStore.update(existing.id, {
          state: mapped.state,
          replyState: mapped.replyState,
          title: pr.title,
          headSha: pr.head_sha,
          ...(mapped.lastReviewedSha ? { lastReviewedSha: mapped.lastReviewedSha } : {}),
        });
        updated++;
      } else {
        unchanged++;
      }
    }

    return { repo, created, updated, unchanged, total: ghPrs.length };
  });

  const triageCompleteSchema = z.object({
    catId: z.string().min(1),
    verdict: z.enum(['WELCOME', 'NEEDS-DISCUSSION', 'POLITELY-DECLINE']),
    questions: z
      .array(
        z.object({
          id: z.enum(['Q1', 'Q2', 'Q3', 'Q4', 'Q5']),
          result: z.enum(['PASS', 'WARN', 'FAIL', 'UNKNOWN']),
        }),
      )
      .length(5),
    reasonCode: z.string().optional(),
    relatedFeature: z.string().nullable().optional(),
  });

  app.post('/api/community-issues/:id/triage-complete', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = triageCompleteSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: result.error.issues };
    }

    const issue = await communityIssueStore.get(id);
    if (!issue) {
      reply.status(404);
      return { error: 'Community issue not found' };
    }
    if (issue.state !== 'discussing' && issue.state !== 'pending-decision') {
      reply.status(409);
      return { error: 'Issue not in triageable state', currentState: issue.state };
    }

    const entry = { ...result.data, timestamp: Date.now() } as import('@cat-cafe/shared').TriageEntry;
    const orchestrator = new TriageOrchestrator({ communityIssueStore, threadStore: opts.threadStore });
    return orchestrator.recordTriageEntry(id, entry);
  });

  const resolveSchema = z.object({
    decision: z.enum(['accepted', 'declined']),
    relatedFeature: z.string().nullable().optional(),
    threadId: z.string().min(1).optional(),
    catId: z.string().min(1).optional(),
  });

  app.post('/api/community-issues/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = resolveSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid body', details: result.error.issues };
    }

    const issue = await communityIssueStore.get(id);
    if (!issue) {
      reply.status(404);
      return { error: 'Community issue not found' };
    }
    if (issue.state !== 'pending-decision') {
      reply.status(409);
      return { error: 'Issue not pending decision', currentState: issue.state };
    }

    const userId = resolveUserId(request, { defaultUserId: 'system' }) ?? 'system';
    const orchestrator = new TriageOrchestrator({ communityIssueStore, threadStore: opts.threadStore });
    if (result.data.decision === 'accepted') {
      await orchestrator.routeAccepted(
        id,
        result.data.relatedFeature ?? issue.relatedFeature,
        userId,
        result.data.threadId ?? undefined,
      );
    } else {
      await orchestrator.routeDeclined(id);
    }
    if (result.data.catId) {
      await communityIssueStore.update(id, { assignedCatId: result.data.catId });
    }

    return communityIssueStore.get(id);
  });

  // --- Phase D: Guardian endpoints ---

  const requestGuardianSchema = z.object({
    author: z.string().min(1),
    reviewer: z.string().min(1),
  });

  app.post('/api/community-issues/:id/request-guardian', async (request, reply) => {
    if (!request.callbackAuth) {
      reply.status(401);
      return { error: 'Callback authentication required' };
    }
    const { id } = request.params as { id: string };
    const result = requestGuardianSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid body', details: result.error.issues };
    }

    const roster = getRoster();
    const authorId = result.data.author;
    const reviewerId = result.data.reviewer;
    if (!roster[authorId]) {
      reply.status(400);
      return { error: `Author '${authorId}' not found in roster` };
    }
    if (!roster[reviewerId]) {
      reply.status(400);
      return { error: `Reviewer '${reviewerId}' not found in roster` };
    }

    const issue = await communityIssueStore.get(id);
    if (!issue) {
      reply.status(404);
      return { error: 'Community issue not found' };
    }
    if (issue.state !== 'accepted') {
      reply.status(409);
      return { error: 'Issue must be in accepted state', currentState: issue.state };
    }
    if (issue.guardianAssignment) {
      reply.status(409);
      return { error: 'Guardian already assigned' };
    }

    const match = await resolveGuardian({
      author: createCatId(authorId),
      reviewer: createCatId(reviewerId),
    });

    const checklist = DEFAULT_INTAKE_CHECKLIST.map((item) => ({
      ...item,
      evidence: undefined,
      verifiedAt: undefined,
      verifiedBy: undefined,
    }));

    const signoffToken = randomUUID();
    const signoffTokenHash = createHash('sha256').update(signoffToken).digest('hex');

    const guardianCatId = match.guardian as string;
    const updated = await communityIssueStore.update(id, {
      guardianAssignment: {
        guardianCatId,
        signoffTokenHash,
        requestedAt: Date.now(),
        requestedBy: result.data.author,
        signedOff: false,
        checklist,
      },
    });

    return { ...updated, signoffToken };
  });

  const guardianSignoffSchema = z.object({
    catId: z.string().min(1),
    signoffToken: z.string().min(1),
    checklist: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        required: z.boolean(),
        evidence: z.string().optional(),
        verifiedAt: z.number().optional(),
        verifiedBy: z.string().optional(),
      }),
    ),
    approved: z.boolean(),
    reason: z.string().optional(),
  });

  app.post('/api/community-issues/:id/guardian-signoff', async (request, reply) => {
    if (!request.callbackAuth) {
      reply.status(401);
      return { error: 'Callback authentication required' };
    }
    const { id } = request.params as { id: string };
    const result = guardianSignoffSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid body', details: result.error.issues };
    }

    const issue = await communityIssueStore.get(id);
    if (!issue) {
      reply.status(404);
      return { error: 'Community issue not found' };
    }
    if (!issue.guardianAssignment) {
      reply.status(409);
      return { error: 'No guardian assigned' };
    }
    const providedHash = createHash('sha256').update(result.data.signoffToken).digest('hex');
    if (providedHash !== issue.guardianAssignment.signoffTokenHash) {
      reply.status(403);
      return { error: 'Invalid signoff token' };
    }
    const callerCatId = request.callbackAuth.catId as string;
    const signoffRoster = getRoster();
    if (!signoffRoster[callerCatId]) {
      reply.status(400);
      return { error: `Cat '${callerCatId}' not found in roster` };
    }
    if (issue.guardianAssignment.guardianCatId !== callerCatId) {
      reply.status(403);
      return { error: 'Only the assigned guardian can sign off', expected: issue.guardianAssignment.guardianCatId };
    }

    if (result.data.approved) {
      const validation = validateIntakeChecklist(result.data.checklist as any);
      if (!validation.valid) {
        reply.status(400);
        return { error: 'Required checklist items missing evidence', missing: validation.missing };
      }
    }

    const updated = await communityIssueStore.update(id, {
      guardianAssignment: {
        ...issue.guardianAssignment,
        signedOff: true,
        signedOffAt: Date.now(),
        approved: result.data.approved,
        reason: result.data.reason,
        checklist: result.data.checklist,
      },
    });

    return updated;
  });

  app.get('/api/community-issues/:id/guardian-status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const issue = await communityIssueStore.get(id);
    if (!issue) {
      reply.status(404);
      return { error: 'Community issue not found' };
    }

    if (!issue.guardianAssignment) {
      return { hasGuardian: false, signedOff: false, checklistComplete: false, missingItems: [] };
    }

    const validation = validateIntakeChecklist(issue.guardianAssignment.checklist as any);
    return {
      hasGuardian: true,
      signedOff: issue.guardianAssignment.signedOff,
      checklistComplete: validation.valid,
      missingItems: validation.missing,
    };
  });

  app.get('/api/community-repos', async () => {
    const allIssues = await communityIssueStore.listAll();
    const issueRepos = allIssues.map((i) => i.repo);

    const prTasks = await taskStore.listByKind('pr_tracking');
    const prRepos = prTasks.map((t) => t.subjectKey?.match(/^pr:(.+)#\d+$/)?.[1]).filter(Boolean) as string[];

    const communityPrRepos = opts.communityPrStore
      ? [...new Set((await opts.communityPrStore.listAll()).map((p) => p.repo))]
      : [];

    const repos = [...new Set([...issueRepos, ...prRepos, ...communityPrRepos])].sort();
    return { repos };
  });

  app.get('/api/community-board', async (request, reply) => {
    const { repo } = request.query as { repo?: string };
    if (!repo) {
      reply.status(400);
      return { error: 'Missing repo query parameter' };
    }

    const issues = await communityIssueStore.listByRepo(repo);

    const subjectPrefix = `pr:${repo}#`;
    const allTasks = await taskStore.listByKind('pr_tracking');
    const repoPrTasks = allTasks.filter((t) => t.subjectKey?.startsWith(subjectPrefix));

    const communityPrs = opts.communityPrStore ? await opts.communityPrStore.listByRepo(repo) : [];
    const communityPrStateByNumber = new Map(communityPrs.map((p) => [p.prNumber, p.state]));

    const oldGroupToPhaseF: Record<string, string> = {
      'in-review': 'replied',
      're-review-needed': 'has-new-activity',
      'has-conflict': 'has-new-activity',
      completed: 'merged',
    };

    const trackedPrItems = repoPrTasks.map((t) => {
      const oldGroup = derivePrGroup(t.automationState, t.status);
      let group = oldGroupToPhaseF[oldGroup] ?? oldGroup;
      const prNumMatch = t.subjectKey?.match(/#(\d+)$/);
      const prNumber = prNumMatch ? Number(prNumMatch[1]) : null;
      if (group === 'merged') {
        const actualState = prNumber != null ? communityPrStateByNumber.get(prNumber) : undefined;
        if (actualState === 'closed') group = 'closed';
      }
      return {
        taskId: t.id,
        threadId: t.threadId,
        prNumber,
        ownerCatId: t.ownerCatId,
        title: t.title,
        status: t.status,
        group,
        automationState: t.automationState,
        updatedAt: t.updatedAt,
      };
    });
    const trackedPrNumbers = new Set(
      repoPrTasks
        .map((t) => {
          const match = t.subjectKey?.match(/#(\d+)$/);
          return match ? Number(match[1]) : null;
        })
        .filter(Boolean),
    );

    const communityPrItems = communityPrs
      .filter((p) => !trackedPrNumbers.has(p.prNumber))
      .map((p) => ({
        taskId: p.id,
        prNumber: p.prNumber,
        title: p.title,
        author: p.author,
        state: p.state,
        status: p.state,
        replyState: p.replyState,
        group: p.state !== 'open' ? p.state : p.replyState,
        headSha: p.headSha,
        draft: p.draft,
        updatedAt: p.updatedAt,
      }));

    const prItems = [...trackedPrItems, ...communityPrItems];

    return { repo, issues, prItems };
  });
};
