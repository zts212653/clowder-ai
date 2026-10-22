/**
 * configurationVariants (contract 0.2.0) — end-to-end activation acceptance (design §3.4).
 *
 * WHY THIS EXISTS: the feishu plugin must receive its Verification Token (FEISHU_TOKEN) on the
 * declared MCP launch environment exactly when webhook mode is selected and a Token is stored,
 * and must fail closed when webhook mode is selected without one. These tests drive the real
 * install → configure → enable path against a feishu-shaped fixture package and read the actual
 * materialized MCP capability env, so no consumer can silently regress while unit tests stay green.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';
import { createModuleActionClient } from '@clowder-ai/plugin-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Fastify from 'fastify';

import { fileBasedMcpIO } from '../dist/config/capabilities/capability-mcp-service.js';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { resolveProviderMcpConfig } from '../dist/domains/cats/services/agents/providers/provider-mcp-config.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { pluginNativeActionRoutes } from '../dist/routes/plugin-native-action-routes.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function fakeTaskRunner() {
  return {
    registerPostStart() {},
    unregister() {
      return true;
    },
  };
}

function createRuntime(projectRoot, mcpConfigIO) {
  const limbRegistry = new LimbRegistry();
  return {
    limbRegistry,
    runtime: createDormantPluginRuntimeComposition({
      projectRoot,
      messageStore: new MessageStore(),
      contract: {
        manifestContractRange: '0.1.0 || 0.2.0',
        validateEffectiveGrants,
        validateManifest,
      },
      limbRegistry,
      taskRunner: fakeTaskRunner(),
      mcpConfigIO: mcpConfigIO ?? {
        readConfig: () => readCapabilitiesConfig(projectRoot),
        writeAndRegenCli: (config) => writeCapabilitiesConfig(projectRoot, config),
        withLock: (fn) => withCapabilityLock(projectRoot, fn),
      },
    }),
  };
}

/** The feishu-shaped target declaration (brief §47-64): Token required iff webhook. */
function feishuManifest() {
  return {
    pluginId: 'dev.clowder.feishu',
    version: '1.0.0',
    contractVersion: '0.2.0',
    name: 'Feishu',
    contributions: [
      {
        type: 'mcp',
        id: 'feishu-mcp',
        runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
        environment: { FEISHU_TOKEN: { source: 'secret', key: 'verificationToken' } },
      },
    ],
    features: [
      {
        id: 'messaging',
        name: 'Messaging',
        resources: [],
        contributions: [{ type: 'mcp', id: 'feishu-mcp' }],
        capabilities: ['plugin.config.read', 'secret.read'],
      },
    ],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
    configuration: [
      {
        key: 'connectionMode',
        label: '连接模式',
        kind: 'select',
        required: true,
        default: 'websocket',
        options: [
          { value: 'websocket', label: '长连接' },
          { value: 'webhook', label: '回调' },
        ],
      },
      {
        key: 'verificationToken',
        label: 'Verification Token',
        kind: 'secret',
        required: true,
        requiredWhen: { key: 'connectionMode', value: 'webhook' },
      },
      { key: 'appId', label: 'App ID', kind: 'string', required: true },
    ],
    configurationVariants: {
      discriminator: 'connectionMode',
      branches: [
        {
          id: 'webhook',
          when: { properties: { connectionMode: { const: 'webhook' } } },
          fields: ['verificationToken'],
        },
        {
          id: 'websocket',
          when: { properties: { connectionMode: { const: 'websocket' } } },
          fields: [],
        },
      ],
    },
  };
}

async function writeFixturePackage(nativeAction = false, mcpTools = false) {
  const packageRoot = await tempRoot('cat-cafe-variants-feishu-package-');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  const manifest = feishuManifest();
  if (nativeAction) manifest.contributions[0].actions = [{ method: 'native.run' }];
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  await writeFile(
    join(packageRoot, 'dist/plugin.js'),
    'export default { create() { return { start() { return { actions: { "native.run": async input => input }, stop() {} }; } }; } };\n',
    'utf8',
  );
  await writeFile(
    join(packageRoot, 'dist/mcp.js'),
    mcpTools
      ? `import { createInterface } from 'node:readline';
import { createModuleActionClient } from ${JSON.stringify(import.meta.resolve('@clowder-ai/plugin-sdk'))};
if (!process.env.CLOWDER_PLUGIN_ACTION_TOKEN) process.exit(2);
const actions = createModuleActionClient();
createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  try {
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'runtime-root-fixture', version: '1' } }
    : request.method === 'tools/call'
    ? { content: [{ type: 'text', text: JSON.stringify(await actions.invoke('native.run', request.params.arguments)) }] }
    : { tools: [{ name: 'fixture_native_action', inputSchema: { type: 'object' } }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.message } }) + '\\n');
  }
});
`
      : 'process.exit(0);\n',
    'utf8',
  );
  return packageRoot;
}

