/**
 * F233 Phase C C2b — Feat trajectory query routes.
 *
 * 服务 Hub 时间轴 UI（opus-48 C3）+ 未来轨迹下钻面板：
 *
 * - `GET /api/feat-trajectory/feats` → `{ feats: string[], total: number, lastCollectedAt: number | null }`
 *   返回所有有 trajectory 投影的 featId 列表（sorted），supplemental metadata 给前端做 picker
 *   + cron 健康观察（lastCollectedAt 反映最近一次 collector tick 的 observation 时间）。
 *
 * - `GET /api/feat-trajectory/:featId` → `FeatTrajectoryProjection` (200) | `{ error: 'not_found' }` (404)
 *   返回完整 projection（entries + counts + meta），前端按 schema 直接渲染时间轴。
 *
 * 数据 source：`IFeatTrajectoryStore`（C2a 落地的 Redis-backed projection store）。
 * 写路径：C2b 的 `GitRefSnapshotCollector` + `FeatTrajectoryProjector` 通过 cron
 * scheduler（`FeatTrajectoryCollectorScheduler`，C2b 后续 step）持续写入；初次填充
 * 由 C2c 一次性历史回填脚本（`scripts/f233-backfill-feat-trajectory.mjs`）完成。
 *
 * 鉴权（照 events.ts 模式）：session（Hub 用户）或 callback principal（MCP 工具）二选一通过。
 * 内部观测数据，不对未鉴权暴露。
 */

import type { FeatTrajectoryProjection, FeatTrajectorySource } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { IFeatTrajectoryStore } from '../domains/feat-trajectory/FeatTrajectoryStore.js';
import type { AgentKeyAuthRegistry, CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';

export interface FeatTrajectoryRoutesOptions {
  featTrajectoryStore: IFeatTrajectoryStore;
  /**
   * Cloud round 3 P2 fix: register callback auth in THIS plugin scope so MCP
   * callbackPost (X-Invocation-Id / X-Callback-Token) headers decorate
   * `request.callbackPrincipal`. Fastify encapsulation means a sibling
   * plugin's hook does NOT reach our routes — events.ts / eval-hub / schedule
   * all follow this same pattern. Without it, every MCP / callback path
   * hitting `/api/feat-trajectory/*` would 401.
   */
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
}

const FEAT_ID_PATTERN = /^[Ff]\d{2,4}$/;

/** 鉴权检查 — session 或 callback principal 任一通过（照 events.ts pattern）。 */
function isAuthenticated(request: FastifyRequest): boolean {
  const r = request as FastifyRequest & { sessionUserId?: string; callbackPrincipal?: unknown };
  return Boolean(r.sessionUserId) || Boolean(r.callbackPrincipal);
}

export const featTrajectoryRoutes: FastifyPluginAsync<FeatTrajectoryRoutesOptions> = async (app, opts) => {
  const { featTrajectoryStore } = opts;

  // Cloud round 3 P2 fix: register callback auth in THIS plugin's scope so MCP
  // callbackPost (X-Invocation-Id/X-Callback-Token) headers actually decorate
  // request.callbackPrincipal. Fastify encapsulation means a sibling plugin's
  // hook does not reach our routes.
  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }

  app.get('/api/feat-trajectory/feats', async (req, reply) => {
    if (!isAuthenticated(req)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const feats = await featTrajectoryStore.listFeatIds();
    // 稳定排序（F### 数字序），便于前端 picker + 测试 deterministic
    feats.sort((a, b) => {
      const an = Number(a.replace(/^[Ff]/, ''));
      const bn = Number(b.replace(/^[Ff]/, ''));
      return an - bn;
    });

    // Cloud round 2 P2 fix: read collector tick observation time directly from
    // store (written by scheduler on every tick). Previously this scanned
    // `max(projection.updatedAt)` which reflected max **event** time
    // (headCommitAt / PR / stale threshold) — NOT collector observation time.
    // Repeated cron ticks in the same stale bucket bumped payload.detectedAt
    // but not projection.updatedAt → UI showed stale "last collected" even when
    // collector was running fine.
    const lastCollectedAt = await featTrajectoryStore.getLastCollectorTickAt();

    return reply.send({ feats, total: feats.length, lastCollectedAt });
  });

  app.get<{ Params: { featId: string } }>('/api/feat-trajectory/:featId', async (req, reply) => {
    if (!isAuthenticated(req)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const featIdRaw = req.params.featId;
    // Manual validation (Fastify is set up without a global zod compiler, so we
    // do the regex check inline rather than via `schema: { params: zodSchema }`).
    if (!FEAT_ID_PATTERN.test(featIdRaw)) {
      return reply.code(400).send({ error: 'invalid_format', featId: featIdRaw });
    }
    // Normalize case: URL `f188` / `F188` / `f1` / `F0001` → uppercase `F###`
    const featId = `F${featIdRaw.replace(/^[Ff]/, '')}`;

    const projection = await featTrajectoryStore.get(featId);
    if (!projection) {
      return reply.code(404).send({ error: 'not_found', featId });
    }

    const typed: FeatTrajectoryProjection = projection;
    return reply.send(typed);
  });
};

// Type re-export for shared coercion (used by other route handlers / tests).
export type { FeatTrajectorySource };
