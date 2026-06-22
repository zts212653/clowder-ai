/**
 * Community Repo Config Routes tests (F168 Phase F — F-0)
 *
 * REST API for per-repo routing config CRUD.
 *
 * GET    /api/community-repo-configs          → list all
 * POST   /api/community-repo-configs          → upsert by repo
 * DELETE /api/community-repo-configs/:repo    → delete by repo
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  f163OwnerHeaders,
  installF163AdminTestSessionHook,
  restoreDefaultOwnerUserId,
  useF163TestOwner,
} from './helpers/f163-admin-auth.js';

const ORIGINAL_DEFAULT_OWNER_USER_ID = process.env.DEFAULT_OWNER_USER_ID;

describe('Community Repo Config Routes', () => {
  let store;
  let app;

  afterEach(() => {
    restoreDefaultOwnerUserId(ORIGINAL_DEFAULT_OWNER_USER_ID);
  });

  beforeEach(async () => {
    useF163TestOwner();
    const { InMemoryCommunityRepoConfigStore } = await import('../dist/domains/community/CommunityRepoConfigStore.js');
    const { communityRepoConfigRoutes } = await import('../dist/routes/community-repo-config.js');

    store = new InMemoryCommunityRepoConfigStore();
    app = Fastify();
    installF163AdminTestSessionHook(app);
    await app.register(communityRepoConfigRoutes, { repoConfigStore: store });
    await app.ready();
  });

  // -----------------------------------------------------------------------
  // POST /api/community-repo-configs (upsert)
  // -----------------------------------------------------------------------

  describe('POST /api/community-repo-configs', () => {
    it('creates a new repo config', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/community-repo-configs',
        payload: {
          repo: 'zts212653/clowder-ai',
          guardThreadId: 'thread_abc',
          guardCatId: 'codex',
        },
        headers: f163OwnerHeaders(),
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.repo, 'zts212653/clowder-ai');
      assert.equal(body.guardThreadId, 'thread_abc');
      assert.equal(body.guardCatId, 'codex');
    });

    it('rejects missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/community-repo-configs',
        payload: { repo: 'zts212653/clowder-ai' },
        headers: f163OwnerHeaders(),
      });

      assert.equal(res.statusCode, 400);
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/community-repo-configs (list all)
  // -----------------------------------------------------------------------

  describe('GET /api/community-repo-configs', () => {
    it('returns empty array when no configs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/community-repo-configs',
        headers: f163OwnerHeaders(),
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepStrictEqual(body, []);
    });

    it('returns all configs', async () => {
      await store.upsert({ repo: 'r1', guardThreadId: 't1', guardCatId: 'codex' });
      await store.upsert({ repo: 'r2', guardThreadId: 't2', guardCatId: 'opus' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/community-repo-configs',
        headers: f163OwnerHeaders(),
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.length, 2);
    });
  });

  // -----------------------------------------------------------------------
  // DELETE /api/community-repo-configs/:repo (delete)
  // -----------------------------------------------------------------------

  describe('DELETE /api/community-repo-configs/:repo', () => {
    it('deletes an existing config', async () => {
      await store.upsert({ repo: 'zts212653/clowder-ai', guardThreadId: 't1', guardCatId: 'codex' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/community-repo-configs/zts212653%2Fclowder-ai',
        headers: f163OwnerHeaders(),
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.deleted, true);
    });

    it('returns 404 for non-existent repo', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/community-repo-configs/unknown%2Frepo',
        headers: f163OwnerHeaders(),
      });

      assert.equal(res.statusCode, 404);
    });
  });

  describe('privileged route guard', () => {
    it('requires an owner session for list, upsert, and delete', async () => {
      await store.upsert({ repo: 'zts212653/clowder-ai', guardThreadId: 'thread_a', guardCatId: 'codex' });

      const list = await app.inject({
        method: 'GET',
        url: '/api/community-repo-configs',
      });
      assert.equal(list.statusCode, 401);

      const upsert = await app.inject({
        method: 'POST',
        url: '/api/community-repo-configs',
        payload: {
          repo: 'zts212653/cat-cafe',
          guardThreadId: 'thread_b',
          guardCatId: 'opus',
        },
      });
      assert.equal(upsert.statusCode, 401);

      const remove = await app.inject({
        method: 'DELETE',
        url: '/api/community-repo-configs/zts212653%2Fclowder-ai',
      });
      assert.equal(remove.statusCode, 401);
    });
  });
});
