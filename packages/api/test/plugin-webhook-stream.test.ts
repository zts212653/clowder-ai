import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import {
  currentPluginOwnerRequestContext,
  type PluginOwnerRequestContext,
} from '../src/domains/plugin/carrier/plugin-owner-request-context.js';
import { DeclaredRuntimeContributions } from '../src/domains/plugin/declared/declared-runtime-contributions.js';
import { pluginWebhookForwardingRoutes } from '../src/routes/plugin/plugin-webhook-forwarding-routes.js';

async function fixture(t: TestContext, run: (context: PluginOwnerRequestContext) => unknown) {
  const contributions = new DeclaredRuntimeContributions({
    packages: {
      resolveInstalledPackage: async () => {
        throw new Error('unused');
      },
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
  });
  await contributions.activate(
    {
      instance: { pluginInstanceId: 'pi_stream' },
      packageRecord: {
        pluginId: 'test.stream',
        manifest: {
          contributions: [
            {
              type: 'webhook',
              id: 'media',
              path: 'media',
              methods: ['GET'],
              action: { method: 'media.read' },
            },
          ],
        },
      },
    } as never,
    async () => {
      const context = currentPluginOwnerRequestContext('pi_stream');
      assert.ok(context);
      return run(context);
    },
  );
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-1';
  });
  await app.register(pluginWebhookForwardingRoutes, { webhooks: contributions });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  return { app, contributions, url: `http://127.0.0.1:${address.port}/api/plugins/test.stream/media` };
}

test('declared owner HTTP streams more than the JSON limit with live authority until completion', async (t) => {
  let captured: PluginOwnerRequestContext | undefined;
  const chunk = Buffer.alloc(256 * 1024, 42);
  const f = await fixture(t, (context) => {
    captured = context;
    return {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(chunk.length * 5),
        'content-range': `bytes 0-${chunk.length * 5 - 1}/${chunk.length * 6}`,
        'accept-ranges': 'bytes',
      },
      body: Readable.from(
        (async function* () {
          for (let i = 0; i < 5; i++) {
            await delay(5);
            await context.assertCurrent();
            yield chunk;
          }
        })(),
      ),
    };
  });
  const response = await fetch(f.url);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal((await response.arrayBuffer()).byteLength, chunk.length * 5);
  await delay(0);
  assert.ok(captured);
  await assert.rejects(captured.assertCurrent(), /no longer current/);
  assert.ok(captured);
  assert.equal(captured.signal.aborted, true);
});

test('client disconnect destroys an idle package stream and closes owner authority', async (t) => {
  const source = new PassThrough();
  let captured: PluginOwnerRequestContext | undefined;
  const f = await fixture(t, (context) => {
    captured = context;
    source.write(Buffer.from('first'));
    return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: source };
  });
  const abort = new AbortController();
  const response = await fetch(f.url, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(first.value);
  assert.equal(Buffer.from(first.value).toString(), 'first');
  abort.abort();
  for (let i = 0; i < 100 && !source.destroyed; i++) await delay(5);
  assert.equal(source.destroyed, true);
  assert.ok(captured);
  assert.equal(captured.signal.aborted, true);
  assert.ok(captured);
  await assert.rejects(captured.assertCurrent(), /no longer current/);
});

test('activation removal rejects later chunks and invalid response headers dispose package streams', async (t) => {
  const source = new PassThrough();
  const f = await fixture(t, () => {
    source.write(Buffer.from('first'));
    return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: source };
  });
  const response = await fetch(f.url);
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  await reader.read();
  f.contributions.deactivate('pi_stream');
  for (let i = 0; i < 50 && !source.destroyed; i++) await delay(5);
  assert.equal(source.destroyed, true, 'disable must cancel an idle stream without waiting for the next chunk');
  await assert.rejects(reader.read());
  assert.equal(source.destroyed, true);
  const invalid = new PassThrough();
  const other = await fixture(t, () => ({
    status: 200,
    headers: { 'content-length': '-1' },
    body: invalid,
  }));
  assert.equal((await fetch(other.url)).status, 502);
  assert.equal(invalid.destroyed, true);
});
