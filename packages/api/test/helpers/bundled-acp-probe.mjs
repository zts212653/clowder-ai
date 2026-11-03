import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.BUNDLED_ACP_TEST_ROOT;
const load = (path) => import(pathToFileURL(join(root, 'dist', path)).href);
const { entry, action } = JSON.parse(await readFile(join(root, 'case.json'), 'utf8'));
const manifest = JSON.parse(
  await readFile(
    join(root, 'dist/domains/plugin/bundled-packages', entry.catalogId, entry.version, 'manifest.json'),
    'utf8',
  ),
);
const Fastify = createRequire(join(root, 'package.json'))('fastify');
const { createDormantPluginRuntimeComposition, createPluginManagerRuntimeComposition } = await load(
  'domains/plugin/runtime-composition.js',
);
const { MessageStore } = await load('domains/cats/services/stores/ports/MessageStore.js');
const { SessionImplementationRegistry } = await load(
  'domains/cats/services/agents/session-contract/implementation-registry.js',
);
const { RegisteredSessionAgentService } = await load(
  'domains/cats/services/agents/session-contract/registered-session-agent-service.js',
);
const { createRefreshingAcpSessionProvider } = await load(
  'domains/cats/services/agents/session-contract/acp-session-provider.js',
);
const { createAcpServiceForConfig } = await load('domains/cats/services/agents/providers/acp/AcpServiceFactory.js');
const { declaredAgentSessionProviders } = await load('domains/plugin/declared/declared-agent-session-providers.js');
const { fetchOfficialPackageArchive } = await load('domains/plugin/bundled-package-source.js');
const { OfficialPluginInstallError } = await load('domains/plugin/official-package-errors.js');
const { registerPluginManagerRoutes, pluginManagerUploadRoutes } = await load('routes/plugin-manager-routes.js');
const { registerAgentClientLibraryRoutes } = await load('routes/agent-client-library-routes.js');
const { readPluginConfig } = await load('domains/plugin/plugin-config-store.js');
const { RuntimeInteractionService } = await load('domains/runtime-interaction/RuntimeInteractionService.js');
const { InMemoryRuntimeInteractionStore } = await load(
  'domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js',
);
const { MessageRuntimeInteractionCardPublisher } = await load(
  'domains/runtime-interaction/RuntimeInteractionCardPublisher.js',
);
const { runtimeInteractionRoutes } = await load('routes/runtime-interaction-routes.js');
if (action === 'execute' && process.platform !== 'win32') {
  const { buildChildEnv } = await load('utils/cli-spawn.js');
  assert.equal(
    buildChildEnv().CAT_CAFE_VERDICT_GH_GUARD_ROOT,
    await realpath(process.env.BUNDLED_ACP_TEST_WORKSPACE_ROOT),
    'the real CLI guard must own its files inside the isolated runtime root',
  );
}
const projectRoot = join(root, action.startsWith('local') || action === 'execute' ? `project-${action}` : 'project');
await mkdir(projectRoot, { recursive: true });
const registry = new SessionImplementationRegistry();
const services = new Map(
  (action === 'execute' ? ['codex', 'opus'] : []).map((catId) => [
    catId,
    new RegisteredSessionAgentService({
      catId,
      ref: { pluginId: entry.pluginId, contributionId: entry.catalogId },
      registry,
    }),
  ]),
);
const pools = new Map();
if (action === 'execute' && process.platform === 'win32')
  process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
