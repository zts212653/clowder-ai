// @ts-check
/**
 * PR Tracking Route tests — regression tests for cloud Codex R6 findings.
 * P1: cross-user overwrite prevention
 * P2: strict numeric PR param in DELETE
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { MemoryPrTrackingStore } from '../dist/infrastructure/email/PrTrackingStore.js';
import { prTrackingRoutes } from '../dist/routes/pr-tracking.js';

const ALICE = { 'x-cat-cafe-user': 'alice' };
const BOB = { 'x-cat-cafe-user': 'bob' };

/** @returns {{ app: import('fastify').FastifyInstance, store: InstanceType<typeof MemoryPrTrackingStore> }} */
function buildApp() {
  const store = new MemoryPrTrackingStore();
  const app = Fastify();
  app.register(prTrackingRoutes, { prTrackingStore: store });
  return { app, store };
}

const validBody = {
  repoFullName: 'owner/repo',
  prNumber: 42,
  catId: 'opus',
  threadId: 'thread-1',
};

describe('PR Tracking Routes', () => {
  describe('P1: cross-user overwrite', () => {
    it('rejects registration when PR is already tracked by another user', async () => {
      const { app } = buildApp();
      await app.ready();

      // Alice registers first
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/pr-tracking',
        headers: { ...ALICE, 'content-type': 'application/json' },
        payload: validBody,
      });
      assert.equal(res1.statusCode, 201);

      // Bob tries to overwrite
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/pr-tracking',
        headers: { ...BOB, 'content-type': 'application/json' },
        payload: { ...validBody, catId: 'codex', threadId: 'thread-bob' },
      });
      assert.equal(res2.statusCode, 409);
      assert.ok(JSON.parse(res2.body).error.includes('already tracked'));

      await app.close();
    });

    it('allows same user to update their own PR registration', async () => {
      const { app } = buildApp();
      await app.ready();

      // Alice registers
      await app.inject({
        method: 'POST',
        url: '/api/pr-tracking',
        headers: { ...ALICE, 'content-type': 'application/json' },
        payload: validBody,
      });

      // Alice updates (different cat/thread)
      const res = await app.inject({
        method: 'POST',
        url: '/api/pr-tracking',
        headers: { ...ALICE, 'content-type': 'application/json' },
        payload: { ...validBody, catId: 'codex', threadId: 'thread-new' },
      });
      assert.equal(res.statusCode, 200); // 200 for update, not 201

      await app.close();
    });
  });

  describe('Phase D: repo existence validation (AC-D1/D2)', () => {
    it('rejects registration when validateRepo returns false (repo not found)', async () => {
      const store = new MemoryPrTrackingStore();
      const app = Fastify();
      app.register(prTrackingRoutes, {
        prTrackingStore: store,
        validateRepo: async () => false,
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api/pr-tracking',
        headers: { ...ALICE, 'content-type': 'application/json' },
        payload: { ...validBody, repoFullName: 'nonexistent/repo' },
      });
      assert.equal(res.statusCode, 422);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('nonexistent/repo'), 'error should mention the repo');

      // Entry should NOT have been created
      const entry = await store.get('nonexistent/repo', 42);
      assert.equal(entry, null, 'store should not contain rejected entry');

      await app.close();
    });

    it('accepts registration when validateRepo returns true', async () => {
      const store = new MemoryPrTrackingStore();
      const app = Fastify();
      app.register(prTrackingRoutes, {
        prTrackingStore: store,
        validateRepo: async () => true,
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api/pr-tracking',
        headers: { ...ALICE, 'content-type': 'application/json' },
        payload: validBody,
      });
      assert.equal(res.statusCode, 201);

      await app.close();
    });

    it('returns 503 when validateRepo throws (infrastructure failure)', async () => {
      const store = new MemoryPrTrackingStore();
      const app = Fastify();
      app.register(prTrackingRoutes, {
        prTrackingStore: store,
        validateRepo: async () => {
          throw new Error('gh: command not found');
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api/pr-tracking',
        headers: { ...ALICE, 'content-type': 'application/json' },
        payload: validBody,
      });
      assert.equal(res.statusCode, 503);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('unavailable'), 'error should indicate service unavailable');

      // Entry should NOT have been created
      const entry = await store.get('owner/repo', 42);
      assert.equal(entry, null, 'store should not contain entry after infra failure');

      await app.close();
    });

    it('passes without validateRepo (backward compat)', async () => {
      const { app } = buildApp();
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api/pr-tracking',
        headers: { ...ALICE, 'content-type': 'application/json' },
        payload: validBody,
      });
      assert.equal(res.statusCode, 201);

      await app.close();
    });
  });

  describe('P2: strict PR number validation in DELETE', () => {
    it('rejects malformed PR number like "123abc"', async () => {
      const { app, store } = buildApp();
      await app.ready();

      // Register PR 123
      store.register({ ...validBody, prNumber: 123, userId: 'alice' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/pr-tracking/owner%2Frepo/123abc',
        headers: ALICE,
      });
      assert.equal(res.statusCode, 400);
      assert.ok(JSON.parse(res.body).error.includes('Invalid PR number'));

      // Entry should still exist
      assert.ok(store.get('owner/repo', 123));

      await app.close();
    });

    it('accepts valid numeric PR number', async () => {
      const { app, store } = buildApp();
      await app.ready();

      store.register({ ...validBody, prNumber: 123, userId: 'alice' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/pr-tracking/owner%2Frepo/123',
        headers: ALICE,
      });
      assert.equal(res.statusCode, 200);
      assert.strictEqual(store.get('owner/repo', 123), null);

      await app.close();
    });
  });
});
