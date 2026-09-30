import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { promisify } from 'node:util';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';

import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
import { activateDeclaredMcp } from '../dist/domains/plugin/declared/declared-mcp-resources.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';

const roots = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function fakeTaskRunner() {
  const tasks = new Map();
  return {
    tasks,
    registerPostStart(task) {
      if (tasks.has(task.id)) throw new Error(`duplicate task ${task.id}`);
      tasks.set(task.id, task);
    },
    unregister(taskId) {
      return tasks.delete(taskId);
    },
  };
}

function createRuntime(projectRoot, { limbRegistry = new LimbRegistry(), taskRunner = fakeTaskRunner() } = {}) {
  return {
    limbRegistry,
    taskRunner,
    runtime: createDormantPluginRuntimeComposition({
      projectRoot,
      routes: new MemorySignalRouteStore(),
      intakes: new MemoryMeetingIntakeStore(),
      messageStore: new MessageStore(),
      contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
      limbRegistry,
      taskRunner,
      mcpConfigIO: {
        readConfig: () => readCapabilitiesConfig(projectRoot),
        writeAndRegenCli: async (config) => {
          await writeCapabilitiesConfig(projectRoot, config);
          const path = join(projectRoot, '.test-cli', 'gemini.json');
          await mkdir(join(path, '..'), { recursive: true });
          const mcpServers = Object.fromEntries(
            config.capabilities
              .filter((capability) => capability.type === 'mcp' && capability.enabled && capability.mcpServer)
              .map((capability) => [capability.id.replaceAll(':', '__'), capability.mcpServer]),
          );
          await writeFile(path, `${JSON.stringify({ mcpServers })}\n`, 'utf8');
        },
        withLock: (fn) => withCapabilityLock(projectRoot, fn),
      },
    }),
  };
}

async function writeFixturePackage({
  pluginId,
  contribution,
  contributions,
  capabilities = [],
  files = {},
  actions = '{}',
  runtime = { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  omitRuntime = false,
}) {
  const packageRoot = await tempRoot(`cat-cafe-f202-${contribution.type}-package-`);
  const declared = contributions ?? [contribution];
  const manifest = {
    pluginId,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: `${contribution.type} fixture`,
    contributions: declared,
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        contributions: declared.map((item) => ({ type: item.type, id: item.id })),
        capabilities,
      },
    ],
    ...(omitRuntime ? {} : { runtime }),
  };
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  if (!omitRuntime && runtime.entrypoint !== undefined) {
    await writeFile(
      join(packageRoot, runtime.entrypoint),
      `export default { create() { return { start() { return { actions: ${actions}, stop() {} }; } }; } };\n`,
      'utf8',
    );
  }
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(packageRoot, path, '..'), { recursive: true });
    await writeFile(join(packageRoot, path), contents, 'utf8');
  }
  return packageRoot;
}

async function installAndEnable(runtime, packageRoot, localGrantPolicy = () => []) {
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy,
  });
  const installed = await composition.manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  const beforeEnable = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: beforeEnable.lifecycleRevision,
  });
  return { composition, installed };
}

async function disable(composition, pluginId) {
  const beforeDisable = (await composition.manager.get(pluginId)).plugin;
  await composition.manager.setEnabled(pluginId, {
    enabled: false,
    expectedRevision: beforeDisable.lifecycleRevision,
  });
}

test('an installed package activates and removes its declared MCP capability', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-mcp-project-');
  const packageRoot = await writeFixturePackage({
    pluginId: 'dev.clowder.mcp-fixture',
    contribution: {
      type: 'mcp',
      id: 'fixture-mcp',
      runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js', args: ['--fixture'] },
    },
    files: { 'dist/mcp.js': 'process.exit(0);\n' },
  });
  const { runtime } = createRuntime(projectRoot);
  const { composition, installed } = await installAndEnable(runtime, packageRoot);

  const capability = (await readCapabilitiesConfig(projectRoot))?.capabilities.find(
    (candidate) => candidate.type === 'mcp' && candidate.pluginId === installed.pluginId,
  );
  assert.ok(capability?.mcpServer, 'the declared MCP must be installed as a Host capability');
  assert.equal(capability.mcpServer.command, process.execPath);
  assert.match(capability.mcpServer.args?.[0] ?? '', /plugin-host\/resources/);

  await disable(composition, installed.pluginId);
  assert.equal(
    (await readCapabilitiesConfig(projectRoot))?.capabilities.some(
      (candidate) => candidate.type === 'mcp' && candidate.pluginId === installed.pluginId,
    ),
    false,
  );
});

