import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';
import { securityHeadersPlugin } from '../src/infrastructure/security-headers.js';
import { pluginWebhookForwardingRoutes } from '../src/routes/plugin/plugin-webhook-forwarding-routes.js';

test('plugin resource isolation preserves document, asset and business response bytes', async (t) => {
  const responses = [
    { mime: 'text/html; charset=utf-8', body: '<p>HTML</p>' },
    { mime: 'Application/XHTML+XML; charset=utf-8', body: '<html xmlns="http://www.w3.org/1999/xhtml" />' },
    { mime: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" />' },
    { mime: 'image/svg+xml; charset=utf-8', body: Readable.from(['<svg />']) },
    { mime: 'text/css', body: 'body { color: red; }' },
    { mime: 'application/javascript', body: 'globalThis.loaded = true;' },
    { mime: 'image/png', body: Buffer.from([137, 80, 78, 71]) },
    { mime: 'application/json; charset=utf-8', body: { ok: true } },
  ];
  const app = Fastify();
  t.after(() => app.close());
  await app.register(securityHeadersPlugin);
  await app.register(pluginWebhookForwardingRoutes, {
    webhooks: {
      resolvePluginWebhook: (_pluginId, path) => ({
        contributionId: path,
        path,
        methods: ['GET'],
        anonymous: true,
      }),
      callPluginWebhook: async (_pluginId, id) => {
        const value = responses[Number(id)];
        assert.ok(value);
        return { status: 200, headers: { 'content-type': value.mime }, body: value.body };
      },
    },
  });
  for (const [index, value] of responses.entries()) {
    const response = await app.inject(`/api/plugins/dev.fixture/${index}`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], value.mime);
    const expected =
      value.body instanceof Readable
        ? Buffer.from('<svg />')
        : Buffer.isBuffer(value.body)
          ? value.body
          : Buffer.from(typeof value.body === 'string' ? value.body : JSON.stringify(value.body));
    assert.deepEqual(response.rawPayload, expected);
    assert.equal(
      response.headers['content-security-policy'],
      "sandbox allow-scripts; frame-ancestors 'none'",
      value.mime,
    );
  }
});
