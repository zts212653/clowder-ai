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
 * POST   /api/community-issues/:id/resolve   → co-creator拍板 accept/decline
 * GET    /api/community-board?repo=xxx       → 聚合看板（issues + PR projection）
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  type CatId,
  type CommunityEvent,
  createCatId,
  DEFAULT_INTAKE_CHECKLIST,
  parseIssueSubjectKey,
  parsePrSubjectKey,
  validateIntakeChecklist,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getRoster } from '../config/cat-config-loader.js';
import type { VerifyResult } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { ICommunityIssueStore } from '../domains/cats/services/stores/ports/CommunityIssueStore.js';
import type { ICommunityPrStore } from '../domains/cats/services/stores/ports/CommunityPrStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ICommunityEventLog } from '../domains/community/CommunityEventLog.js';
import type { ICommunityObjectStore } from '../domains/community/CommunityObjectStore.js';
import { registerRoutingTracking } from '../domains/community/community-auto-tracking.js';
import { derivePrGroup } from '../domains/community/derivePrGroup.js';
import { type GhIssueFull, mapGitHubIssue } from '../domains/community/GitHubIssueFetcher.js';
import { type GhPrFull, type GhPrReview, mapGitHubPr } from '../domains/community/GitHubPrFetcher.js';
import { resolveGuardian } from '../domains/community/GuardianMatcher.js';
import type { NarratorDriver } from '../domains/community/NarratorDriver.js';
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
  threadStore?: Pick<IThreadStore, 'create' | 'get'>;
  registry?: CallbackAuthVerifier;
  fetchIssues?: (repo: string) => Promise<GhIssueFull[]>;
  communityPrStore?: ICommunityPrStore;
  fetchPrs?: (repo: string) => Promise<GhPrFull[]>;
  fetchPrReviews?: (repo: string, prNumber: number) => Promise<GhPrReview[]>;
  /** Cloud R2 P2: optional cursor seeder for auto-registered issue_tracking tasks.
   * When provided, the initial comment cursor is seeded to the current latest
   * comment ID so the first poll does not replay all historical comments. */
  fetchIssueCommentCursor?: (repoFullName: string, issueNumber: number) => Promise<number>;
  // F168 Phase A: community event log + projector (best-effort, optional)
  eventLog?: ICommunityEventLog;
  projector?: { apply(event: CommunityEvent): Promise<void> };
  // F168 Phase A Task 9: object store for board projection enrichment
  objectStore?: ICommunityObjectStore;
  // F168 Phase C C2.2: narrator spawn driver (optional; fire-and-forget after case.triaged)
  // Inject NarratorDriver constructed in index.ts with the shared wakeCat + RoleResolver.
  narratorDriver?: NarratorDriver;
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

    // F168 Phase A: emit case.triaged event (best-effort — never blocks dispatch)
    const subjectKey = `issue:${item.repo}#${item.issueNumber}`;
    const dispatchSourceEventId = `dispatch:${id}:${Date.now()}`;

    if (opts.eventLog) {
      try {
        const communityEvent: CommunityEvent = {
          sourceEventId: dispatchSourceEventId,
          subjectKey,
          kind: 'case.triaged',
          classification: 'state-changing',
          payload: { threadId: threadId ?? null, dispatchedAt: Date.now() },
          at: Date.now(),
        };
        const { appended } = await opts.eventLog.append(communityEvent);
        if (appended && opts.projector) {
          await opts.projector.apply(communityEvent);
        }
      } catch {
        // Best-effort — event log failure never blocks dispatch
      }
    }

    // F168 Phase C C2.2: fire-and-forget narrator spawn after case.triaged (SPIKE-1 candidate a)
    // NarratorDriver handles idempotency (INV-3) and error absorption internally.
    if (opts.narratorDriver) {
      void opts.narratorDriver
        .spawnNarrator({
          caseId: id,
          subjectKey,
          sourceEventId: dispatchSourceEventId,
          briefingContext: `${item.title} [${item.issueType}] (${item.repo}#${item.issueNumber})`,
        })
        .catch(() => {
          // Belt-and-suspenders: NarratorDriver.spawnNarrator already absorbs errors,
          // but catch here in case the Promise itself rejects unexpectedly.
        });
    }

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

  // F168 Phase C C2.1: narrator extension fields added (R1 fix — Zod must not strip them).
  // routeRecommendation is a discriminated union keyed on `kind`.
  const routeRecommendationSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('existing-thread'), threadId: z.string().min(1) }),
    z.object({ kind: z.literal('new-thread') }),
    z.object({ kind: z.literal('decline') }),
  ]);

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
    // C2.1 narrator extension fields — all optional for INV-12 backward compat
    authoredByRole: z.enum(['narrator', 'case-owner', 'reconciler']).optional(),
    narrative: z.string().optional(),
    evidenceRefs: z.array(z.string()).optional(),
    routeRecommendation: routeRecommendationSchema.optional(),
    recommendedOwnerRole: z.enum(['narrator', 'case-owner', 'reconciler']).optional(),
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
    routeRecommendation: routeRecommendationSchema.optional(),
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

    // C3.1: routeRecommendation → effectiveThreadId mapping
    let effectiveThreadId = result.data.threadId ?? undefined;
    const rr = result.data.routeRecommendation;
    if (rr && result.data.decision === 'accepted') {
      if (rr.kind === 'existing-thread') {
        effectiveThreadId = rr.threadId;
      } else if (rr.kind === 'new-thread') {
        // Cloud R2 P1: new-thread must create a thread even when relatedFeature exists.
        // Without explicit creation here, routeAccepted takes the relatedFeature early
        // return and skips thread creation, leaving the issue without assignedThreadId.
        if (opts.threadStore) {
          const newThread = await opts.threadStore.create(userId, `Community: ${issue.title}`);
          effectiveThreadId = newThread.id;
        }
      }
      // kind === 'decline': handled by decision='declined' path (not reachable here)
    }

    // INV-7 (consolidated Cloud R2 P2 + R3 P1 + R4 P2): validate effectiveThreadId if
    // it came from user input (legacy threadId or existing-thread recommendation). Skip
    // for new-thread — we just created it. Fail-closed when threadStore is unavailable.
    if (effectiveThreadId && result.data.decision === 'accepted' && rr?.kind !== 'new-thread') {
      if (!opts.threadStore) {
        reply.status(500);
        return { error: 'Thread validation unavailable — threadStore not wired' };
      }
      const targetThread = await opts.threadStore.get(effectiveThreadId);
      if (!targetThread || targetThread.deletedAt) {
        reply.status(404);
        return { error: `Target thread not found: ${effectiveThreadId}` };
      }
    }

    const orchestrator = new TriageOrchestrator({ communityIssueStore, threadStore: opts.threadStore });
    if (result.data.decision === 'accepted') {
      await orchestrator.routeAccepted(
        id,
        result.data.relatedFeature ?? issue.relatedFeature,
        userId,
        effectiveThreadId,
      );
    } else {
      await orchestrator.routeDeclined(id);
    }
    if (result.data.catId) {
      await communityIssueStore.update(id, { assignedCatId: result.data.catId });
    }

    // Cloud R11 P1: routeAccepted() may auto-create a thread (assignedThreadId) when
    // no threadId is supplied in the request body. Re-read the store to resolve the
    // actual thread ID so case.routed is always emitted for accepted cases.
    // C3.1 Cloud P2: use effectiveThreadId (which incorporates routeRecommendation)
    // instead of raw result.data.threadId, so case.routed/tracking align with actual routing.
    let resolvedThreadId = effectiveThreadId;
    if (result.data.decision === 'accepted' && !resolvedThreadId) {
      resolvedThreadId = (await communityIssueStore.get(id))?.assignedThreadId ?? undefined;
    }

    // F168 Phase B Task 5: emit case.routed event + auto-register tracking (best-effort)
    if (result.data.decision === 'accepted' && opts.eventLog && resolvedThreadId && result.data.catId) {
      try {
        const subjectKey = `issue:${issue.repo}#${issue.issueNumber}`;
        const routedEvent: CommunityEvent = {
          sourceEventId: `routed:${id}:${resolvedThreadId}`,
          subjectKey,
          kind: 'case.routed',
          classification: 'state-changing',
          payload: {
            ownerThreadId: resolvedThreadId,
            catId: result.data.catId,
            // Cloud R7 P2: ownerRole must be the assigned cat (catId), not the feature ID.
            // The projector maps ownerRole → assignedCatId in the board view; storing
            // relatedFeature here would display the feature ID as the owner cat.
            ownerRole: result.data.catId ?? null,
            relatedFeature: result.data.relatedFeature ?? null,
            routedAt: Date.now(),
          },
          at: Date.now(),
        };
        const { appended } = await opts.eventLog.append(routedEvent);
        if (appended) {
          // Projector is best-effort — its failure must not prevent tracking registration.
          // Cloud R21 P1: if projector.apply() throws, the outer catch would previously skip
          // registerRoutingTracking(). Since the case.routed sourceEventId is already claimed,
          // any retry sees appended:false and the tracking path is never re-entered,
          // leaving the accepted case permanently without an issue_tracking task.
          if (opts.projector) {
            try {
              await opts.projector.apply(routedEvent);
            } catch {
              // best-effort — projector failure does not block tracking registration
            }
          }
          // Auto-register tracking task — fires only on first ingest (appended:true)
          // Cloud R2 P2: pass fetchIssueCommentCursor to seed the initial cursor
          // Cloud R13 P1: pass userId so the poller can deliver notifications to the right user
          await registerRoutingTracking(routedEvent, opts.taskStore, {
            fetchCommentCursor: opts.fetchIssueCommentCursor,
            userId,
          });
        }
      } catch {
        // Best-effort — event log failure never blocks resolve
      }
    }

    // F168 C3.2 eval.1 (INV-13): record RouteDecisionEvalEvent when narrator had a recommendation.
    // `agreed` is a pure projection — computed at creation, not separately stored.
    // When no narrator recommendation exists (pure human decision), skip eval entirely.
    if (opts.eventLog) {
      try {
        const freshIssue = await communityIssueStore.get(id);
        const dc = freshIssue?.directionCard as {
          entries?: Array<{ authoredByRole?: string; routeRecommendation?: unknown }>;
        } | null;
        const narratorEntry = dc?.entries?.find(
          (e) => e.authoredByRole === 'narrator' && e.routeRecommendation != null,
        );
        if (narratorEntry) {
          const narratorRec = narratorEntry.routeRecommendation as { kind: string; threadId?: string };
          // Compute agreed: narrator recommendation matches owner decision
          let agreed: boolean;
          if (result.data.decision === 'declined') {
            agreed = narratorRec.kind === 'decline';
          } else {
            // accepted: compare route kind + threadId if applicable
            const ownerRR = result.data.routeRecommendation;
            if (!ownerRR) {
              // Owner accepted without specifying route → doesn't match narrator recommendation
              agreed = false;
            } else {
              agreed =
                ownerRR.kind === narratorRec.kind &&
                (ownerRR.kind !== 'existing-thread' ||
                  (ownerRR as { threadId: string }).threadId === narratorRec.threadId);
            }
          }
          const subjectKey = `issue:${issue.repo}#${issue.issueNumber}`;
          const evalEvent: CommunityEvent = {
            sourceEventId: `route-eval:${id}:${Date.now()}`,
            subjectKey,
            kind: 'case.route_decision_eval',
            classification: 'informational',
            payload: {
              narratorRecommendation: narratorRec,
              ownerDecision: {
                threadId: resolvedThreadId ?? null,
                verdict: result.data.decision,
              },
              agreed,
            },
            at: Date.now(),
          };
          await opts.eventLog.append(evalEvent);
        }
      } catch {
        // Best-effort — eval recording failure never blocks resolve
      }
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

  // ── F168 Phase B Task 6: awaiting_external endpoint ──────────────────────────
  // POST /api/community-issues/:subjectKey/await-external
  // Declares that the owner is waiting for an external response.
  // Appends case.awaiting_external to the community event log and applies the projector.
  // Requires callback auth. subjectKey must be URL-encoded by the caller
  // (e.g. "issue:owner/repo#42" → "issue%3Aowner%2Frepo%2342").

  app.post('/api/community-issues/:subjectKey/await-external', async (request, reply) => {
    if (!request.callbackAuth) {
      reply.status(401);
      return { error: 'Callback authentication required' };
    }

    const { subjectKey } = request.params as { subjectKey: string };

    // Cloud R10 P1: validate full format, not just prefix.
    // Prefix-only check accepts malformed keys like "issue:not-a-real-key" or
    // "issue:owner/repo#abc" which cause 500s or unprojectable events downstream.
    if (parseIssueSubjectKey(subjectKey) === null && parsePrSubjectKey(subjectKey) === null) {
      reply.status(400);
      return { error: 'Invalid subjectKey format. Expected: issue:{owner/repo}#{number} or pr:{owner/repo}#{number}' };
    }

    if (!opts.eventLog) {
      reply.status(501);
      return { error: 'Community event log not configured' };
    }

    // Pre-flight checks: validate state AND ownership before appending.
    // If objectStore is available, the case must exist before declaring awaiting_external.
    // case.awaiting_external is only valid from {in_progress, awaiting_external, routed};
    // a missing projection would always be rejected by the state machine ('new' state),
    // and returning state:'awaiting_external' in that case is misleading (Cloud R20 P2).
    if (opts.objectStore) {
      const proj = await opts.objectStore.get(subjectKey);
      if (proj === null) {
        reply.status(404);
        return { error: 'not_found', detail: 'No tracked case found for this subject key' };
      }
      // P1-B (R1): State check — case.awaiting_external is valid from:
      //   - in_progress: owner actively working on the case
      //   - awaiting_external: idempotent re-declare (owner re-confirms waiting)
      //   - routed: primary workflow entry — /resolve sets state=routed and there
      //     is no production path that automatically advances routed→in_progress,
      //     so the owner must be able to declare awaiting_external directly from routed.
      //     (Cloud R6 P1-1)
      const ACTIVATABLE_STATES = new Set<string>(['in_progress', 'awaiting_external', 'routed']);
      if (!ACTIVATABLE_STATES.has(proj.state)) {
        reply.status(409);
        return {
          error: 'invalid_transition',
          currentState: proj.state,
          detail: `case.awaiting_external requires state in {in_progress, awaiting_external, routed}, got: ${proj.state}`,
        };
      }

      // P1-B (R2): Ownership check — only the case owner can declare awaiting_external.
      // ownerThreadId is set when the case is routed (case.routed event).
      // null/undefined ownerThreadId (no owner assigned yet) → allow.
      const callerThreadId = (request.callbackAuth as { threadId?: string }).threadId;
      if (proj.ownerThreadId != null && callerThreadId !== undefined && callerThreadId !== proj.ownerThreadId) {
        reply.status(403);
        return {
          error: 'forbidden',
          detail: 'Only the case owner (ownerThreadId match) can declare awaiting_external',
        };
      }
    }

    const body = (request.body ?? {}) as { reason?: string };
    const at = Date.now();
    const callerCatId = (request.callbackAuth.catId as string | undefined) ?? 'unknown';
    const communityEvent: CommunityEvent = {
      sourceEventId: `await-external:${subjectKey}:${at}`,
      subjectKey,
      kind: 'case.awaiting_external',
      classification: 'state-changing',
      payload: {
        reason: body.reason ?? null,
        declaredBy: callerCatId,
        declaredAt: at,
      },
      at,
    };

    const { appended } = await opts.eventLog.append(communityEvent);
    if (appended && opts.projector) {
      await opts.projector.apply(communityEvent);
    }

    return {
      subjectKey,
      appended,
      state: 'awaiting_external',
      eventId: communityEvent.sourceEventId,
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

    // F168 Phase A Task 9: enrich issues + prItems with CommunityObjectStore projection fields.
    // P1-2 fix: objectStore is the authoritative source for new cases (e.g., from webhook).
    // Items that only exist in objectStore (not in legacy stores) are included via projection-only path.
    // New fields (projectionState, nextOwner, closureWaiver) are additive — zero frontend breakage.
    if (opts.objectStore) {
      const objectStore = opts.objectStore;

      // Enrich existing legacy issues with projection fields
      const enrichedIssues = await Promise.all(
        issues.map(async (issue) => {
          const subjectKey = `issue:${issue.repo}#${issue.issueNumber}`;
          try {
            const proj = await objectStore.get(subjectKey);
            if (!proj) return issue;
            return {
              ...issue,
              projectionState: proj.state,
              nextOwner: proj.nextOwner,
              closureWaiver: proj.closureWaiver,
            };
          } catch {
            return issue;
          }
        }),
      );

      // P1-2 fix: find projection-only issues (came via webhook, not in legacy communityIssueStore)
      const legacyIssueNumbers = new Set(issues.map((i) => i.issueNumber));
      try {
        const allSubjectKeys = await objectStore.listSubjectKeys();
        const issuePrefix = `issue:${repo}#`;
        const projectionOnlyKeys = allSubjectKeys.filter(
          (sk) => sk.startsWith(issuePrefix) && !legacyIssueNumbers.has(Number(sk.slice(issuePrefix.length))),
        );

        for (const sk of projectionOnlyKeys) {
          try {
            const proj = await objectStore.get(sk);
            if (!proj) continue;
            // Map terminal projection states to their legacy-compatible equivalents so the
            // board panel shows them in the correct column (closed / fixed issues must not
            // appear in the active unreplied bucket).
            const issueIsTerminal = proj.state === 'closed' || proj.state === 'fixed';
            const issueState = issueIsTerminal ? ('closed' as const) : ('unreplied' as const);
            // Synthesize a minimal issue from projection — backward-compatible shape.
            // 'state' uses a legacy-compatible fallback; 'projectionState' carries the canonical state.
            enrichedIssues.push({
              id: sk,
              repo,
              issueNumber: proj.number,
              issueType: 'question' as const,
              title: '',
              state: issueState,
              replyState: 'unreplied' as const,
              assignedThreadId: proj.ownerThreadId,
              assignedCatId: proj.ownerRole,
              linkedPrNumbers: proj.linkedPrs ?? [],
              directionCard: null,
              ownerDecision: null,
              relatedFeature: null,
              guardianAssignment: null,
              lastActivity: { at: proj.updatedAt, event: 'projection' },
              createdAt: proj.createdAt,
              updatedAt: proj.updatedAt,
              projectionState: proj.state,
              nextOwner: proj.nextOwner,
              closureWaiver: proj.closureWaiver,
            });
          } catch {
            /* best-effort */
          }
        }
      } catch {
        /* best-effort: listSubjectKeys failure should not break the board */
      }

      // Enrich prItems
      const enrichedPrItems = await Promise.all(
        prItems.map(async (item) => {
          if (item.prNumber == null) return item;
          const subjectKey = `pr:${repo}#${item.prNumber}`;
          try {
            const proj = await objectStore.get(subjectKey);
            if (!proj) return item;
            return {
              ...item,
              projectionState: proj.state,
              nextOwner: proj.nextOwner,
              closureWaiver: proj.closureWaiver,
            };
          } catch {
            return item;
          }
        }),
      );

      // P1-R2-2 fix: find projection-only PRs (webhook-only, not in legacy taskStore or communityPrStore)
      const trackedAndLegacyPrNumbers = new Set([...trackedPrNumbers, ...communityPrs.map((p) => p.prNumber)]);
      try {
        const allSubjectKeys = await objectStore.listSubjectKeys();
        const prPrefix = `pr:${repo}#`;
        const projectionOnlyPrKeys = allSubjectKeys.filter(
          (sk) => sk.startsWith(prPrefix) && !trackedAndLegacyPrNumbers.has(Number(sk.slice(prPrefix.length))),
        );
        for (const sk of projectionOnlyPrKeys) {
          try {
            const proj = await objectStore.get(sk);
            if (!proj) continue;
            // Map projection terminal states to board state/group so these PRs land in the
            // correct column (merged / closed) rather than always appearing in unreplied.
            const isFixedProj = proj.state === 'fixed';
            const isClosedProj = proj.state === 'closed';
            const projState = isFixedProj
              ? ('merged' as const)
              : isClosedProj
                ? ('closed' as const)
                : ('open' as const);
            const projGroup = isFixedProj ? 'merged' : isClosedProj ? 'closed' : 'unreplied';
            // Synthesize a communityPrItem-shaped entry (matches union member) + projection fields
            enrichedPrItems.push({
              taskId: sk,
              prNumber: proj.number,
              title: '',
              author: '',
              state: projState,
              status: projState,
              replyState: 'unreplied' as const,
              group: projGroup,
              headSha: '',
              draft: false,
              updatedAt: proj.updatedAt,
              projectionState: proj.state,
              nextOwner: proj.nextOwner,
              closureWaiver: proj.closureWaiver,
            });
          } catch {
            /* best-effort */
          }
        }
      } catch {
        /* best-effort: listSubjectKeys failure must not break the board */
      }

      return { repo, issues: enrichedIssues, prItems: enrichedPrItems };
    }

    return { repo, issues, prItems };
  });
};