const runtime = createDormantPluginRuntimeComposition({
  projectRoot,
  messageStore: new MessageStore(),
  agentSessionProviders: (packages, configuration) =>
    declaredAgentSessionProviders({
      packages,
      configuration,
      registry,
      services,
      settings: { mode: 'plugin', bindings: new Map() },
      createProvider: (declaration, { catId }) => {
        assert.equal(action, 'execute', 'installation must not execute a native client');
        return createRefreshingAcpSessionProvider({
          catId,
          scope: {},
          revision: () => 1,
          createService: () =>
            createAcpServiceForConfig({
              projectRoot,
              profileId: catId,
              config: {
                id: catId,
                clientId: 'acp',
                configurationSource: 'native_tool',
                defaultModel: '',
                mcpSupport: false,
                executionApproval: catId === 'opus' ? 'ask_user' : 'auto',
              },
              effectiveModel: '',
              acpConfig: declaration.acp,
              bootstrapRoot: declaration.acp.bootstrapRoot,
              poolRegistry: pools,
              log: { info() {}, warn() {} },
            }),
        });
      },
    }),
});
let failOnce = action === 'retry' || action === 'quarantine';
const { manager } = createPluginManagerRuntimeComposition({
  runtime,
  catalogManifests: [manifest],
  catalogProvider: { snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: Date.now() }) },
  fetchOfficialArchive: async (candidate) => {
    const bytes = await fetchOfficialPackageArchive(candidate);
    if (!failOnce) return bytes;
    failOnce = false;
    if (action === 'quarantine') return Buffer.concat([bytes, Buffer.from('corrupt')]);
    throw new OfficialPluginInstallError('PACKAGE_DOWNLOAD_FAILED', 'Fixture transient read failure');
  },
});
const logs = [];
const app = Fastify({ logger: { level: 'warn', stream: { write: (line) => logs.push(JSON.parse(line)) } } });
const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'fixture-owner';
app.addHook('preHandler', async (request) => {
  request.sessionUserId = owner;
});
const interactionStore = new InMemoryRuntimeInteractionStore();
const answers = [];
const messages = new MessageStore();
const interactions = new RuntimeInteractionService({
  store: interactionStore,
  hostEpoch: 'fixture-host',
  cardPublisher: new MessageRuntimeInteractionCardPublisher({
    messageStore: messages,
    socketManager: { broadcastToRoom() {} },
  }),
  onRecordUpdated: (record) => {
    if (record.status !== 'pending') return;
    answers.push(
      app
        .inject({
          method: 'POST',
          url: `/api/runtime-interactions/${record.request.interactionId}/respond`,
          headers: { 'x-cat-cafe-user': owner },
          payload: {
            cardRef: record.cardRef,
            response: {
              kind: 'decision',
              decisionId: record.request.decisions.find((decision) => decision.outcome === 'accept').id,
            },
          },
        })
        .then((response) => {
          assert.equal(response.statusCode, 200, response.payload);
          return record.request;
        }),
    );
  },
});
await app.register(runtimeInteractionRoutes, { service: interactions });
const audit = [];
const routes = {
  manager,
  auditLog: {
    append: async (event) => {
      audit.push(event);
    },
  },
};
registerPluginManagerRoutes(app, routes);
registerAgentClientLibraryRoutes(app, {
  inventory: runtime.inventoryStore,
  packages: runtime.packages,
  registry,
  configuration: { readConfig: async (_instanceId, key) => readPluginConfig(projectRoot, entry.pluginId)[key] },
});
await app.register(pluginManagerUploadRoutes, routes);
const request = (url, payload) =>
  app.inject({
    method: 'POST',
    url,
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost', origin: 'http://localhost' },
    payload,
  });
const install = () =>
  request('/api/plugin-manager/plugins/install', {
    source: { kind: 'catalog', catalogId: entry.catalogId },
    expectedVersion: entry.version,
    expectedDigest: entry.packageDigest,
  });
