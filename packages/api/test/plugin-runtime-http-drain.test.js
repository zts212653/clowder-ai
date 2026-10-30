import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { registerPluginRuntimeShutdown } from '../dist/routes/plugin-runtime-shutdown.js';

async function fixture(t, requiredCloses = 1) {
  const root = await mkdtemp(join(tmpdir(), 'f330-http-drain-'));
  const saved = join(root, 'profile.json');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const closeEntered = Promise.withResolvers();
  const agent = new Agent({ keepAlive: true });
  const app = Fastify({ logger: false, keepAliveTimeout: 60_000 });
  let shutdowns = 0;
  registerPluginRuntimeShutdown(app, {
    async shutdown() {
      shutdowns += 1;
    },
  });
  app.post('/save', async (req) => {
    if (req.body.wait) {
      entered.resolve();
      await release.promise;
    }
    await writeFile(saved, JSON.stringify(req.body));
    return { outcome: 'applied', content: req.body.content };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  const originalClose = app.server.close;
  let closeCalls = 0;
  app.server.close = function (...args) {
    const result = Reflect.apply(originalClose, this, args);
    closeCalls += 1;
    if (closeCalls === requiredCloses) closeEntered.resolve();
    return result;
  };
  const post = (body) =>
    new Promise((resolve, reject) => {
      const client = request(
        {
          host: '127.0.0.1',
          port,
          path: '/save',
          method: 'POST',
          agent,
          headers: { 'content-type': 'application/json' },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            text += chunk;
          });
          response.once('error', reject);
          response.once('end', () =>
            resolve({ status: response.statusCode, body: JSON.parse(text), reused: client.reusedSocket }),
          );
        },
      );
      client.once('error', reject);
      client.end(JSON.stringify(body));
    });
  t.after(async () => {
    release.resolve();
    agent.destroy();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, post, entered, release, closeEntered, saved, shutdowns: () => shutdowns };
}

for (const closeHttpFirst of [false, true]) {
  test(
    `a save finishing after close keeps its receipt and releases its idle socket (prior HTTP close=${closeHttpFirst})`,
    { timeout: 5000 },
    async (t) => {
      const h = await fixture(t, closeHttpFirst ? 2 : 1);
      const response = h.post({ wait: true, content: 'durable saved value' });
      await h.entered.promise;
      const externalClose = closeHttpFirst ? new Promise((resolve) => h.app.server.close(resolve)) : undefined;
      const closed = h.app.close();
      await h.closeEntered.promise;
      h.release.resolve();
      assert.deepEqual(await response, {
        status: 200,
        body: { outcome: 'applied', content: 'durable saved value' },
        reused: false,
      });
      assert.deepEqual(JSON.parse(await readFile(h.saved, 'utf8')), { wait: true, content: 'durable saved value' });
      const promptlyClosed = await Promise.race([closed.then(() => true), delay(500).then(() => false)]);
      assert.equal(
        promptlyClosed,
        true,
        'completed keep-alive response must not leave shutdown waiting for an idle socket',
      );
      if (externalClose) await externalClose;
      assert.equal(h.shutdowns(), 1);
    },
  );
}

test('ordinary responses retain keep-alive before shutdown starts', { timeout: 5000 }, async (t) => {
  const h = await fixture(t);
  assert.equal((await h.post({ content: 'first' })).reused, false);
  assert.equal((await h.post({ content: 'second' })).reused, true);
  assert.equal(h.shutdowns(), 0);
});