/** Install, configure, then enable — the real owner path. Returns the materialized MCP env. */
async function installConfigureEnable(updates, roots) {
  const projectRoot =
    (roots?.configOnWorkspace ? roots.workspace : roots?.runtime) ??
    (await tempRoot('cat-cafe-variants-feishu-project-'));
  const configRoot = roots?.workspace ?? projectRoot;
  const packageRoot = await writeFixturePackage(Boolean(roots), roots?.mcpTools);
  const io = roots
    ? fileBasedMcpIO(configRoot, {
        google: join(configRoot, '.gemini/settings.json'),
        antigravity: join(configRoot, '.test-antigravity/mcp.json'),
      })
    : undefined;
  const { runtime } = createRuntime(projectRoot, io);
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy: (manifest) => manifest.features.flatMap((feature) => [...feature.capabilities]),
  });
  const installed = await composition.manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  const beforeConfigure = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.configure(installed.pluginId, {
    expectedRevision: beforeConfigure.lifecycleRevision,
    updates,
  });
  const beforeEnable = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: beforeEnable.lifecycleRevision,
  });
  const capability = (await readCapabilitiesConfig(configRoot))?.capabilities.find(
    (candidate) => candidate.type === 'mcp' && candidate.pluginId === installed.pluginId,
  );
  return { capability, composition, installed, runtime };
}

test('websocket mode without a Token activates with no FEISHU_TOKEN on the MCP launch env', async () => {
  const { capability } = await installConfigureEnable([
    { key: 'connectionMode', value: 'websocket' },
    { key: 'appId', value: 'cli_1' },
  ]);
  assert.ok(capability?.mcpServer, 'the declared MCP must be installed as a Host capability');
  assert.equal('FEISHU_TOKEN' in (capability.mcpServer.env ?? {}), false);
});

test('webhook mode without the required Token refuses activation (fail-closed)', async () => {
  // The refusal may surface at either layer: the manager action gate
  // (§3.2 readiness: actions.setEnabled=false with `config-incomplete`) or the
  // lifecycle enable fence ('plugin configuration is not ready'). Both are
  // fail-closed; the exact wording is not the contract.
  await assert.rejects(
    installConfigureEnable([
      { key: 'connectionMode', value: 'webhook' },
      { key: 'appId', value: 'cli_1' },
    ]),
    /cannot change enabled state now|configuration is not ready|verificationToken is unavailable|configuration variant/,
  );
});

test('webhook mode with a Token delivers it to the actual MCP launch env', async () => {
  const { capability } = await installConfigureEnable([
    { key: 'connectionMode', value: 'webhook' },
    { key: 'verificationToken', value: 'tok_feishu' },
    { key: 'appId', value: 'cli_1' },
  ]);
  assert.ok(capability?.mcpServer, 'the declared MCP must be installed as a Host capability');
  assert.equal(capability.mcpServer.env?.FEISHU_TOKEN, 'tok_feishu');
});

