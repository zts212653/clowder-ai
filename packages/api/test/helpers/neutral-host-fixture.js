import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateManifest } from '@clowder-ai/plugin-contract';
import Fastify from 'fastify';
import { InMemoryFrustrationIssueStore } from '../../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createDormantPluginRuntimeComposition } from '../../dist/domains/plugin/runtime-composition.js';
import { pluginWebhookForwardingRoutes } from '../../dist/routes/plugin/plugin-webhook-forwarding-routes.js';

export async function neutralFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'f202-neutral-host-'));
  const packageRoot = join(root, 'package');
  await mkdir(packageRoot);
  const owner = process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner';
  const messages = options.messageStore ?? new MessageStore();
  const threads = new ThreadStore();
  const thread = await threads.create(owner, 'source');
  const store = options.store ?? new InMemoryFrustrationIssueStore();
  const draft = await store.create({
    threadId: thread.id,
    userId: owner,
    catId: 'cat-test',
    signalType: 'cli_error',
    signalDetail: { reasonCode: 'error', publicSummary: 'public', secret: 'hidden' },
    context: { recentMessages: [{ role: 'user', content: 'private', timestamp: 1 }], errorLogs: 'private log' },
  });
  await store.confirm({ issueId: draft.issueId, userDescription: 'confirmed' });
  let config = null,
    host;
  const key = randomUUID();
  globalThis[key] = (value) => {
    host = value;
  };
  const capabilities = options.capabilities ?? ['deployment.read', 'frustration.read', 'frustration.link'];
  const manifest = {
    pluginId: 'dev.clowder.neutral-host',
    name: 'Neutral Host fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    runtime: { transport: 'builtin', entrypoint: 'plugin.mjs' },
    features: [
      {
        id: 'neutral',
        name: 'Neutral',
        resources: [],
        capabilities,
        contributions: [
          { type: 'webhook', id: 'owner' },
          ...(options.independentNative ? [] : [{ type: 'mcp', id: 'native' }]),
        ],
      },
      // A zero-capability test action can attempt a Host call, but cannot acquire the port's grant.
      ...(options.independentNative
        ? [
            {
              id: 'probe',
              name: 'Probe',
              resources: [],
              capabilities: [],
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
        actions: [{ method: 'neutral.call' }],
      },
    ],
  };
  const validation = validateManifest(manifest);
  assert.equal(validation.valid, true, JSON.stringify(validation));
  const source = `export default { create() { return { start(host) { globalThis[${JSON.stringify(key)}](host);
    const call = async input => { const method = host[input.service]?.[input.method];
      return { available: typeof method === 'function', result: method ? await method(input.value) : null }; };
    return { ${options.publicVerifier ? 'publicInvocationVerifier: async (_input, context) => { await context.assertCurrent(); return { current: true }; },' : ''} actions: { 'neutral.http': async ({request}) => ({status:200, body:await call(request.method === 'GET' ? JSON.parse(request.query.input) : request.body)}),
      'neutral.call': call }, stop() {} }; } }; } };`;
  await writeFile(join(packageRoot, 'plugin.mjs'), source);
  await writeFile(join(packageRoot, 'mcp.js'), '// Never spawned by this fixture.\n');
  const packageDigest = `sha512-${createHash('sha512').update(source).digest('base64')}`;
  const roster = {
    cat: { family: 'maine-coon', available: true, lead: true, roles: ['reviewer'], evaluation: 'private evaluation' },
  };
  const policy = {
    requireDifferentFamily: true,
    preferActiveInThread: true,
    preferLead: true,
    excludeUnavailable: true,
  };
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: root,
    threadOwnerUserId: owner,
    messageStore: messages,
    ...(options.taskStore ? { taskStore: options.taskStore } : {}),
    threadStore: threads,
    ...(options.publicInvocations ? { publicInvocations: options.publicInvocations } : {}),
    ...(options.threadProjections ? { threadProjections: options.threadProjections } : {}),
    ...(options.participantRoster ? { participantRoster: options.participantRoster } : {}),
    ...(options.unavailable
      ? {}
      : {
          frustrationIssueStore: store,
          deployment: {
            getRoster: () => roster,
            getDefaultCatId: () => 'cat',
            getReviewPolicy: () => policy,
          },
        }),
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
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await runtime.shutdown('test_cleanup');
    delete globalThis[key];
    await rm(root, { recursive: true, force: true });
  });
  const installed = await runtime.inventory.installPackage({
    manifest,
    computedPackageDigest: packageDigest,
    expectedPackageDigest: packageDigest,
    packagePluginId: manifest.pluginId,
    effectiveGrants: options.grants ?? capabilities,
  });
  await runtime.inventoryStore.transaction((tx) => {
    const instance = tx.instances.get(installed.pluginInstanceId);
    tx.instances.put({ ...instance, configReadiness: 'ready', activationState: 'enabled' });
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
  const token = runtime.supervisor.nativeActions.environment(
    installed.pluginInstanceId,
    'native',
  ).CLOWDER_PLUGIN_ACTION_TOKEN;
  assert.ok(token);
  return {
    root,
    owner,
    thread,
    threads,
    messages,
    store,
    draft,
    roster,
    policy,
    runtime,
    installed,
    host: () => host,
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
