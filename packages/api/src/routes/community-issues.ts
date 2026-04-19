/**
 * Community Issue + Board Routes (F168)
 *
 * POST   /api/community-issues          → 创建 issue 台账
 * GET    /api/community-issues?repo=xxx  → 列出 repo 下 issues
 * GET    /api/community-issues/:id       → 获取单个
 * PATCH  /api/community-issues/:id       → 更新状态/字段
 * DELETE /api/community-issues/:id       → 删除
 * GET    /api/community-board?repo=xxx   → 聚合看板（issues + PR projection）
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ICommunityIssueStore } from '../domains/cats/services/stores/ports/CommunityIssueStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import { derivePrGroup } from '../domains/community/derivePrGroup.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface CommunityIssuesRoutesOptions {
  communityIssueStore: ICommunityIssueStore;
  taskStore: ITaskStore;
  socketManager: SocketManager;
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
    const updated = await communityIssueStore.update(id, {
      state: 'discussing',
    });
    return updated;
  });

  app.get('/api/community-repos', async () => {
    const allIssues = await communityIssueStore.listAll();
    const issueRepos = allIssues.map((i) => i.repo);

    const prTasks = await taskStore.listByKind('pr_tracking');
    const prRepos = prTasks.map((t) => t.subjectKey?.match(/^pr:(.+)#\d+$/)?.[1]).filter(Boolean) as string[];

    const repos = [...new Set([...issueRepos, ...prRepos])].sort();
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

    const prItems = repoPrTasks.map((t) => ({
      taskId: t.id,
      threadId: t.threadId,
      title: t.title,
      status: t.status,
      group: derivePrGroup(t.automationState, t.status),
      automationState: t.automationState,
      updatedAt: t.updatedAt,
    }));

    return { repo, issues, prItems };
  });
};