try {
  let failed;
  if (action === 'retry' || action === 'quarantine') {
    const response = await install();
    failed = { status: response.statusCode, body: response.json() };
    assert.equal((await runtime.inventoryStore.snapshot()).instances.length, 0);
  }
  const before = await runtime.inventoryStore.snapshot();
  const beforeConfig = await readPluginConfig(projectRoot, entry.pluginId);
  const retained = join(projectRoot, 'retained-history.ndjson');
  if (action === 'seed') await writeFile(retained, '{"sessionId":"original","text":"KEEP HISTORY"}\n');
  let response;
  if (action.startsWith('local')) {
    const boundary = '----same-bundled-acp-bytes';
    const bytes = await readFile(join(root, 'dist/domains/plugin/bundled-packages', entry.archivePath));
    response = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/install/upload',
      remoteAddress: '127.0.0.1',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="client.tgz"\r\nContent-Type: application/gzip\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
  } else if (action.startsWith('update')) {
    response = await request(`/api/plugin-manager/plugins/${entry.pluginId}/update`, {
      expectedVersion: entry.version,
      expectedRevision: before.instances[0].lifecycleRevision,
    });
  } else response = await install();
  const result = { status: response.statusCode, body: response.json(), failed, logs, auditCount: audit.length };
  if (response.statusCode < 300 && action.endsWith('-admission')) {
    result.snapshot = await runtime.inventoryStore.snapshot();
    result.initialIntent = (await manager.getLocal(entry.pluginId)).plugin.intent;
    result.registered = registry.has({ pluginId: entry.pluginId, contributionId: entry.catalogId });
  } else if (response.statusCode < 300) {
    let detail = (await manager.getLocal(entry.pluginId)).plugin;
    result.instanceId = detail.pluginInstanceId;
    result.initialIntent = detail.intent;
    if (action === 'seed' || action === 'execute') {
      await manager.configure(entry.pluginId, {
        expectedRevision: detail.lifecycleRevision,
        updates: [
          {
            key: 'connection',
            value: JSON.stringify({
              command: process.execPath,
              startupArgs:
                action === 'execute'
                  ? [fileURLToPath(new URL('../fixtures/bundled-acp-agent.mjs', import.meta.url))]
                  : ['--acp-fixture'],
              ...(action === 'execute' ? { bootstrapRoot: join(projectRoot, 'bootstrap') } : {}),
              permissionPolicy: action === 'execute' ? 'auto_allow' : 'deny',
            }),
          },
        ],
      });
      await writeFile(
        join(projectRoot, 'member-bindings.json'),
        JSON.stringify({ role: 'retained-role', tool: `plugin:${entry.pluginId}/${entry.catalogId}` }),
      );
      detail = (await manager.getLocal(entry.pluginId)).plugin;
    }
    await manager.setEnabled(entry.pluginId, { enabled: true, expectedRevision: detail.lifecycleRevision });
    if (action === 'execute') process.stderr.write('fixture: enabled\n');
    result.registered = registry.has({ pluginId: entry.pluginId, contributionId: entry.catalogId });
    const catalog = await app.inject({ url: '/api/agent-providers', headers: { host: 'localhost' } });
    assert.equal(catalog.statusCode, 200, catalog.payload);
    result.library = catalog.json().libraries[0];
    if (action === 'execute') process.stderr.write('fixture: catalog read\n');
    if (action === 'execute') {
      result.turns = [];
      for (const [catId, text] of [
        ['codex', 'first-member'],
        ['codex', 'second-turn'],
        ['opus', 'other-member'],
      ]) {
        process.stderr.write(`fixture: invoking ${text}\n`);
        const messages = await Array.fromAsync(
          services.get(catId).invoke(text, {
            hostSessionId: `host-${catId}`,
            invocationId: `inv-${text}`,
            cwd: projectRoot,
            runtimeInteractionPort: interactions,
            auditContext: { userId: owner, threadId: 'fixture-thread', catId, invocationId: `inv-${text}` },
          }),
        );
        assert.equal(messages.at(-1).errorCode, undefined, JSON.stringify(messages));
        result.turns.push(
          messages
            .filter((message) => message.type === 'text')
            .map((message) => message.content)
            .join(''),
        );
      }
    }
    await manager.setEnabled(entry.pluginId, {
      enabled: false,
      expectedRevision: (await manager.getLocal(entry.pluginId)).plugin.lifecycleRevision,
    });
    result.unregistered = !registry.has({ pluginId: entry.pluginId, contributionId: entry.catalogId });
    if (action === 'execute') {
      process.stderr.write('fixture: re-enabling\n');
      await manager.setEnabled(entry.pluginId, {
        enabled: true,
        expectedRevision: (await manager.getLocal(entry.pluginId)).plugin.lifecycleRevision,
      });
      const messages = await Array.fromAsync(
        services.get('codex').invoke('after-reenable', {
          hostSessionId: 'host-codex',
          invocationId: 'inv-after-reenable',
          cwd: projectRoot,
        }),
      );
      process.stderr.write('fixture: re-enabled turn completed\n');
      assert.equal(messages.at(-1).errorCode, undefined, JSON.stringify(messages));
      result.reenabled = messages.some((message) => message.content?.includes('after-reenable:permission=allow'));
      await manager.setEnabled(entry.pluginId, {
        enabled: false,
        expectedRevision: (await manager.getLocal(entry.pluginId)).plugin.lifecycleRevision,
      });
    }
    result.approvals = await Promise.all(answers);
    result.pendingApprovals = (await interactionStore.listPendingByUser(owner)).length;
    result.snapshot = await runtime.inventoryStore.snapshot();
  } else result.snapshot = await runtime.inventoryStore.snapshot();
  if (action.startsWith('update')) {
    result.configRetained =
      JSON.stringify(beforeConfig) === JSON.stringify(await readPluginConfig(projectRoot, entry.pluginId));
    result.history = await readFile(retained, 'utf8');
    result.binding = JSON.parse(await readFile(join(projectRoot, 'member-bindings.json'), 'utf8'));
    result.sameInstance = before.instances[0].pluginInstanceId === result.snapshot.instances[0].pluginInstanceId;
    if (response.statusCode >= 300) assert.deepEqual(result.snapshot, before);
  }
  process.stdout.write(`RESULT:${JSON.stringify(result)}\n`);
} finally {
  await app.close();
  await runtime.shutdown('bundled_acp_probe_complete');
}