test('variant changes refresh existing project MCP providers while preserving member and project blocks', async () => {
  const projectRoot = await tempRoot('variants-cascade-home-');
  const consumer = await tempRoot('variants-cascade-consumer-');
  const blockedProject = await tempRoot('variants-cascade-blocked-');
  for (const root of [projectRoot, consumer, blockedProject]) {
    await writeCapabilitiesConfig(root, { version: 2, capabilities: [] });
  }
  await writeFile(
    join(projectRoot, '.cat-cafe/governance-registry.json'),
    JSON.stringify({ entries: [consumer, blockedProject].map((projectPath) => ({ projectPath })) }),
  );
  const io = fileBasedMcpIO(projectRoot, {
    google: join(projectRoot, '.gemini/settings.json'),
    antigravity: join(projectRoot, '.test-antigravity/mcp.json'),
  });
  const { runtime } = createRuntime(projectRoot, io);
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy: (manifest) => manifest.features.flatMap((feature) => [...feature.capabilities]),
  });
  const installed = await composition.manager.install({
    source: { kind: 'local-directory', path: await writeFixturePackage(true) },
  });
  const configure = async (updates) => {
    const current = (await composition.manager.get(installed.pluginId)).plugin;
    await composition.manager.configure(installed.pluginId, { expectedRevision: current.lifecycleRevision, updates });
  };
  await configure([
    { key: 'connectionMode', value: 'websocket' },
    { key: 'verificationToken', value: 'fixture-variant-secret' },
    { key: 'appId', value: 'cli_fixture' },
  ]);
  const beforeEnable = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: beforeEnable.lifecycleRevision,
  });
  const id = `plugin:${installed.pluginId}:feishu-mcp`;
  const name = id.replaceAll(':', '__');
  const entryAt = async (root) => (await readCapabilitiesConfig(root)).capabilities.find((entry) => entry.id === id);
  const initial = await entryAt(consumer);
  assert.ok(initial?.mcpServer, 'activation must reach an existing project automatically');
  assert.equal(Object.hasOwn(initial.mcpServer.env ?? {}, 'FEISHU_TOKEN'), false);
  assert.equal(
    initial.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN,
    runtime.supervisor.nativeActions.environmentReferences(installed.pluginInstanceId, 'feishu-mcp')
      .CLOWDER_PLUGIN_ACTION_TOKEN,
    'registration must persist only an environment reference',
  );
  const initialActionToken = runtime.supervisor.nativeActions.environment(
    installed.pluginInstanceId,
    'feishu-mcp',
  ).CLOWDER_PLUGIN_ACTION_TOKEN;
  assert.ok(initialActionToken);
  const allCats = [...catRegistry.getAllIds()];
  const allowedCat = allCats.find((catId) => catId !== 'codex');
  assert.ok(allowedCat);
  await writeCapabilitiesConfig(consumer, {
    version: 2,
    capabilities: [{ ...initial, blockedCats: ['codex'] }],
  });
  await writeCapabilitiesConfig(blockedProject, {
    version: 2,
    capabilities: [{ ...initial, blockedCats: allCats }],
  });
  const inject = async (workingDirectory, catId) =>
    (
      await resolveProviderMcpConfig({
        callbackEnv: { CAT_CAFE_CAT_ID: catId },
        workingDirectory,
        mcpServerPath: join(projectRoot, 'packages/mcp-server/dist/index.js'),
        provider: 'codex',
      })
    )[name];
  try {
    // Configuring an enabled plugin refreshes its runtime in place.
    // Both branch transitions must update the existing project descriptor.
    for (const mode of ['webhook', 'websocket', 'webhook']) {
      await configure([{ key: 'connectionMode', value: mode }]);
      for (const root of [projectRoot, consumer, blockedProject]) {
        const entry = await entryAt(root);
        assert.ok(entry?.mcpServer, `${mode}: descriptor must still exist`);
        assert.equal(
          Object.hasOwn(entry.mcpServer.env ?? {}, 'FEISHU_TOKEN'),
          mode === 'webhook',
          `${mode}: ${root === projectRoot ? 'host' : root === consumer ? 'consumer' : 'blocked project'} descriptor`,
        );
      }
      const provider = await inject(consumer, allowedCat);
      assert.ok(provider, `${mode}: allowed member must receive the refreshed descriptor`);
      assert.equal(Object.hasOwn(provider.env ?? {}, 'FEISHU_TOKEN'), mode === 'webhook');
      const native = await runtime.supervisor.resolveNativeMcpLaunch({
        mode: 'plugin_native',
        pluginInstanceId: installed.pluginInstanceId,
        contributionId: 'feishu-mcp',
        actionMethods: ['native.run'],
      });
      assert.equal(Object.hasOwn(native.env, 'FEISHU_TOKEN'), mode === 'webhook');
      assert.ok(native.env.CLOWDER_PLUGIN_ACTION_TOKEN === initialActionToken, 'live refresh must not rotate tokens');
      assert.deepEqual(
        await runtime.supervisor.nativeActions.call(
          initialActionToken,
          'native.run',
          { mode },
          {
            userId: 'owner',
            catId: allowedCat,
            threadId: 'thread',
            invocationId: 'inv',
            assertCurrent: async () => {},
          },
        ),
        { mode },
      );
      assert.deepEqual((await entryAt(consumer)).blockedCats, ['codex']);
      assert.deepEqual((await entryAt(blockedProject)).blockedCats, allCats);
      assert.equal(await inject(consumer, 'codex'), undefined);
      assert.equal(await inject(blockedProject, allowedCat), undefined);
    }
    const fields = (await composition.manager.get(installed.pluginId)).plugin.configFields;
    assert.notEqual(fields.find((field) => field.key === 'verificationToken').currentValue, null);
  } finally {
    await runtime.supervisor.stopAll('test_complete');
  }
});

