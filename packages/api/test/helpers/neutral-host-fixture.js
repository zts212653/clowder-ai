import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateManifest } from '@clowder-ai/plugin-contract';
import Fastify from 'fastify';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createDormantPluginRuntimeComposition } from '../../dist/domains/plugin/runtime-composition.js';
import { pluginWebhookForwardingRoutes } from '../../dist/routes/plugin/plugin-webhook-forwarding-routes.js';
import { readPluginNativeToken } from './plugin-native-credential.js';

export async function neutralFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'f202-neutral-host-'));
  const packageRoot = join(root, 'package');
  await mkdir(packageRoot);
  const owner = process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner';
  const messages = options.messageStore ?? new MessageStore();
  const threads = new ThreadStore();
  const thread = await threads.create(owner, 'source');
  let config = null,
    host;
  const eventsFile = join(root, 'module-events.jsonl');
  await writeFile(eventsFile, '');
  const manifest = {
    pluginId: 'dev.clowder.neutral-host',
    name: 'Neutral Host fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    runtime: { transport: 'builtin', entrypoint: 'plugin.mjs' },
    ...(options.configuration
      ? { configuration: [{ key: 'label', label: 'Label', kind: 'string', required: false }] }
      : {}),
    features: [
      {
        id: 'neutral',
        name: 'Neutral',
        resources: [],
        contributions: [
          { type: 'webhook', id: 'owner' },
          ...(options.independentNative ? [] : [{ type: 'mcp', id: 'native' }]),
        ],
      },
      ...(options.independentNative
        ? [
            {
              id: 'probe',
              name: 'Probe',
              resources: [],
              contributions: [{ type: 'mcp', id: 'native' }],
            },
          ]
        : []),
    ],
    contributions: [
      { type: 'webhook', id: 'owner', path: 'owner', methods: ['GET', 'POST'], action: { method: 'neutral.http' } },
      {
        type: 'mcp',
        id: 'native',
        runtime: { transport: 'stdio', entrypoint: 'mcp.js' },
      },
    ],
  };
  const validation = validateManifest(manifest);
  assert.equal(validation.valid, true, JSON.stringify(validation));
  const source = `import {appendFileSync} from 'node:fs';
    const record = event => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event)+'\\n');
    export default { create() { let refreshMembers; return { start(host) { record('start');
    const call = async input => { const method = host[input.service]?.[input.method];
      const result = method ? await method(input.value) : null;
      if(input.service === 'ownerChat' && input.method === 'capture' && result.assertWriteCurrent() !== undefined)
        throw Error('Owner Chat write fence must remain synchronous inside the module');
      return { available: typeof method === 'function', result }; };
    return { actions: { 'neutral.http': async ({request}) => ({status:200, body:await call(request.method === 'GET' ? JSON.parse(request.query.input) : request.body)}),
      'neutral.call': call, 'fixture.host': () => host, 'fixture.refreshMembers': () => refreshMembers },
      async configRefresh() { record('refresh'); ${options.observeRefreshMembers ? 'refreshMembers = await host.members.list();' : ''} },
      stop() { record('stop'); } }; } }; } };`;
  await writeFile(join(packageRoot, 'plugin.mjs'), source);
  await writeFile(join(packageRoot, 'mcp.js'), '// Never spawned by this fixture.\n');
  const packageDigest = `sha512-${createHash('sha512').update(source).digest('base64')}`;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: root,
    threadOwnerUserId: owner,
    messageStore: messages,
    ...(options.taskStore ? { taskStore: options.taskStore } : {}),
    threadStore: threads,
    ...(options.threadProjections ? { threadProjections: options.threadProjections } : {}),
    ...(options.members ? { members: options.members } : {}),
    ...(options.memberSessions ? { memberSessions: options.memberSessions } : {}),
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir: packageRoot,
        manifest,
        verifyIntegrity: async () => {},
        release: async () => {},
      }),
    },
    mcpConfigIO: {
      readConfig: async () => structuredClone(config),
      withLock: async (operation) => operation(),
      writeAndRegenCli: async (value) => {
        config = structuredClone(value);
      },
    },
  });
  // Observe each real activation through its explicit action, including a restart.
  const start = runtime.supervisor.start.bind(runtime.supervisor);
  runtime.supervisor.start = async (id, ...args) => {
    const result = await start(id, ...args);
    host = await runtime.supervisor.invoke(id, 'fixture.host', {});
    return result;
  };
  const shutdown = runtime.shutdown.bind(runtime);
  let closing;
  runtime.shutdown = (reason) => (closing ??= shutdown(reason));
  const app = Fastify();
  t.after(async () => {
    try {
      await app.close();
      await runtime.shutdown('test_cleanup');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const installed = await runtime.inventory.installPackage({
    manifest,
    computedPackageDigest: packageDigest,
    expectedPackageDigest: packageDigest,
    packagePluginId: manifest.pluginId,
    ...(options.configuration ? { provenance: { kind: 'local-directory' } } : {}),
  });
  await runtime.inventoryStore.transaction(async (tx) => {
    const instance = await tx.instances.get(installed.pluginInstanceId);
    await tx.instances.put({ ...instance, configReadiness: 'ready', activationState: 'enabled' });
  });
  try {
    await runtime.supervisor.start(installed.pluginInstanceId);
  } catch (error) {
    console.dir(error, { depth: 8 });
    throw error;
  }
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = owner;
  });
  await app.register(pluginWebhookForwardingRoutes, {
    webhooks: runtime.supervisor,
    timeoutMs: options.timeoutMs ?? 1000,
  });
  const token = await readPluginNativeToken(
    runtime.supervisor.nativeActions.environment(installed.pluginInstanceId, 'native'),
  );
  assert.ok(token);
  return {
    root,
    get events() {
      return readFileSync(eventsFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    owner,
    thread,
    threads,
    messages,
    runtime,
    installed,
    host: () => host,
    refreshMembers: () => runtime.supervisor.invoke(installed.pluginInstanceId, 'fixture.refreshMembers', {}),
    http: (service, method, value) =>
      app.inject({
        method: 'POST',
        url: '/api/plugins/dev.clowder.neutral-host/owner',
        headers: { origin: 'http://localhost:5173' },
        payload: { service, method, ...(value === undefined ? {} : { value }) },
      }),
    httpGet: (service, method, value) =>
      app.inject({
        method: 'GET',
        url:
          '/api/plugins/dev.clowder.neutral-host/owner?input=' +
          encodeURIComponent(JSON.stringify({ service, method, value })),
        headers: { origin: 'http://localhost:5173' },
      }),
    native: (service, method, value, overrides = {}) =>
      runtime.supervisor.nativeActions.call(
        token,
        'neutral.call',
        { service, method, value },
        {
          catId: 'cat',
          userId: owner,
          threadId: thread.id,
          invocationId: 'inv',
          assertCurrent: async () => {},
          ...overrides,
        },
      ),
  };
}
