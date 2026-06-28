/**
 * F233 Phase C C2b — feat-trajectory query routes tests
 *
 * 覆盖 opus-48 C3 UI 联调契约：
 *   - GET /api/feat-trajectory/feats → { feats, total, lastCollectedAt }
 *   - GET /api/feat-trajectory/:featId → FeatTrajectoryProjection | 404
 *   - 鉴权 401
 *   - featId 规范化 (f188 → F188)
 *   - 排序（F188 < F233 数字序）
 *   - empty store 行为
 *
 * Fastify injection（无真实 HTTP 服务器，照 tasks-route.test.js pattern）。
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('FeatTrajectoryRoutes', () => {
  let featTrajectoryStore;

  beforeEach(async () => {
    const { InMemoryFeatTrajectoryStore } = await import('../dist/domains/feat-trajectory/FeatTrajectoryStore.js');
    featTrajectoryStore = new InMemoryFeatTrajectoryStore();
  });

  /**
   * Build app with the routes + a preHandler that fakes session auth on every
   * request unless `noAuth: true` query is set (negative case).
   */
  async function createApp({ defaultAuthed = true } = {}) {
    const { featTrajectoryRoutes } = await import('../dist/routes/feat-trajectory.js');
    const app = Fastify();
    if (defaultAuthed) {
      app.addHook('preHandler', (req, _reply, done) => {
        const r = req;
        // Fake session unless query asks to skip
        if (!req.query?.unauthed) {
          r.sessionUserId = 'test-user';
        }
        done();
      });
    }
    await app.register(featTrajectoryRoutes, { featTrajectoryStore });
    return app;
  }

  function makeProjection(featId, overrides = {}) {
    return {
      featId,
      entries: [],
      countsBySource: {
        'event-stream': 0,
        'historical-stitched': 0,
        'git-ref-snapshot': 0,
      },
      countsByKind: {},
      appliedEntryCount: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  // ── GET /api/feat-trajectory/feats ────────────────────────────────────────
  describe('GET /api/feat-trajectory/feats', () => {
    test('empty store → { feats: [], total: 0, lastCollectedAt: null }', async () => {
      const app = await createApp();
      const response = await app.inject({ method: 'GET', url: '/api/feat-trajectory/feats' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.deepStrictEqual(body.feats, []);
      assert.equal(body.total, 0);
      assert.equal(body.lastCollectedAt, null);
    });

    test('returns sorted feat list (numeric order F188 < F233 < F999)', async () => {
      await featTrajectoryStore.save(makeProjection('F999'));
      await featTrajectoryStore.save(makeProjection('F188'));
      await featTrajectoryStore.save(makeProjection('F233'));
      const app = await createApp();
      const response = await app.inject({ method: 'GET', url: '/api/feat-trajectory/feats' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.deepStrictEqual(body.feats, ['F188', 'F233', 'F999']);
      assert.equal(body.total, 3);
    });

    test('lastCollectedAt = collector tick observation time (not max event time)', async () => {
      // Cloud round 2 P2 regression: lastCollectedAt now reflects collector
      // observation time (written by scheduler.setLastCollectorTickAt), NOT
      // max(projection.updatedAt). projection.updatedAt is max **event** time
      // (headCommitAt / PR / stale threshold) — repeated cron ticks in same
      // stale bucket would leave it old even when collector ran fine. Tick
      // time is the right UI freshness metric.
      await featTrajectoryStore.save(makeProjection('F188', { updatedAt: 1_700_000_000_000 }));
      await featTrajectoryStore.save(makeProjection('F233', { updatedAt: 1_800_000_000_000 }));
      // Simulate scheduler tick at a DIFFERENT time than any updatedAt — proves
      // route reads tick time, not max(updatedAt).
      const tickTime = 1_900_000_000_000;
      await featTrajectoryStore.setLastCollectorTickAt(tickTime);
      const app = await createApp();
      const response = await app.inject({ method: 'GET', url: '/api/feat-trajectory/feats' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(
        body.lastCollectedAt,
        tickTime,
        'lastCollectedAt should be tick time (1_900_...), not max(updatedAt) 1_800_...',
      );
    });

    test('lastCollectedAt = null when collector has never ticked (no projections too)', async () => {
      // Even with projections present, if scheduler hasn't ticked yet (e.g.,
      // backfill-only scenario where backfill didn't record tick time), the
      // value is null — explicit "unknown freshness".
      await featTrajectoryStore.save(makeProjection('F188', { updatedAt: 1_700_000_000_000 }));
      const app = await createApp();
      const response = await app.inject({ method: 'GET', url: '/api/feat-trajectory/feats' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().lastCollectedAt, null);
    });

    test('unauthenticated → 401', async () => {
      await featTrajectoryStore.save(makeProjection('F188'));
      // App without session fake hook
      const { featTrajectoryRoutes } = await import('../dist/routes/feat-trajectory.js');
      const app = Fastify();
      await app.register(featTrajectoryRoutes, { featTrajectoryStore });
      const response = await app.inject({ method: 'GET', url: '/api/feat-trajectory/feats' });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, 'unauthorized');
    });

    test('cloud round 3 P2: callbackRegistry option installs auth hook in plugin scope', async () => {
      // Before fix: feat-trajectory plugin didn't install registerCallbackAuthHook
      // → MCP/callback paths (X-Invocation-Id / X-Callback-Token) couldn't
      // decorate request.callbackPrincipal → every callback path got 401.
      // After fix: plugin accepts callbackRegistry/agentKeyRegistry and
      // installs the hook in its own scope (Fastify encapsulation contract).
      //
      // Verify wiring: when callbackRegistry is passed + request carries valid
      // callback principal (simulated via stub preHandler), request reaches
      // the route handler with auth pass.
      await featTrajectoryStore.save(makeProjection('F188'));
      const { featTrajectoryRoutes } = await import('../dist/routes/feat-trajectory.js');
      const app = Fastify();
      // Stub callbackRegistry — has the right shape for type contract; the actual
      // auth happens via the simulated principal we attach below in preHandler.
      const stubCallbackRegistry = {
        verify: async () => null,
        invalidate: async () => {},
      };
      // Simulate the global callback-auth-prehandler decorating request.callbackPrincipal
      app.addHook('preHandler', (req, _reply, done) => {
        req.callbackPrincipal = { userId: 'callback-user-id' };
        done();
      });
      await app.register(featTrajectoryRoutes, {
        featTrajectoryStore,
        callbackRegistry: stubCallbackRegistry,
      });
      const response = await app.inject({ method: 'GET', url: '/api/feat-trajectory/feats' });
      // Auth-pass via callbackPrincipal (not session) — verifies isAuthenticated
      // recognizes callbackPrincipal as a valid auth source.
      assert.equal(response.statusCode, 200, 'callbackPrincipal-only auth → 200, not 401');
      assert.equal(response.json().total, 1);
    });
  });

  // ── GET /api/feat-trajectory/:featId ─────────────────────────────────────
  describe('GET /api/feat-trajectory/:featId', () => {
    test('existing feat → 200 with FeatTrajectoryProjection shape', async () => {
      const proj = makeProjection('F188', {
        entries: [
          {
            entryId: 'evt:test:1',
            subjectKey: 'feat:F188',
            featId: 'F188',
            at: 1_700_000_000_000,
            kind: 'branch_pushed',
            source: 'git-ref-snapshot',
            payload: { test: true },
          },
        ],
        countsBySource: { 'event-stream': 0, 'historical-stitched': 0, 'git-ref-snapshot': 1 },
        countsByKind: { branch_pushed: 1 },
        appliedEntryCount: 1,
      });
      await featTrajectoryStore.save(proj);
      const app = await createApp();
      const response = await app.inject({ method: 'GET', url: '/api/feat-trajectory/F188' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.featId, 'F188');
      assert.equal(body.entries.length, 1);
      assert.equal(body.entries[0].kind, 'branch_pushed');
      assert.equal(body.countsByKind.branch_pushed, 1);
    });

    test('non-existing feat → 404 { error: "not_found", featId }', async () => {
      const app = await createApp();
      const response = await app.inject({ method: 'GET', url: '/api/feat-trajectory/F999' });
      assert.equal(response.statusCode, 404);
      const body = response.json();
      assert.equal(body.error, 'not_found');
      assert.equal(body.featId, 'F999');
    });

    test('case-insensitive featId normalization (f188 → F188)', async () => {
      await featTrajectoryStore.save(makeProjection('F188'));
      const app = await createApp();
      // Lowercase URL still finds uppercase-stored projection
      const response = await app.inject({ method: 'GET', url: '/api/feat-trajectory/f188' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().featId, 'F188');
    });

    test('invalid featId format (not F####) → 400', async () => {
      const app = await createApp();
      const response = await app.inject({ method: 'GET', url: '/api/feat-trajectory/badformat' });
      // Fastify schema validation rejects → 400
      assert.equal(response.statusCode, 400);
    });

    test('unauthenticated :featId → 401', async () => {
      await featTrajectoryStore.save(makeProjection('F188'));
      const { featTrajectoryRoutes } = await import('../dist/routes/feat-trajectory.js');
      const app = Fastify();
      await app.register(featTrajectoryRoutes, { featTrajectoryStore });
      const response = await app.inject({ method: 'GET', url: '/api/feat-trajectory/F188' });
      assert.equal(response.statusCode, 401);
    });
  });
});
