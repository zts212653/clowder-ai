import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';
import { withOwnerOperationInvocation } from '../dist/domains/plugin/carrier/plugin-owner-operation-context.js';
import { registerPluginRuntimeShutdown } from '../dist/routes/plugin-runtime-shutdown.js';

const manifest = {
  pluginId: 'dev.clowder.shutdown-fixture',
  name: 'Shutdown fixture',
  version: '0.1.0',
  contractVersion: '0.1.0',
  features: [{ id: 'main', name: 'Main', resources: [], capabilities: ['plugin.state.get', 'plugin.state.set'] }],
  runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
};
const instanceId = 'shutdown-instance';
const moduleSource = `
export const events = [];
export const entered = Promise.withResolvers();
export let storage;
export default {
  create() {
    return {
      async start(host) {
        storage = host.storage;
        return {
          actions: {
            async hold(_input, _caller, owner) {
              events.push('action-entered');
              entered.resolve();
              await new Promise(resolve => {
                owner.signal.addEventListener('abort', resolve, {once: true});
                if (owner.signal.aborted) resolve();
              });
              events.push('action-aborted');
              owner.assertWriteCurrent();
              await host.storage.set('late-write', true);
            },
            async save(_input, _caller, owner) {
              await owner.assertCurrent();
              await host.storage.set('saved', 'original state');
              return {saved: true};
            }
          },
          async preStop() {
            events.push('preStop-entered');
            await host.storage.set('armed', false);
            events.push('preStop-committed');
          },
          async stop() { events.push('plugin-stopped'); }
        };
      }
    };
  }
};
`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'f330-shutdown-'));
  const entrypoint = join(root, manifest.runtime.entrypoint);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(entrypoint, moduleSource);
  const values = new Map();
  let revision = 0;
  const state = {
    get: async (pluginId, key) => values.get(`${pluginId}:${key}`),
    list: async () => {
      throw new Error('unused fixture operation');
    },
    set: async (pluginId, key, value) => {
      const entry = { revision: ++revision, value };
      values.set(`${pluginId}:${key}`, entry);
      return { revision: entry.revision };
    },
    compareAndSet: async () => {
      throw new Error('unused fixture operation');
    },
    delete: async () => {
      throw new Error('unused fixture operation');
    },
  };
  const runtime = new ModulePluginRuntime({
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir: root,
        manifest,
        verifyIntegrity: async () => {},
        release: async () => {},
      }),
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    dataDirectoryParent: join(root, 'data'),
    storage: state,
    log: () => {},
  });
  await runtime.start(instanceId, {
    pluginId: manifest.pluginId,
    version: manifest.version,
    contractVersion: manifest.contractVersion,
    packageDigest: 'fixture-digest',
    manifest,
    signalSchemas: {},
    packageState: 'installed',
    verifiedAt: 1,
    updatedAt: 1,
  });
  const loaded = await import(pathToFileURL(entrypoint).href);
  const app = Fastify({ logger: false });
  registerPluginRuntimeShutdown(app, {
    async shutdown(reason) {
      assert.equal(reason, 'api_shutdown');
      loaded.events.push('shutdown-entered');
      await runtime.stop(instanceId, reason);
      loaded.events.push('shutdown-complete');
    },
  });
  app.get('/:method', async (req, reply) => {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    reply.raw.once('close', abort);
    try {
      return await withOwnerOperationInvocation(
        {
          pluginId: manifest.pluginId,
          userId: 'fixture-owner',
          requestId: req.id,
          operationKey: 'diagnostic',
          actionId: req.params.method,
          signal: cancellation.signal,
          assertCurrent() {},
        },
        instanceId,
        req.params.method,
        async () => {},
        () => runtime.invoke(instanceId, req.params.method, {}),
      );
    } catch {
      return reply.code(409).send({ error: 'operation-ended' });
    } finally {
      reply.raw.off('close', abort);
      abort();
      loaded.events.push('http-settled');
    }
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const clients = [];
  const get = (method) =>
    new Promise((resolve, reject) => {
      const client = request({ host: '127.0.0.1', port: address.port, path: `/${method}`, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.once('end', () => resolve({ status: res.statusCode, body }));
      });
      clients.push(client);
      client.once('error', reject);
      client.end();
    });
  t.after(async () => {
    for (const client of clients) client.destroy();
    await runtime.stop(instanceId, 'test_cleanup');
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, loaded, state, get };
}
test('shutdown aborts a held real module owner action before HTTP drain', { timeout: 8_000 }, async (t) => {
  const h = await fixture(t);
  const response = h.get('hold');
  response.catch(() => {});
  await h.loaded.entered.promise;
  let timer;
  try {
    await Promise.race([
      Promise.all([h.app.close(), h.app.close()]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('plugin shutdown did not enter before HTTP drain')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal((await response).status, 409);
  assert.ok(h.loaded.events.indexOf('shutdown-entered') < h.loaded.events.indexOf('action-aborted'));
  assert.ok(h.loaded.events.includes('shutdown-complete'));
  assert.equal(h.loaded.events.filter((event) => event === 'shutdown-entered').length, 1);
  assert.equal(await h.state.get(manifest.pluginId, 'late-write'), undefined, 'aborted owner cannot commit');
  assert.equal((await h.state.get(manifest.pluginId, 'armed'))?.value, false, 'preStop storage still works');
  await assert.rejects(h.loaded.storage.set('after-stop', true), 'storage authority ends after preStop');
});
test('plugin shutdown errors reject close instead of reporting a clean exit', async () => {
  const app = Fastify({ logger: false });
  const failure = new Error('preStop storage failed');
  registerPluginRuntimeShutdown(app, {
    shutdown: async () => {
      throw failure;
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  await assert.rejects(app.close(), (error) => error === failure);
});
test('a completed HTTP save retains its receipt and state through normal close', { timeout: 8_000 }, async (t) => {
  const h = await fixture(t);
  const response = await h.get('save');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { saved: true });
  await h.app.close();
  assert.equal((await h.state.get(manifest.pluginId, 'saved'))?.value, 'original state');
  assert.deepEqual(h.loaded.events.slice(-5), [
    'shutdown-entered',
    'preStop-entered',
    'preStop-committed',
    'plugin-stopped',
    'shutdown-complete',
  ]);
});