for (const configOnWorkspace of [false, true])
  test(`production composition launches plugins across separate runtime/workspace roots (configOnWorkspace=${configOnWorkspace})`, async (t) => {
    const runtimeRoot = await tempRoot('plugin-runtime-wiring-');
    const workspaceRoot = await tempRoot('plugin-workspace-wiring-');
    const consumer = await tempRoot('plugin-consumer-wiring-');
    const saved = Object.fromEntries(
      ['CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT'].map((key) => [key, process.env[key]]),
    );
    let ownedRuntime;
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    try {
      process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
      process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
      await writeCapabilitiesConfig(workspaceRoot, { version: 2, capabilities: [] });
      const f = await installConfigureEnable(
        [
          { key: 'connectionMode', value: 'websocket' },
          { key: 'appId', value: 'cli_1' },
        ],
        { runtime: runtimeRoot, workspace: workspaceRoot, configOnWorkspace },
      );
      ownedRuntime = f.runtime;
      await writeCapabilitiesConfig(consumer, { version: 2, capabilities: [f.capability] });
      const id = f.capability.id;
      const live = await f.runtime.supervisor.resolveNativeMcpLaunch({
        mode: 'plugin_native',
        pluginInstanceId: f.installed.pluginInstanceId,
        contributionId: 'feishu-mcp',
        actionMethods: ['native.run'],
      });
      assert.ok(live?.env.CLOWDER_PLUGIN_ACTION_TOKEN);
      assert.match(f.capability.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN, /^\$\{[A-Z0-9_]+\}$/);
      const servers = await resolveProviderMcpConfig({
        workingDirectory: consumer,
        mcpServerPath: join(runtimeRoot, 'packages/mcp-server/dist/index.js'),
        callbackEnv: { CAT_CAFE_CAT_ID: catRegistry.getAllIds()[0] },
      });
      const server = servers[id.replaceAll(':', '__')];
      assert.ok(server, 'real composition must provide the live plugin despite distinct runtime/workspace roots');
      assert.equal(server.env.CLOWDER_PLUGIN_ACTION_TOKEN, live.env.CLOWDER_PLUGIN_ACTION_TOKEN);
      assert.equal(server.command, live.command);
      assert.deepEqual(server.args, [...live.args]);
    } finally {
      await ownedRuntime?.shutdown();
    }
  });

