/**
 * CommunityRepoConfigStore tests (F168 Phase F — F-0)
 *
 * Per-repo routing config: operator defines guard thread + guard cat per repo.
 * Static config (CRUD), not a state machine.
 *
 * INV-F0: No repo config = fail-closed (no backfill, no autoRoute).
 *
 * Uses InMemoryCommunityRepoConfigStore for fast TDD.
 * Redis-backed tests in community-repo-config-redis.test.js (test:redis).
 */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

describe('CommunityRepoConfigStore (in-memory)', () => {
  let InMemoryCommunityRepoConfigStore;
  let store;

  before(async () => {
    const mod = await import('../dist/domains/community/CommunityRepoConfigStore.js');
    InMemoryCommunityRepoConfigStore = mod.InMemoryCommunityRepoConfigStore;
  });

  beforeEach(() => {
    store = new InMemoryCommunityRepoConfigStore();
  });

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  describe('upsert + get', () => {
    it('creates a new config and retrieves it', async () => {
      const config = await store.upsert({
        repo: 'zts212653/clowder-ai',
        guardThreadId: 'thread_abc123',
        guardCatId: 'codex',
      });

      assert.equal(config.repo, 'zts212653/clowder-ai');
      assert.equal(config.guardThreadId, 'thread_abc123');
      assert.equal(config.guardCatId, 'codex');
      assert.equal(config.reviewMode, 'observe_only');
      assert.equal(config.cloudReviewPolicy, 'optional');
      assert.ok(config.createdAt > 0);
      assert.ok(config.updatedAt > 0);

      const retrieved = await store.getByRepo('zts212653/clowder-ai');
      assert.deepStrictEqual(retrieved, config);
    });

    it('updates existing config for same repo (upsert)', async () => {
      await store.upsert({
        repo: 'zts212653/clowder-ai',
        guardThreadId: 'thread_old',
        guardCatId: 'opus',
        reviewMode: 'maintainer_review',
        cloudReviewPolicy: 'required',
      });

      const updated = await store.upsert({
        repo: 'zts212653/clowder-ai',
        guardThreadId: 'thread_new',
        guardCatId: 'codex',
      });

      assert.equal(updated.guardThreadId, 'thread_new');
      assert.equal(updated.guardCatId, 'codex');
      assert.equal(updated.reviewMode, 'maintainer_review');
      assert.equal(updated.cloudReviewPolicy, 'required');

      // Only one config for this repo
      const all = await store.listAll();
      assert.equal(all.length, 1);
    });

    it('supports explicit maintainer-review opt-in without widening missing configs', async () => {
      const config = await store.upsert({
        repo: 'acme/widgets',
        guardThreadId: 'thread-review',
        guardCatId: 'codex-sol',
        reviewMode: 'maintainer_review',
        cloudReviewPolicy: 'required',
      });

      assert.equal(config.reviewMode, 'maintainer_review');
      assert.equal(config.cloudReviewPolicy, 'required');
      assert.equal(await store.getByRepo('missing/repo'), null);
    });

    it('uses one canonical identity for mixed-case GitHub repo names across CRUD', async () => {
      const created = await store.upsert({
        repo: 'Owner/Repo',
        guardThreadId: 'thread-old',
        guardCatId: 'opus47',
        reviewMode: 'maintainer_review',
        cloudReviewPolicy: 'required',
      });

      assert.equal(created.repo, 'owner/repo');
      assert.deepStrictEqual(await store.getByRepo('owner/repo'), created);

      const updated = await store.upsert({
        repo: 'OWNER/REPO',
        guardThreadId: 'thread-new',
        guardCatId: 'codex-sol',
      });

      assert.equal(updated.repo, 'owner/repo');
      assert.equal(updated.guardThreadId, 'thread-new');
      assert.equal(updated.reviewMode, 'maintainer_review');
      assert.equal((await store.listAll()).length, 1);
      assert.equal(await store.deleteByRepo('Owner/Repo'), true);
      assert.equal(await store.getByRepo('owner/repo'), null);
    });
  });

  describe('getByRepo', () => {
    it('returns null for unknown repo (INV-F0 fail-closed)', async () => {
      const result = await store.getByRepo('unknown/repo');
      assert.equal(result, null);
    });
  });

  describe('listAll', () => {
    it('returns empty array when no configs', async () => {
      const all = await store.listAll();
      assert.deepStrictEqual(all, []);
    });

    it('returns all configs', async () => {
      await store.upsert({
        repo: 'zts212653/clowder-ai',
        guardThreadId: 'thread_a',
        guardCatId: 'codex',
      });
      await store.upsert({
        repo: 'zts212653/cat-cafe-tutorials',
        guardThreadId: 'thread_b',
        guardCatId: 'opus',
      });

      const all = await store.listAll();
      assert.equal(all.length, 2);

      const repos = all.map((c) => c.repo).sort();
      assert.deepStrictEqual(repos, ['zts212653/cat-cafe-tutorials', 'zts212653/clowder-ai']);
    });
  });

  describe('delete', () => {
    it('removes a config by repo', async () => {
      await store.upsert({
        repo: 'zts212653/clowder-ai',
        guardThreadId: 'thread_a',
        guardCatId: 'codex',
      });

      const deleted = await store.deleteByRepo('zts212653/clowder-ai');
      assert.equal(deleted, true);

      const result = await store.getByRepo('zts212653/clowder-ai');
      assert.equal(result, null);
    });

    it('returns false when deleting non-existent repo', async () => {
      const deleted = await store.deleteByRepo('unknown/repo');
      assert.equal(deleted, false);
    });
  });
});
