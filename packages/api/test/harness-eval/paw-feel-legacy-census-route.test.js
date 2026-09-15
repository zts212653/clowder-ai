import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { LegacyPawFeelBlockerCensusCursorError } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/legacy-blocker-census.js';
import { pawFeelLegacyCensusRoutes } from '../../dist/routes/paw-feel-legacy-census.js';

function callbackRegistry() {
  return {
    async verify(invocationId, callbackToken) {
      if (invocationId !== 'inv-1' || callbackToken !== 'token-1') {
        return { ok: false, reason: 'unknown_invocation' };
      }
      return {
        ok: true,
        record: {
          invocationId,
          callbackToken,
          threadId: 'thread_eval_friction',
          userId: 'user-1',
          catId: 'codex-sol',
        },
      };
    },
  };
}

describe('F313 cat-authenticated legacy blocker census route', () => {
  const apps = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('requires callback auth and returns a refs-only partial page', async () => {
    const calls = [];
    const app = Fastify();
    await app.register(pawFeelLegacyCensusRoutes, {
      callbackRegistry: callbackRegistry(),
      censusService: {
        async read(input) {
          calls.push(input);
          return {
            status: 'partial',
            pageScannedSignals: 50,
            totalScannedSignals: 50,
            nextCursor: 'signed-cursor',
          };
        },
      },
    });
    await app.ready();
    apps.push(app);

    const denied = await app.inject({ method: 'GET', url: '/api/callbacks/paw-feel-legacy-blocker-census' });
    assert.equal(denied.statusCode, 401);
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/callbacks/paw-feel-legacy-blocker-census?limit=25&cursor=opaque',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
    });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json(), {
      status: 'partial',
      pageScannedSignals: 50,
      totalScannedSignals: 50,
      nextCursor: 'signed-cursor',
    });
    assert.deepEqual(calls, [{ cursor: 'opaque', limit: 25 }]);
    assert.equal(JSON.stringify(allowed.json()).includes('blockerRef'), false);
  });

  it('maps a forged cursor to 400 and an unavailable service to 503', async () => {
    const app = Fastify();
    await app.register(pawFeelLegacyCensusRoutes, {
      callbackRegistry: callbackRegistry(),
      censusService: {
        async read() {
          throw new LegacyPawFeelBlockerCensusCursorError('invalid legacy census cursor signature');
        },
      },
    });
    await app.ready();
    apps.push(app);
    const forged = await app.inject({
      method: 'GET',
      url: '/api/callbacks/paw-feel-legacy-blocker-census?cursor=forged',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
    });
    assert.equal(forged.statusCode, 400);

    const unavailable = Fastify();
    await unavailable.register(pawFeelLegacyCensusRoutes, { callbackRegistry: callbackRegistry() });
    await unavailable.ready();
    apps.push(unavailable);
    const response = await unavailable.inject({
      method: 'GET',
      url: '/api/callbacks/paw-feel-legacy-blocker-census',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
    });
    assert.equal(response.statusCode, 503);
  });
});
