import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

describe('Callback Docs Routes', () => {
  async function createApp() {
    const { registerCallbackDocsRoutes } = await import('../dist/routes/callback-docs-routes.js');
    const app = Fastify();
    await app.register(registerCallbackDocsRoutes);
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
});
