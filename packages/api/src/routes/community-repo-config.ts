/**
 * Community Repo Config Routes (F168 Phase F — F-0)
 *
 * REST API for operator to manage per-repo routing configuration.
 * Each repo can have a guard thread + guard cat assignment.
 *
 * GET    /api/community-repo-configs             → list all configs
 * POST   /api/community-repo-configs             → upsert (create or update by repo)
 * DELETE /api/community-repo-configs/:repo       → delete by repo
 */

import type { FastifyPluginAsync } from 'fastify';
import type { ICommunityRepoConfigStore } from '../domains/community/CommunityRepoConfigStore.js';
import { requirePrivilegedRouteOwner } from '../utils/privileged-route-guard.js';

export interface CommunityRepoConfigRoutesOptions {
  repoConfigStore: ICommunityRepoConfigStore;
}

const COMMUNITY_REPO_CONFIG_GATE = {
  surface: 'Community repo config routes',
  ownerErrorMessage: 'Community repo config routes can only be accessed by the configured owner',
};

export const communityRepoConfigRoutes: FastifyPluginAsync<CommunityRepoConfigRoutesOptions> = async (
  fastify,
  opts,
) => {
  const { repoConfigStore } = opts;

  // GET /api/community-repo-configs — list all
  fastify.get('/api/community-repo-configs', async (req, reply) => {
    const gate = requirePrivilegedRouteOwner(req, reply, COMMUNITY_REPO_CONFIG_GATE);
    if (!gate.ok) return gate.response;

    const configs = await repoConfigStore.listAll();
    return reply.send(configs);
  });

  // POST /api/community-repo-configs — upsert by repo
  fastify.post('/api/community-repo-configs', async (req, reply) => {
    const gate = requirePrivilegedRouteOwner(req, reply, COMMUNITY_REPO_CONFIG_GATE);
    if (!gate.ok) return gate.response;

    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Request body required' });
    }

    const { repo, guardThreadId, guardCatId } = body as {
      repo?: string;
      guardThreadId?: string;
      guardCatId?: string;
    };

    if (!repo || typeof repo !== 'string') {
      return reply.code(400).send({ error: 'repo is required (string)' });
    }
    if (!guardThreadId || typeof guardThreadId !== 'string') {
      return reply.code(400).send({ error: 'guardThreadId is required (string)' });
    }
    if (!guardCatId || typeof guardCatId !== 'string') {
      return reply.code(400).send({ error: 'guardCatId is required (string)' });
    }

    const config = await repoConfigStore.upsert({ repo, guardThreadId, guardCatId });
    return reply.send(config);
  });

  // DELETE /api/community-repo-configs/:repo — delete by repo
  fastify.delete<{ Params: { repo: string } }>('/api/community-repo-configs/:repo', async (req, reply) => {
    const gate = requirePrivilegedRouteOwner(req, reply, COMMUNITY_REPO_CONFIG_GATE);
    if (!gate.ok) return gate.response;

    const repo = decodeURIComponent(req.params.repo);
    const deleted = await repoConfigStore.deleteByRepo(repo);
    if (!deleted) {
      return reply.code(404).send({ error: 'Repo config not found' });
    }
    return reply.send({ deleted: true });
  });
};