test('declared MCP materialization preserves the verified runtime dependency closure', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-mcp-dependency-project-');
  const closureRoot = await tempRoot('cat-cafe-f202-mcp-dependency-closure-');
  const packageRoot = join(closureRoot, 'package');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(join(closureRoot, 'node_modules', 'fixture-dependency'), { recursive: true });
  await writeFile(
    join(closureRoot, 'node_modules', 'fixture-dependency', 'package.json'),
    '{"name":"fixture-dependency","type":"module","exports":"./index.js"}\n',
  );
  await writeFile(
    join(closureRoot, 'node_modules', 'fixture-dependency', 'index.js'),
    'export const dependencyValue = "dependency-loaded";\n',
  );
  await writeFile(
    join(packageRoot, 'dist/mcp.js'),
    "import { dependencyValue } from 'fixture-dependency'; process.stdout.write(dependencyValue + '\\n');\n",
  );
  const manifest = {
    pluginId: 'dev.clowder.mcp-dependency-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Dependency fixture',
    contributions: [
      {
        type: 'mcp',
        id: 'fixture-mcp',
        runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
      },
    ],
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        contributions: [{ type: 'mcp', id: 'fixture-mcp' }],
        capabilities: [],
      },
    ],
  };
  let config = { version: 1, capabilities: [] };
  let released = 0;
  const mcpConfigIO = {
    readConfig: async () => config,
    writeAndRegenCli: async (next) => {
      config = structuredClone(next);
    },
    withLock: async (operation) => operation(),
  };
  await activateDeclaredMcp(
    {
      packageRecord: {
        packageDigest: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
        pluginId: manifest.pluginId,
        version: manifest.version,
        contractVersion: manifest.contractVersion,
        manifest,
        signalSchemas: {},
        provenance: {
          kind: 'catalog',
          catalogId: 'mcp-dependency-fixture',
          packageName: '@clowder-ai/mcp-dependency-fixture',
        },
        packageState: 'installed',
        verifiedAt: 1,
        updatedAt: 1,
      },
      instance: {
        pluginInstanceId: 'pi_mcp_dependency_fixture',
        pluginId: manifest.pluginId,
        packageDigest: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'stopped',
        lifecycleRevision: 1,
        installedAt: 1,
        updatedAt: 1,
      },
      effectiveGrants: [],
    },
    {
      projectRoot,
      packages: { resolveInstalledPackage: async () => assert.fail('catalog MCP must use the materializer') },
      mcpPackages: {
        async resolve(input) {
          assert.equal(input.packageName, '@clowder-ai/mcp-dependency-fixture');
          assert.equal(input.sourceKind, 'catalog');
          return {
            rootDir: packageRoot,
            dependencyRoot: join(closureRoot, 'node_modules'),
            manifest,
            verifyIntegrity: async () => {},
            release: async () => {
              released += 1;
            },
          };
        },
      },
      configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
      mcpConfigIO,
    },
  );

  const capability = config.capabilities.find((candidate) => candidate.id.endsWith(':fixture-mcp'));
  assert.ok(capability?.mcpServer);
  const result = await execFileAsync(capability.mcpServer.command, capability.mcpServer.args, {
    cwd: capability.mcpServer.workingDir,
    env: capability.mcpServer.env,
  });
  assert.equal(result.stdout, 'dependency-loaded\n');
  assert.equal(released, 1);
});

