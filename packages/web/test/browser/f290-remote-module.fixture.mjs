import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { expressionHostFixture } from './f290-expression-voice.fixture.mjs';

/** Production plugin activation and owner controller. Local owner authentication and the registered roster are explicit Host fixtures. */
export async function remoteModuleHost({ directory, serviceUrl, port, label }) {
  const packageRoot = resolve(process.env.F290_PLUGIN_PACKAGE_ROOT);
  const manifest = parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'));
  const { default: entrypoint } = await import(pathToFileURL(join(packageRoot, manifest.runtime.entrypoint)).href);
  const dataPath = await mkdtemp(join(directory, 'isolated-host-'));
  const pluginInstanceId = `ssh-host-${label}`;
  const entries = new Map();
  let revision = 0;
  const storage = {
    get: async (key) => structuredClone(entries.get(key)),
    list: async () => Object.fromEntries(entries),
    async set(key, value) {
      const entry = { revision: ++revision, value };
      entries.set(key, entry);
      return entry;
    },
    async compareAndSet(key, expected, value) {
      if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
      const entry = { revision: ++revision, value };
      entries.set(key, entry);
      return { applied: true, ...entry };
    },
    delete: async (key) => ({ deleted: entries.delete(key) }),
  };
  const shape = {
    pluginInstanceId,
    dataPath,
    config: { get: async (key) => ({ serviceMode: 'remote', remoteServiceUrl: serviceUrl, servicePort: '3001' })[key] },
    storage,
    secrets: { get: async () => undefined },
    tasks: { list: async () => [] },
    threads: { get: async () => null, getCats: async () => ({ participants: [] }) },
    streams: { read: async function* () {} },
    messaging: { get: async () => null, subscribe: async () => {}, unsubscribe: async () => {} },
    members: {
      get: async () => null,
      list: async () => [{ catId: 'codex-astra', displayName: 'Astra', defaultModel: 'gpt-6-astra', available: true }],
    },
    log() {},
  };
  const definition = entrypoint.create(manifest);
  let active = await definition.start(shape);
  const ownerId = `isolated-owner-${label}`;
  const invoke = (request, signal = new AbortController().signal) => {
    const webhook = manifest.contributions.find(
      (item) =>
        item.type === 'webhook' &&
        item.methods.includes(request.method) &&
        new RegExp(`^${item.path.replace(/:[^/]+/g, '[^/]+')}$`).test(request.path),
    );
    if (!webhook) throw new Error(`No declared webhook for ${request.method} ${request.path}`);
    return active.actions['collective.control.http'](
      {
        request: { ...request, principal: { kind: 'owner', id: ownerId } },
      },
      undefined,
      {
        kind: 'owner-http-request',
        userId: ownerId,
        pluginInstanceId,
        operation: request.method === 'GET' ? 'read' : 'write',
        signal,
        assertCurrent: async () => signal.throwIfAborted(),
        requestIdentity: {
          kind: 'owner_http',
          requestId: `isolated-${revision++}`,
          userId: ownerId,
          pluginId: manifest.pluginId,
          pluginInstanceId,
          contributionId: webhook.id,
          declaredPath: webhook.path,
          method: request.method,
          path: request.path,
        },
      },
    );
  };
  let host;
  try {
    host = await expressionHostFixture({ port, ownerControl: invoke });
    return {
      ...host,
      dataPath,
      async status() {
        return (await invoke({ method: 'GET', path: 'connections', headers: {}, query: {} })).body;
      },
      async restart() {
        await active.stop({ reason: 'host_shutdown' });
        active = await definition.start(shape);
      },
      async close() {
        await host.close();
        await active.stop({ reason: 'test' });
        await rm(dataPath, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await host?.close();
    await active.stop({ reason: 'test' });
    await rm(dataPath, { recursive: true, force: true });
    throw error;
  }
}
