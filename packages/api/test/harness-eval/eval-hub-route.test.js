import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { evalHubRoutes } from '../../dist/routes/eval-hub.js';

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

async function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const userId = request.headers['x-test-user-id'];
    if (typeof userId === 'string') {
      request.sessionUserId = userId;
    }
  });
  await app.register(evalHubRoutes, { harnessFeedbackRoot: repoHarnessFeedbackRoot });
  return app;
}

describe('Eval Hub API route', () => {
  it('requires an authenticated session', async () => {
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/api/eval-hub/summary' });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'Session required' });
    await app.close();
  });

  it('returns the Eval Hub summary for authenticated users', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/eval-hub/summary',
      headers: { 'x-test-user-id': 'you' },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.counts.total, 1);
    assert.equal(body.items[0].id, '2026-05-23-eval-a2a-live-verdict');
    assert.equal(body.items[0].systemWorkspace.kind, 'eval_domain');
    assert.equal(body.items[0].evidence.snapshotRefs[0], 'snapshot:bundle/2026-05-23-eval-a2a-live-verdict/snapshot');
    await app.close();
  });
});