test('local archive MCP materialization resolves its verified dependency closure from admitted package metadata', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-local-mcp-dependency-project-');
  const packageRoot = await tempRoot('cat-cafe-f202-local-mcp-dependency-package-');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'dist/mcp.js'), 'process.exit(0);\n');
  const manifest = {
    pluginId: 'dev.clowder.local-mcp-dependency-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Local dependency fixture',
    contributions: [
      {
        type: 'mcp',
        id: 'fixture-mcp',
        runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
      },
    ],
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        contributions: [{ type: 'mcp', id: 'fixture-mcp' }],
        capabilities: [],
      },
    ],
  };
  let config = { version: 1, capabilities: [] };
  let materializerCalls = 0;

  await activateDeclaredMcp(
    {
      packageRecord: {
        packageDigest: `sha512-${Buffer.alloc(64, 8).toString('base64')}`,
        pluginId: manifest.pluginId,
        version: manifest.version,
        contractVersion: manifest.contractVersion,
        manifest,
        signalSchemas: {},
        provenance: { kind: 'local-archive', packageName: '@clowder-ai/local-mcp-dependency-fixture' },
        packageState: 'installed',
        verifiedAt: 1,
        updatedAt: 1,
      },
      instance: {
        pluginInstanceId: 'pi_local_mcp_dependency_fixture',
        pluginId: manifest.pluginId,
        packageDigest: `sha512-${Buffer.alloc(64, 8).toString('base64')}`,
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'stopped',
        lifecycleRevision: 1,
        installedAt: 1,
        updatedAt: 1,
      },
      effectiveGrants: [],
    },
    {
      projectRoot,
      packages: { resolveInstalledPackage: async () => assert.fail('local MCP must use the materializer') },
      mcpPackages: {
        async resolve(input) {
          materializerCalls += 1;
          assert.equal(input.packageName, '@clowder-ai/local-mcp-dependency-fixture');
          assert.equal(input.sourceKind, 'local-archive');
          return {
            rootDir: packageRoot,
            manifest,
            verifyIntegrity: async () => {},
            release: async () => {},
          };
        },
      },
      configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
      mcpConfigIO: {
        readConfig: async () => config,
        writeAndRegenCli: async (next) => {
          config = structuredClone(next);
        },
        withLock: async (operation) => operation(),
      },
    },
  );

  assert.equal(materializerCalls, 1);
  assert.equal(config.capabilities[0].pluginId, manifest.pluginId);
});

test('a package without runtime uses the standard static skill and MCP lifecycle', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-static-mcp-project-');
  const mcpContributions = ['alpha', 'beta'].map((id) => ({
    type: 'mcp',
    id,
    runtime: { transport: 'stdio', entrypoint: `dist/${id}.js` },
  }));
  const skill = { type: 'skill', id: 'guide', path: 'skills/guide' };
  const contributions = [...mcpContributions, skill];
  const packageRoot = await writeFixturePackage({
    pluginId: 'dev.clowder.static-mcp-fixture',
    contribution: contributions[0],
    contributions,
    capabilities: ['thread.write', 'task.read', 'task.write'],
    omitRuntime: true,
    files: {
      'dist/alpha.js': 'process.exit(0);\n',
      'dist/beta.js': 'process.exit(0);\n',
      'skills/guide/SKILL.md': '# Static fixture guide\n',
    },
  });
  const { runtime } = createRuntime(projectRoot);
  const { composition, installed } = await installAndEnable(runtime, packageRoot);

  const installedCapabilities = (await readCapabilitiesConfig(projectRoot))?.capabilities.filter(
    (candidate) => candidate.type === 'mcp' && candidate.pluginId === installed.pluginId,
  );
  assert.deepEqual(
    installedCapabilities?.map((candidate) => candidate.id).sort(),
    mcpContributions.map((contribution) => `plugin:${installed.pluginId}:${contribution.id}`).sort(),
  );
  for (const capability of installedCapabilities ?? []) {
    assert.match(capability.mcpServer?.args?.[0] ?? '', /plugin-host\/resources/);
  }
  const cliConfig = JSON.parse(await readFile(join(projectRoot, '.test-cli', 'gemini.json'), 'utf8'));
  assert.equal(Object.keys(cliConfig.mcpServers ?? {}).length, 2);
  assert.equal(
    (await readCapabilitiesConfig(projectRoot))?.capabilities.some(
      (candidate) => candidate.type === 'skill' && candidate.pluginId === installed.pluginId,
    ),
    true,
  );

  await runtime.shutdown('host_shutdown');
  assert.equal(
    (await readCapabilitiesConfig(projectRoot))?.capabilities.filter(
      (candidate) => candidate.type === 'mcp' && candidate.pluginId === installed.pluginId,
    ).length,
    2,
  );
  await runtime.supervisor.start(installed.pluginInstanceId);

  await disable(composition, installed.pluginId);
  assert.equal(
    (await readCapabilitiesConfig(projectRoot))?.capabilities.some(
      (candidate) => candidate.type === 'mcp' && candidate.pluginId === installed.pluginId,
    ),
    false,
  );

  const beforeEnable = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: beforeEnable.lifecycleRevision,
  });
  const beforeUninstall = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.uninstall(installed.pluginId, { expectedRevision: beforeUninstall.lifecycleRevision });
  assert.equal(
    (await readCapabilitiesConfig(projectRoot))?.capabilities.some(
      (candidate) => candidate.type === 'mcp' && candidate.pluginId === installed.pluginId,
    ),
    false,
  );
});