test('package API cwd without runtime override reaches MCP tools/list through production composition', async () => {
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const workspaceRoot = await tempRoot('plugin-api-cwd-policy-');
  const consumer = await tempRoot('plugin-api-cwd-consumer-');
  const previousCwd = process.cwd();
  const saved = Object.fromEntries(
    ['CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT'].map((key) => [key, process.env[key]]),
  );
  let ownedRuntime;
  let client;
  try {
    delete process.env.CAT_CAFE_RUNTIME_ROOT;
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    process.chdir(join(runtimeRoot, 'packages/api'));
    await writeCapabilitiesConfig(workspaceRoot, { version: 2, capabilities: [] });
    const f = await installConfigureEnable(
      [
        { key: 'connectionMode', value: 'websocket' },
        { key: 'appId', value: 'cli_1' },
      ],
      {
        runtime: runtimeRoot,
        workspace: workspaceRoot,
        configOnWorkspace: true,
        mcpTools: true,
      },
    );
    ownedRuntime = f.runtime;
    await writeCapabilitiesConfig(consumer, { version: 2, capabilities: [f.capability] });
    const servers = await resolveProviderMcpConfig({
      workingDirectory: consumer,
      mcpServerPath: join(runtimeRoot, 'packages/mcp-server/dist/index.js'),
      callbackEnv: { CAT_CAFE_CAT_ID: catRegistry.getAllIds()[0] },
    });
    const server = servers[f.capability.id.replaceAll(':', '__')];
    assert.ok(server, 'an enabled plugin must remain discoverable from the normal packages/api startup cwd');
    client = new Client({ name: 'api-cwd-acceptance', version: '1' });
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: server.env }));
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ['fixture_native_action'],
    );
  } finally {
    await client?.close();
    await ownedRuntime?.shutdown();
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const legacy of ['missing-env-mapping', 'persisted-old-token']) {
  test(`startup recovers an already installed plugin with ${legacy} without reinstall or retoggle`, async () => {
    const host = await tempRoot('plugin-existing-install-upgrade-');
    const consumer = await tempRoot('plugin-existing-install-consumer-');
    await writeCapabilitiesConfig(host, { version: 2, capabilities: [] });
    const f = await installConfigureEnable(
      [
        { key: 'connectionMode', value: 'webhook' },
        { key: 'verificationToken', value: ' preserved legacy secret ' },
        { key: 'appId', value: 'existing-app' },
      ],
      { runtime: host, workspace: host, mcpTools: true },
    );
    const before = await f.runtime.inventoryStore.snapshot();
    const originalReference = f.capability.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN;
    const previousToken = process.env[originalReference.slice(2, -1)];
    await f.runtime.shutdown();
    delete process.env[originalReference.slice(2, -1)];
    const existing = structuredClone(f.capability);
    delete existing.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN;
    delete existing.mcpServer.env.CLOWDER_PLUGIN_ACTION_PATH;
    if (legacy === 'persisted-old-token') {
      existing.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN = previousToken;
      existing.mcpServer.env.CLOWDER_PLUGIN_ACTION_PATH = '/api/plugin-runtime/action';
    }
    await writeCapabilitiesConfig(host, { version: 2, capabilities: [existing] });
    await writeCapabilitiesConfig(consumer, { version: 2, capabilities: [existing] });
    const projectFile = join(consumer, '.cat-cafe/capabilities.json');
    const projectBytes = await readFile(projectFile, 'utf8');
    const { runtime: restarted } = createRuntime(host);
    let client;
    const app = Fastify();
    try {
      const recovery = await restarted.recoverAfterRestart();
      await restarted.lifecycle.drainRestartRecovery();
      assert.equal(recovery.resumeRequested, 1);
      const registered = (await readCapabilitiesConfig(host)).capabilities.find((e) => e.id === existing.id);
      assert.equal(registered.mcpServer.env.CLOWDER_PLUGIN_ACTION_TOKEN, originalReference);
      const token = process.env[originalReference.slice(2, -1)];
      assert.ok(token);
      assert.notEqual(token, previousToken);
      const after = await restarted.inventoryStore.snapshot();
      assert.deepEqual(after.grants, before.grants);
      assert.equal(after.instances[0].pluginInstanceId, before.instances[0].pluginInstanceId);
      assert.equal(after.instances[0].packageDigest, before.instances[0].packageDigest);
      assert.equal(after.instances[0].activationState, 'enabled');
      const invocation = {
        userId: 'owner',
        catId: catRegistry.getAllIds()[0],
        threadId: 'fixture-thread',
        invocationId: 'fixture-invocation',
        callbackToken: 'fixture-callback',
      };
      const verify = async (id, credential) =>
        id === invocation.invocationId && credential === invocation.callbackToken
          ? { ok: true, record: invocation }
          : { ok: false, reason: 'invalid_token' };
      await app.register(pluginNativeActionRoutes, {
        actions: restarted.supervisor.nativeActions,
        registry: { verify, verifyLatest: verify, isStartupRecoveryComplete: () => true },
        sources: {
          invocationTracker: { getActiveSlots: () => [] },
          messageStore: { getById: async () => null },
        },
      });
      const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
      const servers = await resolveProviderMcpConfig({
        workingDirectory: consumer,
        mcpServerPath: join(host, 'packages/mcp-server/dist/index.js'),
        callbackEnv: {
          CAT_CAFE_API_URL: apiUrl,
          CAT_CAFE_CAT_ID: invocation.catId,
          CAT_CAFE_INVOCATION_ID: invocation.invocationId,
          CAT_CAFE_CALLBACK_TOKEN: invocation.callbackToken,
        },
      });
      const server = servers[existing.id.replaceAll(':', '__')];
      assert.ok(server);
      assert.equal(server.env.CLOWDER_PLUGIN_ACTION_TOKEN, token);
      assert.equal(server.env.FEISHU_TOKEN, ' preserved legacy secret ');
      assert.equal(await readFile(projectFile, 'utf8'), projectBytes, 'unregistered legacy project needs no rewrite');
      client = new Client({ name: 'existing-install-upgrade', version: '1' });
      await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: server.env }));
      assert.deepEqual(
        (await client.listTools()).tools.map((t) => t.name),
        ['fixture_native_action'],
      );
      assert.deepEqual(
        JSON.parse(
          (await client.callTool({ name: 'fixture_native_action', arguments: { value: 'recovered' } })).content[0].text,
        ),
        { value: 'recovered' },
      );
      const staleClient = createModuleActionClient({
        env: { ...server.env, CLOWDER_PLUGIN_ACTION_TOKEN: previousToken },
      });
      await assert.rejects(staleClient.invoke('native.run', {}), /HTTP 401/);
      assert.equal(await readFile(projectFile, 'utf8'), projectBytes, 'SDK action must not rewrite the project');
    } finally {
      await client?.close();
      await app.close();
      await restarted.shutdown();
    }
  });
}
