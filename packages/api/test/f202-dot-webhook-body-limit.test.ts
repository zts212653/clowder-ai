import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { DeclaredRuntimeContributions } from '../src/domains/plugin/declared/declared-runtime-contributions.js';
import { pluginWebhookForwardingRoutes } from '../src/routes/plugin/plugin-webhook-forwarding-routes.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(requestBodyLimitBytes?: number) {
  const calls: Array<{ body: unknown; rawBody: Buffer; headers: Record<string, unknown> }> = [];
  const contributions = new DeclaredRuntimeContributions({
    packages: { resolveInstalledPackage: async () => Promise.reject(new Error('unused')) },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
  });
  await contributions.activate(
    {
      instance: { pluginInstanceId: 'pi_dot' },
      packageRecord: {
        pluginId: 'test.large-webhook',
        manifest: {
          contributions: [
            {
              type: 'webhook',
              id: 'large-inbound',
              path: 'inbound',
              methods: ['POST'],
              verificationSecretRef: 'callbackSecret',
              ...(requestBodyLimitBytes === undefined ? {} : { requestBodyLimitBytes }),
            },
          ],
        },
      },
      effectiveGrants: [],
    } as never,
    async () => {
      throw new Error('fixed webhook must not use an action method');
    },
    undefined,
    async (_instanceId, _contributionId, request) => {
      calls.push(request as (typeof calls)[number]);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } };
    },
  );
  const app = Fastify();
  apps.push(app);
  await app.register(pluginWebhookForwardingRoutes, { webhooks: contributions });
  return { app, calls };
}

test('a declared webhook admits a near-10MiB JSON envelope and strips Host credentials', async () => {
  const { app, calls } = await fixture(15 * 1024 * 1024);
  const pngBase64 = Buffer.alloc(10 * 1024 * 1024 - 4096, 7).toString('base64');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'large-image', params: { png_base64: pngBase64 } });
  assert.ok(Buffer.byteLength(body) > 13 * 1024 * 1024);
  assert.ok(Buffer.byteLength(body) < 15 * 1024 * 1024);

  const response = await app.inject({
    method: 'POST',
    url: '/api/plugins/test.large-webhook/inbound',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer must-not-cross',
      'x-agent-key-secret': 'must-not-cross',
      'x-callback-signature': 'package-private',
    },
    body,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.rawBody.byteLength, Buffer.byteLength(body));
  assert.equal(calls[0]?.headers.authorization, undefined);
  assert.equal(calls[0]?.headers['x-agent-key-secret'], undefined);
  assert.equal(calls[0]?.headers['x-callback-signature'], 'package-private');
});

test('undeclared webhook retains the 1MiB default and never enters the package action', async () => {
  const { app, calls } = await fixture();
  const response = await app.inject({
    method: 'POST',
    url: '/api/plugins/test.large-webhook/inbound',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(1024 * 1024 + 1, 1),
  });
  assert.equal(response.statusCode, 413);
  assert.equal(calls.length, 0);
});

test('payload above the contribution limit returns 413 before package invocation', async () => {
  const { app, calls } = await fixture(2 * 1024 * 1024);
  const response = await app.inject({
    method: 'POST',
    url: '/api/plugins/test.large-webhook/inbound',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(2 * 1024 * 1024 + 1, 2),
  });
  assert.equal(response.statusCode, 413);
  assert.equal(calls.length, 0);
});

test('runtime admission rejects a webhook limit above the Host hard cap', async () => {
  await assert.rejects(() => fixture(15 * 1024 * 1024 + 1), /invalid request body limit/);
});