test('an installed package wires declared limb handlers to its action table and unregisters on disable', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-limb-project-');
  const packageRoot = await writeFixturePackage({
    pluginId: 'dev.clowder.limb-fixture',
    contribution: { type: 'limb', id: 'fixture-limb', manifestPath: 'limbs/fixture.yml' },
    files: {
      'limbs/fixture.yml': [
        'nodeId: fixture-node',
        'displayName: Fixture node',
        'platform: fixture',
        'capabilities:',
        '  - cap: fixture.echo',
        '    authLevel: free',
        '    commands: [echo]',
        'commands:',
        '  echo:',
        '    type: invoke',
        '    description: Echo through the plugin action',
        '    params: {}',
        '    handler: fixture.echo',
        '',
      ].join('\n'),
    },
    actions: "{ 'fixture.echo': async (payload) => ({ success: true, data: payload }) }",
  });
  const limbRegistry = new LimbRegistry();
  const { runtime } = createRuntime(projectRoot, { limbRegistry });
  const { composition, installed } = await installAndEnable(runtime, packageRoot);

  assert.ok(limbRegistry.getNode('fixture-node'));
  const invocation = {
    catId: 'cat-fixture',
    invocationId: 'inv-fixture',
    userId: 'user-fixture',
    threadId: 'thread-fixture',
    userMessageId: 'message-fixture',
  };
  assert.deepEqual(await limbRegistry.invoke('fixture-node', 'echo', { value: 'hello' }, invocation), {
    success: true,
    data: { params: { value: 'hello' }, invocation },
  });
  assert.deepEqual(await limbRegistry.invoke('fixture-node', 'echo', { value: 'without-invocation' }), {
    success: true,
    data: { params: { value: 'without-invocation' } },
  });

  await disable(composition, installed.pluginId);
  assert.equal(limbRegistry.getNode('fixture-node'), undefined);
});

