/**
 * PR Tracking Routes
 * POST   /api/pr-tracking          — 注册 PR 追踪（猫猫提 PR 时调用）
 * GET    /api/pr-tracking          — 列出当前用户的追踪 PR
 * DELETE /api/pr-tracking/:repo/:pr — 移除追踪（限 owner）
 *
 * 安全约束（砚砚 R2）：
 * - userId 从 resolveUserId 推导，401 if missing
 * - GET 按 userId 过滤，DELETE 校验 ownership
 * - Store key 保持 repo#pr（邮件路由查找需要，不含 userId）
 *
 * BACKLOG #81
 */

import { catRegistry } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IPrTrackingStore } from '../infrastructure/email/PrTrackingStore.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface PrTrackingRoutesOptions {
  readonly prTrackingStore: IPrTrackingStore;
  /** Validates that a GitHub repo exists and is accessible. Injected for testability. */
  readonly validateRepo?: (repoFullName: string) => Promise<boolean>;
}

const RegisterBodySchema = z.object({
  repoFullName: z
    .string()
    .min(1)
    .regex(/^[^/]+\/[^/]+$/, 'Must be owner/repo format'),
  prNumber: z.number().int().positive(),
  catId: z.string().min(1),
  /** Trusted input: caller is our own code registering a PR it just created.
   *  ThreadStore existence check deferred to Phase 3 (needs DI of threadStore). */
  threadId: z.string().min(1),
});

export const prTrackingRoutes: FastifyPluginAsync<PrTrackingRoutesOptions> = async (app, opts) => {
  const { prTrackingStore, validateRepo } = opts;

  // Register a PR for tracking (auth required)
  app.post('/api/pr-tracking', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      return reply.status(401).send({ error: 'Identity required (X-Cat-Cafe-User header or userId query)' });
    }

    const parsed = RegisterBodySchema.safeParse(request.body);

    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.status(400).send({ error: 'Invalid input', detail });
    }

    const { repoFullName, prNumber, catId, threadId } = parsed.data;

    // Validate catId is a known cat
    if (!catRegistry.has(catId)) {
      return reply.status(400).send({ error: `Unknown catId: ${catId}` });
    }

    // Phase D: validate repo exists and is accessible (AC-D1)
    if (validateRepo) {
      let repoOk: boolean;
      try {
        repoOk = await validateRepo(repoFullName);
      } catch {
        return reply.status(503).send({ error: 'Repository validation unavailable — try again later' });
      }
      if (!repoOk) {
        return reply.status(422).send({ error: `Repository ${repoFullName} does not exist or is not accessible` });
      }
    }

    // P1 fix: prevent cross-user overwrite
    const existing = await prTrackingStore.get(repoFullName, prNumber);
    if (existing && existing.userId !== userId) {
      return reply.status(409).send({
        error: `PR ${repoFullName}#${prNumber} is already tracked by another user`,
      });
    }

    const entry = await prTrackingStore.register({
      repoFullName,
      prNumber,
      catId,
      threadId,
      userId,
    });

    app.log.info(
      `[pr-tracking] Registered: ${repoFullName}#${prNumber} → cat=${catId} thread=${threadId} user=${userId}`,
    );

    return reply.status(existing ? 200 : 201).send(entry);
  });

  // List tracked PRs for current user (filtered by userId)
  app.get('/api/pr-tracking', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      return reply.status(401).send({ error: 'Identity required (X-Cat-Cafe-User header or userId query)' });
    }

    const all = await prTrackingStore.listAll();
    const filtered = all.filter((e) => e.userId === userId);
    return reply.send({ entries: filtered, count: filtered.length });
  });

  // Remove tracking for a PR (owner only)
  app.delete<{ Params: { repo: string; pr: string } }>('/api/pr-tracking/:repo/:pr', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      return reply.status(401).send({ error: 'Identity required (X-Cat-Cafe-User header or userId query)' });
    }

    const repoFullName = decodeURIComponent(request.params.repo);
    const prNumber = parseInt(request.params.pr, 10);

    if (Number.isNaN(prNumber) || String(prNumber) !== request.params.pr) {
      return reply.status(400).send({ error: 'Invalid PR number' });
    }

    // Ownership check
    const entry = await prTrackingStore.get(repoFullName, prNumber);
    if (!entry) {
      return reply.status(404).send({ error: 'Tracking entry not found' });
    }
    if (entry.userId !== userId) {
      return reply.status(403).send({ error: 'Not the owner of this tracking entry' });
    }

    await prTrackingStore.remove(repoFullName, prNumber);
    app.log.info(`[pr-tracking] Removed: ${repoFullName}#${prNumber} by ${userId}`);
    return reply.status(200).send({ removed: true });
  });
};
