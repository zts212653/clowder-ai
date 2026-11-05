import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { pluginWebhookForwardingRoutes } from '../dist/routes/plugin/plugin-webhook-forwarding-routes.js';

test('owner refusal completes one response through an asynchronous onSend hook', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let sends = 0;
  let invoked = 0;
  app.addHook('onSend', async (_request, _reply, payload) => {
    sends++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return payload;
  });
  await app.register(pluginWebhookForwardingRoutes, {
    webhooks: {
      resolvePluginWebhook: () => ({ contributionId: 'owner', methods: ['GET'], anonymous: false }),
      callPluginWebhook: async () => {
        invoked++;
        throw Error('unauthorized invocation');
      },
    },
  });
  const response = await app.inject({ method: 'GET', url: '/api/plugins/test.plugin/owner' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: 'Plugin read endpoint requires an authenticated owner session' });
  assert.equal(invoked, 0);
  assert.equal(sends, 1, 'a denied request must not send twice while the first onSend is pending');
});