test('an installed package schedules its declared action and unregisters on disable', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-schedule-project-');
  const marker = `__f202Schedule_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const packageRoot = await writeFixturePackage({
    pluginId: 'dev.clowder.schedule-fixture',
    contribution: {
      type: 'schedule',
      id: 'fixture-schedule',
      schedule: { kind: 'interval', everyMs: 60_000 },
      action: { method: 'fixture.tick', params: { source: 'schedule' } },
      policy: { overlap: 'skip', timeoutMs: 5_000 },
    },
    capabilities: ['schedule.register'],
    actions: `{ 'fixture.tick': async (params) => { globalThis['${marker}'] = params; return { ok: true }; } }`,
  });
  const taskRunner = fakeTaskRunner();
  const { runtime } = createRuntime(projectRoot, { taskRunner });
  const { composition, installed } = await installAndEnable(runtime, packageRoot, () => ['schedule.register']);

  const [task] = [...taskRunner.tasks.values()];
  assert.ok(task, 'the declared schedule must be registered with TaskRunnerV2');
  const gated = await task.admission.gate({ taskId: task.id, lastRunAt: null, tickCount: 1 });
  assert.equal(gated.run, true);
  await task.run.execute(gated.workItems[0].signal, gated.workItems[0].subjectKey, {
    signal: AbortSignal.timeout(5_000),
    assignedCatId: null,
  });
  assert.deepEqual(globalThis[marker], { source: 'schedule' });
  delete globalThis[marker];

  await disable(composition, installed.pluginId);
  assert.equal(taskRunner.tasks.size, 0);
});

test('a declared schedule without schedule.register fails activation and rolls back static resources', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-schedule-grant-project-');
  const mcp = {
    type: 'mcp',
    id: 'schedule-grant-mcp',
    runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
  };
  const schedule = {
    type: 'schedule',
    id: 'schedule-grant-denied',
    schedule: { kind: 'interval', everyMs: 60_000 },
    action: { method: 'fixture.tick' },
    policy: { overlap: 'skip', timeoutMs: 5_000 },
  };
  const packageRoot = await writeFixturePackage({
    pluginId: 'dev.clowder.schedule-grant-fixture',
    contribution: schedule,
    contributions: [mcp, schedule],
    capabilities: ['schedule.register'],
    files: { 'dist/mcp.js': 'process.exit(0);\n' },
    actions: "{ 'fixture.tick': async () => ({ ok: true }) }",
  });
  const taskRunner = fakeTaskRunner();
  const { runtime } = createRuntime(projectRoot, { taskRunner });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  });
  const installed = await composition.manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  const beforeEnable = (await composition.manager.get(installed.pluginId)).plugin;

  await assert.rejects(
    composition.manager.setEnabled(installed.pluginId, {
      enabled: true,
      expectedRevision: beforeEnable.lifecycleRevision,
    }),
    /runtime failed to start/,
  );
  assert.equal(taskRunner.tasks.size, 0);
  assert.equal(
    (await readCapabilitiesConfig(projectRoot))?.capabilities.some(
      (candidate) => candidate.pluginId === installed.pluginId,
    ),
    false,
  );
});

test('an installed package exposes declared cat tools through the shared contribution entrypoint', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-tool-project-');
  const tool = {
    type: 'tool',
    id: 'fixture-toolset',
    name: 'fixture_echo',
    description: 'Echo through the installed package action table',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' }, channel: { type: 'string' } },
      required: ['value'],
    },
    action: { method: 'fixture.tool', params: { channel: 'manifest' } },
  };
  const packageRoot = await writeFixturePackage({
    pluginId: 'dev.clowder.tool-fixture',
    contribution: tool,
    actions: "{ 'fixture.tool': async (params) => ({ echoed: params.value, channel: params.channel }) }",
  });
  const { runtime } = createRuntime(projectRoot);
  const { composition, installed } = await installAndEnable(runtime, packageRoot);

  assert.deepEqual(await runtime.supervisor.listPluginTools(installed.pluginId), [
    {
      contributionId: 'fixture-toolset',
      name: 'fixture_echo',
      description: 'Echo through the installed package action table',
      inputSchema: tool.inputSchema,
    },
  ]);
  assert.deepEqual(
    await runtime.supervisor.callPluginTool(installed.pluginId, 'fixture-toolset', 'fixture_echo', {
      value: 'hello',
      channel: 'caller',
    }),
    { echoed: 'hello', channel: 'manifest' },
  );

  await disable(composition, installed.pluginId);
  await assert.rejects(runtime.supervisor.listPluginTools(installed.pluginId), /is not active/);
  await assert.rejects(
    runtime.supervisor.callPluginTool(installed.pluginId, 'fixture-toolset', 'fixture_echo', { value: 'late' }),
    /is not active/,
  );
});

test('a runtime-contribution startup failure rolls back static and live registrations', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-contribution-rollback-project-');
  const mcp = {
    type: 'mcp',
    id: 'rollback-mcp',
    runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
  };
  const limb = { type: 'limb', id: 'rollback-limb', manifestPath: 'limbs/rollback.yml' };
  const schedule = {
    type: 'schedule',
    id: 'rollback-schedule',
    schedule: { kind: 'interval', everyMs: 60_000 },
    action: { method: 'fixture.tick' },
    policy: { overlap: 'skip', timeoutMs: 5_000 },
  };
  const tool = {
    type: 'tool',
    id: 'rollback-toolset',
    name: 'rollback_tool',
    inputSchema: { type: 'object' },
    action: { method: 'fixture.tool' },
  };
  const packageRoot = await writeFixturePackage({
    pluginId: 'dev.clowder.contribution-rollback-fixture',
    contribution: mcp,
    contributions: [mcp, limb, tool, schedule],
    capabilities: ['schedule.register'],
    files: {
      'dist/mcp.js': 'process.exit(0);\n',
      'limbs/rollback.yml': [
        'nodeId: rollback-node',
        'displayName: Rollback node',
        'platform: fixture',
        'capabilities:',
        '  - cap: fixture.echo',
        '    authLevel: free',
        '    commands: [echo]',
        'commands:',
        '  echo:',
        '    type: invoke',
        '    description: rollback fixture',
        '    params: {}',
        '    handler: fixture.echo',
        '',
      ].join('\n'),
    },
    actions:
      "{ 'fixture.echo': async () => ({ success: true }), 'fixture.tool': async () => ({ ok: true }), 'fixture.tick': async () => ({ ok: true }) }",
  });
  const limbRegistry = new LimbRegistry();
  const taskRunner = {
    tasks: new Map(),
    registerPostStart() {
      throw new Error('injected schedule registration failure');
    },
    unregister() {
      return false;
    },
  };
  const { runtime } = createRuntime(projectRoot, { limbRegistry, taskRunner });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy: () => ['schedule.register'],
  });
  const installed = await composition.manager.install({ source: { kind: 'local-directory', path: packageRoot } });
  const beforeEnable = (await composition.manager.get(installed.pluginId)).plugin;

  await assert.rejects(
    composition.manager.setEnabled(installed.pluginId, {
      enabled: true,
      expectedRevision: beforeEnable.lifecycleRevision,
    }),
    /runtime failed to start/,
  );
  assert.equal(limbRegistry.getNode('rollback-node'), undefined);
  assert.equal(
    Boolean(
      (await readCapabilitiesConfig(projectRoot))?.capabilities.some(
        (candidate) => candidate.pluginId === installed.pluginId,
      ),
    ),
    false,
  );
  await assert.rejects(runtime.supervisor.listPluginTools(installed.pluginId), /is not active/);
});

test('Host shutdown removes live registrations but preserves declared MCP state', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-contribution-shutdown-project-');
  const mcp = {
    type: 'mcp',
    id: 'shutdown-mcp',
    runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
  };
  const limb = { type: 'limb', id: 'shutdown-limb', manifestPath: 'limbs/shutdown.yml' };
  const schedule = {
    type: 'schedule',
    id: 'shutdown-schedule',
    schedule: { kind: 'interval', everyMs: 60_000 },
    action: { method: 'fixture.tick' },
    policy: { overlap: 'skip', timeoutMs: 5_000 },
  };
  const tool = {
    type: 'tool',
    id: 'shutdown-toolset',
    name: 'shutdown_tool',
    inputSchema: { type: 'object' },
    action: { method: 'fixture.tool' },
  };
  const packageRoot = await writeFixturePackage({
    pluginId: 'dev.clowder.contribution-shutdown-fixture',
    contribution: mcp,
    contributions: [mcp, limb, tool, schedule],
    capabilities: ['schedule.register'],
    files: {
      'dist/mcp.js': 'process.exit(0);\n',
      'limbs/shutdown.yml': [
        'nodeId: shutdown-node',
        'displayName: Shutdown node',
        'platform: fixture',
        'capabilities:',
        '  - cap: fixture.echo',
        '    authLevel: free',
        '    commands: [echo]',
        'commands:',
        '  echo:',
        '    type: invoke',
        '    description: shutdown fixture',
        '    params: {}',
        '    handler: fixture.echo',
        '',
      ].join('\n'),
    },
    actions:
      "{ 'fixture.echo': async () => ({ success: true }), 'fixture.tool': async () => ({ ok: true }), 'fixture.tick': async () => ({ ok: true }) }",
  });
  const limbRegistry = new LimbRegistry();
  const taskRunner = fakeTaskRunner();
  const { runtime } = createRuntime(projectRoot, { limbRegistry, taskRunner });
  const { composition, installed } = await installAndEnable(runtime, packageRoot, () => ['schedule.register']);
  const beforeShutdown = (await readCapabilitiesConfig(projectRoot))?.capabilities.find(
    (candidate) => candidate.type === 'mcp' && candidate.pluginId === installed.pluginId,
  );
  const entrypoint = beforeShutdown?.mcpServer?.args?.[0];
  assert.ok(entrypoint, 'the declared MCP must exist before shutdown');
  assert.equal((await runtime.supervisor.listPluginTools(installed.pluginId)).length, 1);

  await runtime.shutdown('host_shutdown');

  assert.equal(limbRegistry.getNode('shutdown-node'), undefined);
  assert.equal(taskRunner.tasks.size, 0);
  await assert.rejects(runtime.supervisor.listPluginTools(installed.pluginId), /is not active/);
  const afterShutdown = (await readCapabilitiesConfig(projectRoot))?.capabilities.find(
    (candidate) => candidate.type === 'mcp' && candidate.pluginId === installed.pluginId,
  );
  assert.equal(afterShutdown?.mcpServer?.args?.[0], entrypoint);
  assert.equal((await stat(entrypoint)).isFile(), true);

  await runtime.supervisor.start(installed.pluginInstanceId);
  assert.ok(limbRegistry.getNode('shutdown-node'));
  assert.equal(taskRunner.tasks.size, 1);
  assert.equal((await runtime.supervisor.listPluginTools(installed.pluginId)).length, 1);
  const afterRestart = (await readCapabilitiesConfig(projectRoot))?.capabilities.find(
    (candidate) => candidate.type === 'mcp' && candidate.pluginId === installed.pluginId,
  );
  assert.equal(afterRestart?.mcpServer?.args?.[0], entrypoint);

  await disable(composition, installed.pluginId);
  assert.equal(
    (await readCapabilitiesConfig(projectRoot))?.capabilities.some(
      (candidate) => candidate.type === 'mcp' && candidate.pluginId === installed.pluginId,
    ),
    false,
  );
});
