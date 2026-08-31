import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

describe('Callback Docs Routes', () => {
  async function createApp(opts = {}) {
    const { registerCallbackDocsRoutes } = await import('../dist/routes/callback-docs-routes.js');
    const app = Fastify();
    await app.register(registerCallbackDocsRoutes, opts);
    await app.ready();
    return app;
  }

  test('GET /api/callbacks/instructions returns 200 with skill content', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/callbacks/instructions',
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.ok(body.instructions, 'response should have instructions field');
      assert.ok(body.instructions.includes('# MCP Callbacks HTTP API Reference'), 'should contain refs heading');
      assert.ok(!body.instructions.startsWith('---'), 'frontmatter should be stripped');
    } finally {
      await app.close();
    }
  });

  test('GET /api/callbacks/rich-block-rules returns 200 with rules', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/callbacks/rich-block-rules',
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.ok(body.rules, 'response should have rules field');
      assert.ok(body.rules.length > 0, 'rules should be non-empty');
      assert.ok(
        body.rules.includes('cat-cafe-runtime/packages/api/uploads/'),
        'rules should warn cats that /uploads/ files must land in the runtime API upload directory',
      );
    } finally {
      await app.close();
    }
  });

  // F257 #3: objective registry discovery route — serves the shipped registry.yaml
  // so cat_cafe_list_objectives can surface valid objectiveIds (no archaeology).
  test('GET /api/callbacks/objectives returns 200 with canonized objectives', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/callbacks/objectives' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.ok(Array.isArray(body.objectives), 'response should have objectives array');
      const ids = body.objectives.map((o) => o.id);
      assert.ok(ids.includes('routing-target-delivery'), 'routing-target-delivery served');
      assert.ok(ids.includes('tool-access-correct-use'), 'tool-access-correct-use served');
      assert.equal(body.registryVersion, 2);
      assert.ok(body.evaluationModels.some((model) => model.id === 'em-tool-access-correct-use'));
      for (const o of body.objectives) {
        assert.ok(o.id && o.statement, 'each objective has id + statement');
        assert.equal('segments' in o, false, 'no segments authority in served objective');
      }
    } finally {
      await app.close();
    }
  });

  // 2a R1 P1-2: an unreadable/invalid registry must fail-closed (503), never a
  // cacheable 200 empty list that masquerades as "no objectives".
  // 2a R2 P2-1: the unauthenticated 503 must NOT leak the internal path / fs errno.
  test('GET /api/callbacks/objectives returns a path-free 503 when registry unreadable', async () => {
    const secretPath = '/private/secret-install/objectives-registry.yaml';
    const app = await createApp({ objectiveRegistryPath: secretPath });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/callbacks/objectives' });
      assert.equal(response.statusCode, 503);
      const body = response.json();
      assert.match(body.error, /unavailable/i, 'surfaces an explicit unavailability error');
      assert.doesNotMatch(body.error, /secret-install/, 'must not leak the install path');
      assert.doesNotMatch(body.error, /ENOENT|errno|no such file/i, 'must not leak fs errno');
      assert.equal(response.headers['cache-control'], undefined, 'failure is not cached');
    } finally {
      await app.close();
    }
  });
});
