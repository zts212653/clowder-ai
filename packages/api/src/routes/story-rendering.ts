/**
 * F252 Phase C — Story rendering BFF route.
 *
 * GET /api/story/:storyId/rendering
 *
 * 消费 F233 FeatTrajectoryProjection → FeatureStoryRenderingDTO（泳道 + 因果边 + 里程碑）。
 * 前端 Birdseye 视图直接消费此 DTO。
 *
 * storyId 格式：
 * - `feat:<featId>` → Feature Story（Phase C 泳道视图）
 * - `session:<sessionId>` → Single Session（Phase A 回放，不走 rendering BFF）
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { IFeatTrajectoryStore } from '../domains/feat-trajectory/FeatTrajectoryStore.js';
import { buildFeatureStoryRendering, type ThreadMeta } from '../domains/story/buildFeatureStoryRendering.js';
import type { AgentKeyAuthRegistry, CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';

export interface StoryRenderingRoutesOptions {
  featTrajectoryStore: IFeatTrajectoryStore;
  /** Thread store for thread titles. If null, falls back to threadId as name. */
  threadStore?: { get(threadId: string): Promise<{ id: string; title?: string | null } | null> };
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
}

/** 鉴权检查 — session 或 callback principal 任一通过。 */
function isAuthenticated(request: FastifyRequest): boolean {
  const r = request as FastifyRequest & { sessionUserId?: string; callbackPrincipal?: unknown };
  return Boolean(r.sessionUserId) || Boolean(r.callbackPrincipal);
}

const FEAT_ID_PATTERN = /^[Ff]\d{2,4}$/;

export const storyRenderingRoutes: FastifyPluginAsync<StoryRenderingRoutesOptions> = async (app, opts) => {
  // Register callback auth so MCP tools + agent-key callers can reach this route.
  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }

  app.get<{ Params: { storyId: string } }>('/api/story/:storyId/rendering', async (request, reply) => {
    if (!isAuthenticated(request)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const { storyId } = request.params;

    // Parse storyId — only `feat:<featId>` supported for rendering
    if (!storyId.startsWith('feat:')) {
      return reply.status(400).send({
        error: 'invalid_story_id',
        message: 'Rendering endpoint only supports feat:<featId> story IDs',
      });
    }

    const featId = storyId.slice(5).toUpperCase(); // 'feat:f252' → 'F252'
    if (!FEAT_ID_PATTERN.test(featId)) {
      return reply.status(400).send({
        error: 'invalid_feat_id',
        message: `Invalid feature ID format: ${featId}`,
      });
    }

    // Fetch projection from F233 store
    const projection = await opts.featTrajectoryStore.get(featId);
    if (!projection) {
      return reply.status(404).send({ error: 'not_found', message: `No trajectory for ${featId}` });
    }

    // Extract unique thread IDs from projection entries and fetch metadata
    const threadIds = new Set<string>();
    for (const entry of projection.entries) {
      const payload = entry.payload;
      if (entry.kind === 'thread_split') {
        if (payload.parentThreadId) threadIds.add(payload.parentThreadId as string);
        if (payload.childThreadId) threadIds.add(payload.childThreadId as string);
      } else if (entry.kind === 'thread_merge') {
        if (payload.sourceThreadId) threadIds.add(payload.sourceThreadId as string);
        if (payload.targetThreadId) threadIds.add(payload.targetThreadId as string);
      } else if (entry.source === 'git-ref-snapshot' && payload.snapshot) {
        const snap = payload.snapshot as Record<string, unknown>;
        if (Array.isArray(snap.associatedThreadIds)) {
          for (const tid of snap.associatedThreadIds) threadIds.add(tid as string);
        }
      }
    }

    // Fetch thread names
    const threadMeta = new Map<string, ThreadMeta>();
    if (opts.threadStore) {
      await Promise.all(
        [...threadIds].map(async (tid) => {
          try {
            const thread = await opts.threadStore!.get(tid);
            if (thread) {
              threadMeta.set(tid, {
                threadId: tid,
                name: thread.title ?? tid,
                participants: [],
              });
            }
          } catch {
            // Thread lookup failure is non-fatal
          }
        }),
      );
    }

    // Build rendering DTO
    const title = `${featId}: Feature Story`; // TODO: get from feat doc
    const rendering = buildFeatureStoryRendering(projection, threadMeta, title);

    return reply.send(rendering);
  });
};
