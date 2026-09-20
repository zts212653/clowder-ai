import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BuiltinPluginContributionSupervisor,
  ExternalPluginLifecycleService,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
} from '../dist/domains/plugin/index.js';

const digest = `sha512-${Buffer.alloc(64, 4).toString('base64')}`;

function exactManifest(overrides = {}) {
  return {
    pluginId: 'dev.clowder.video-analysis',
    version: '0.1.0-alpha.0',
    contractVersion: '0.1.0-beta.13',
    name: 'Video Analysis',
    configuration: [
      { key: 'provider', label: 'Provider', kind: 'select', required: true },
      { key: 'apiKey', label: 'API key', kind: 'secret', required: true },
      { key: 'baseUrl', label: 'Base URL', kind: 'url', required: false },
    ],
    contributions: [
      {
        type: 'mcp',
        id: 'video-analysis-toolset',
        runtime: { transport: 'stdio', entrypoint: 'dist/mcp-entrypoint.js' },
        environment: {
          VIDEO_ANALYSIS_PROVIDER: { source: 'config', key: 'provider' },
          VIDEO_ANALYSIS_API_KEY: { source: 'secret', key: 'apiKey' },
          VIDEO_ANALYSIS_BASE_URL: { source: 'config', key: 'baseUrl' },
        },
      },
    ],
    features: [
      {
        id: 'analyze-video',
        name: 'Analyze video',
        resources: [],
        contributions: [{ type: 'mcp', id: 'video-analysis-toolset' }],
        capabilities: ['plugin.config.read', 'secret.read'],
      },
    ],
    runtime: { transport: 'builtin' },
    ...overrides,
  };
}

function contract() {
  return {
    manifestContractVersions: ['0.1.0-beta.13'],
    validateManifest: (value) => ({ valid: true, manifest: value, errors: [] }),
    validateEffectiveGrants: (values) =>
      new Set(values).size === values.length &&
      values.every((value) => value === 'plugin.config.read' || value === 'secret.read'),
  };
}

async function harness({
  manifest = exactManifest(),
  config = {},
  secrets = {},
  inventoryStore,
  effectiveGrants = ['plugin.config.read', 'secret.read'],
  realRuntime = false,
  entrypointSource = '// fixture\n',
  closeError,
  closeRuntime,
} = {}) {
  const exactContract = contract();
  const store = new MemoryPluginInventoryStore(undefined, { contract: exactContract });
  const inventory = new HostInventoryControlPlane(store, {
    contract: exactContract,
    createInstanceId: () => 'pi_video',
    now: () => 1_000,
  });
  await inventory.installPackage({
    manifest,
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
    packagePluginId: manifest.pluginId,
    effectiveGrants,
  });
  await store.transaction((transaction) => {
    const instance = transaction.instances.get('pi_video');
    transaction.instances.put({
      ...instance,
      configReadiness: 'ready',
      activationState: 'enabled',
    });
  });
  const rootDir = await mkdtemp(join(tmpdir(), 'f202-builtin-contribution-'));
  await mkdir(join(rootDir, 'dist'));
  await writeFile(join(rootDir, 'dist/mcp-entrypoint.js'), entrypointSource);
  let releases = 0;
  const launches = [];
  let closes = 0;
  const supervisor = new BuiltinPluginContributionSupervisor({
    inventory: inventoryStore?.(store) ?? store,
    materializer: {
      resolve: async () => ({
        rootDir,
        verifyIntegrity: async () => {},
        release: async () => {
          releases += 1;
        },
      }),
    },
    configuration: {
      readConfig: async (_instanceId, key) => config[key],
      readSecret: async (_instanceId, key) => secrets[key],
    },
    ...(realRuntime
      ? {}
      : {
          runtime: {
            start: async (spec) => {
              launches.push(structuredClone(spec));
              return {
                tools: [
                  {
                    name: 'video_analysis',
                    description: 'Analyze a remote video.',
                    inputSchema: {
                      type: 'object',
                      properties: { videoUrl: { type: 'string' } },
                      required: ['videoUrl'],
                    },
                  },
                ],
                callTool: async (name, args) => ({
                  content: [{ type: 'text', text: JSON.stringify({ name, args }) }],
                }),
                close: async () => {
                  closes += 1;
                  if (closeRuntime) await closeRuntime(closes);
                  if (closeError) throw closeError;
                },
              };
            },
          },
        }),
    now: () => 2_000,
  });
  return {
    rootDir: await realpath(rootDir),
    inventory,
    store,
    supervisor,
    launches,
    closes: () => closes,
    releases: () => releases,
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition was not satisfied before timeout');
}

test('activates a typed MCP contribution with Host config/secret bindings and revokes it on stop', async () => {
  const h = await harness({
    config: { provider: 'gemini', baseUrl: 'http://127.0.0.1:12345' },
    secrets: { apiKey: 'isolated-secret' },
  });

  await h.supervisor.start('pi_video');

  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.launches[0], {
    pluginInstanceId: 'pi_video',
    pluginId: 'dev.clowder.video-analysis',
    contributionId: 'video-analysis-toolset',
    command: process.execPath,
    args: [join(h.rootDir, 'dist/mcp-entrypoint.js')],
    cwd: h.rootDir,
    env: {
      VIDEO_ANALYSIS_PROVIDER: 'gemini',
      VIDEO_ANALYSIS_API_KEY: 'isolated-secret',
      VIDEO_ANALYSIS_BASE_URL: 'http://127.0.0.1:12345',
    },
  });
  assert.equal((await h.store.snapshot()).instances[0].runtimeState, 'healthy');
  assert.equal(JSON.stringify(await h.store.snapshot()).includes('isolated-secret'), false);
  assert.deepEqual(await h.supervisor.listPluginTools('dev.clowder.video-analysis'), [
    {
      contributionId: 'video-analysis-toolset',
      name: 'video_analysis',
      description: 'Analyze a remote video.',
      inputSchema: {
        type: 'object',
        properties: { videoUrl: { type: 'string' } },
        required: ['videoUrl'],
      },
    },
  ]);
  assert.deepEqual(
    await h.supervisor.callPluginTool('dev.clowder.video-analysis', 'video-analysis-toolset', 'video_analysis', {
      videoUrl: 'https://media.example/video.mp4',
      prompt: 'summarize',
    }),
    {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            name: 'video_analysis',
            args: { videoUrl: 'https://media.example/video.mp4', prompt: 'summarize' },
          }),
        },
      ],
    },
  );

  await h.supervisor.stop('pi_video', 'owner_disabled');

  assert.equal(h.closes(), 1);
  assert.equal(h.releases(), 1);
  assert.equal((await h.store.snapshot()).instances[0].runtimeState, 'stopped');
  await assert.rejects(h.supervisor.listPluginTools('dev.clowder.video-analysis'), /is not active/);
});

test('rechecks the grant fence before every tool call and tears down stale authority', async () => {
  const h = await harness({
    config: { provider: 'gemini' },
    secrets: { apiKey: 'isolated-secret' },
  });
  await h.supervisor.start('pi_video');
  await h.inventory.revokeGrant({
    pluginInstanceId: 'pi_video',
    capability: 'secret.read',
    expectedGrantRevision: 1,
  });

  await assert.rejects(
    h.supervisor.callPluginTool('dev.clowder.video-analysis', 'video-analysis-toolset', 'video_analysis', {}),
    /lost live contribution authority/,
  );

  assert.equal(h.closes(), 1);
  assert.equal((await h.store.snapshot()).instances[0].runtimeState, 'stopped');
});

test('missing required secret fails before capability publication and leaves runtime stopped', async () => {
  const h = await harness({ config: { provider: 'gemini' } });

  await assert.rejects(h.supervisor.start('pi_video'), /required secret apiKey is unavailable/);

  assert.deepEqual(h.launches, []);
  assert.equal(h.releases(), 1);
  assert.equal((await h.store.snapshot()).instances[0].runtimeState, 'stopped');
});

test('a failed normal close withdraws capability liveness and projects a crash', async () => {
  const h = await harness({
    config: { provider: 'gemini' },
    secrets: { apiKey: 'isolated-secret' },
    closeError: new Error('fixture close failed'),
  });
  await h.supervisor.start('pi_video');

  await assert.rejects(h.supervisor.stop('pi_video'), /failed to stop/);

  const instance = (await h.store.snapshot()).instances[0];
  assert.equal(instance.activationState, 'error');
  assert.equal(instance.runtimeState, 'crashed');
  assert.deepEqual(h.supervisor.activeContributionIds('pi_video'), []);
  assert.equal(h.releases(), 0, 'failed cleanup must retain the materialized runtime for retry');
});

test('retains cleanup custody after a failed close so lifecycle retry can stop before retiring', async () => {
  let running = true;
  const h = await harness({
    config: { provider: 'gemini' },
    secrets: { apiKey: 'isolated-secret' },
    closeRuntime: async (attempt) => {
      if (attempt === 1) throw new Error('fixture close failed');
      running = false;
    },
  });
  await h.supervisor.start('pi_video');

  await assert.rejects(h.supervisor.stop('pi_video'), /failed to stop/);

  assert.equal(running, true);
  assert.equal(h.releases(), 0, 'materialization remains owned while the process may still be alive');
  assert.deepEqual(h.supervisor.activeContributionIds('pi_video'), []);

  const failed = (await h.store.snapshot()).instances[0];
  const lifecycle = new ExternalPluginLifecycleService({ store: h.store, supervisor: h.supervisor });
  const retired = await lifecycle.uninstall('pi_video', failed.lifecycleRevision);

  assert.equal(running, false);
  assert.equal(h.closes(), 2, 'lifecycle retry must invoke the retained cleanup handle');
  assert.equal(h.releases(), 1);
  assert.equal(retired.lifecycleState, 'retired');
});

test('uses typed manifest defaults for the same effective config accepted by readiness', async () => {
  const h = await harness({
    effectiveGrants: ['plugin.config.read'],
    manifest: exactManifest({
      configuration: [
        { key: 'model', label: 'Model', kind: 'string', required: true, default: 'default-model' },
        { key: 'retries', label: 'Retries', kind: 'number', required: true, default: 3 },
        { key: 'stream', label: 'Stream', kind: 'boolean', required: true, default: false },
      ],
      contributions: [
        {
          type: 'mcp',
          id: 'video-analysis-toolset',
          runtime: { transport: 'stdio', entrypoint: 'dist/mcp-entrypoint.js' },
          environment: {
            MODEL: { source: 'config', key: 'model' },
            RETRIES: { source: 'config', key: 'retries' },
            STREAM: { source: 'config', key: 'stream' },
          },
        },
      ],
      features: [
        {
          id: 'analyze-video',
          name: 'Analyze video',
          resources: [],
          contributions: [{ type: 'mcp', id: 'video-analysis-toolset' }],
          capabilities: ['plugin.config.read'],
        },
      ],
    }),
  });

  await h.supervisor.start('pi_video');

  assert.deepEqual(h.launches[0].env, { MODEL: 'default-model', RETRIES: '3', STREAM: 'false' });
});

test('withdraws tools and projects a diagnostic when the real MCP child exits', async () => {
  const entrypointSource = `
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'exit-fixture', version: '1.0.0' }
    }});
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
      name: 'video_analysis', inputSchema: { type: 'object' }
    }] }});
  } else if (message.method === 'tools/call') {
    process.exit(17);
  }
});
`;
  const h = await harness({
    realRuntime: true,
    entrypointSource,
    config: { provider: 'gemini' },
    secrets: { apiKey: 'isolated-secret' },
  });
  await h.supervisor.start('pi_video');

  await assert.rejects(
    h.supervisor.callPluginTool('dev.clowder.video-analysis', 'video-analysis-toolset', 'video_analysis', {}),
  );
  await waitFor(async () => (await h.store.snapshot()).instances[0].runtimeState === 'crashed');

  const instance = (await h.store.snapshot()).instances[0];
  assert.equal(instance.activationState, 'error');
  assert.equal(instance.lastRuntimeError.code, 'UNEXPECTED_RUNTIME_FAILURE');
  assert.deepEqual(h.supervisor.activeContributionIds('pi_video'), []);
  await assert.rejects(h.supervisor.listPluginTools('dev.clowder.video-analysis'), /is not active/);
  assert.equal(h.releases(), 1);
});

test('uninstall joins in-flight cleanup after one of two real MCP children exits', async () => {
  const entrypointSource = `
const fs = require('node:fs');
const readline = require('node:readline');
const role = process.argv[2];
fs.writeFileSync(role + '.pid', String(process.pid));
const keepAlive = setInterval(() => {}, 1_000);
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: role, version: '1.0.0' }
    }});
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
      name: role + '_tool', inputSchema: { type: 'object' }
    }] }});
  } else if (message.method === 'tools/call' && role === 'crash') {
    process.exit(17);
  }
});
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 200));
setTimeout(() => { clearInterval(keepAlive); process.exit(0); }, 8_000).unref();
`;
  const contributions = ['crash', 'stubborn'].map((role) => ({
    type: 'mcp',
    id: `${role}-toolset`,
    runtime: { transport: 'stdio', entrypoint: 'dist/mcp-entrypoint.js', args: [role] },
    environment: {},
  }));
  const h = await harness({
    realRuntime: true,
    entrypointSource,
    manifest: exactManifest({
      configuration: [],
      contributions,
      features: contributions.map((contribution) => ({
        id: contribution.id,
        name: contribution.id,
        resources: [],
        contributions: [{ type: 'mcp', id: contribution.id }],
        capabilities: [],
      })),
    }),
    effectiveGrants: [],
  });
  const pidPath = join(h.rootDir, 'stubborn.pid');
  let stubbornPid;
  try {
    await h.supervisor.start('pi_video');
    stubbornPid = Number(await readFile(pidPath, 'utf8'));

    await assert.rejects(h.supervisor.callPluginTool('dev.clowder.video-analysis', 'crash-toolset', 'crash_tool', {}));
    await waitFor(() => h.supervisor.activeContributionIds('pi_video').length === 0);

    const beforeUninstall = (await h.store.snapshot()).instances[0];
    let uninstallSettled = false;
    const lifecycle = new ExternalPluginLifecycleService({ store: h.store, supervisor: h.supervisor });
    const uninstall = lifecycle.uninstall('pi_video', beforeUninstall.lifecycleRevision).then((result) => {
      uninstallSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(uninstallSettled, false, 'retirement must wait for the surviving child cleanup');
    assert.doesNotThrow(() => process.kill(stubbornPid, 0));

    const retired = await uninstall;
    await waitFor(() => {
      try {
        process.kill(stubbornPid, 0);
        return false;
      } catch (error) {
        return error?.code === 'ESRCH';
      }
    });
    assert.equal(retired.lifecycleState, 'retired');
    assert.equal(h.releases(), 1);
  } finally {
    if (Number.isInteger(stubbornPid)) {
      try {
        process.kill(stubbornPid, 'SIGKILL');
      } catch {}
    }
  }
});

test('rejects a contribution entrypoint that resolves outside its materialized package', async () => {
  const h = await harness({
    manifest: exactManifest({
      contributions: [
        {
          type: 'mcp',
          id: 'video-analysis-toolset',
          runtime: { transport: 'stdio', entrypoint: '../escape.js' },
          environment: {},
        },
      ],
    }),
    config: { provider: 'gemini' },
    secrets: { apiKey: 'isolated-secret' },
  });

  await assert.rejects(h.supervisor.start('pi_video'), /entrypoint must resolve inside/);

  assert.deepEqual(h.launches, []);
  assert.equal((await h.store.snapshot()).instances[0].runtimeState, 'stopped');
});

test('clears the active execution when the final healthy projection fails', async () => {
  let transactions = 0;
  const h = await harness({
    config: { provider: 'gemini' },
    secrets: { apiKey: 'isolated-secret' },
    inventoryStore: (store) => ({
      snapshot: () => store.snapshot(),
      transaction: (operation) => {
        transactions += 1;
        if (transactions === 2) throw new Error('fixture healthy projection failure');
        return store.transaction(operation);
      },
    }),
  });

  await assert.rejects(h.supervisor.start('pi_video'), /failed to start/);

  assert.equal(h.launches.length, 1, 'healthy projection must fail only after the runtime started');
  assert.deepEqual(h.supervisor.activeContributionIds('pi_video'), []);
  assert.equal(h.closes(), 1);
  assert.equal(h.releases(), 1);
  assert.equal((await h.store.snapshot()).instances[0].runtimeState, 'stopped');
});

test('retains startup cleanup custody when final projection and first close both fail', async () => {
  let transactions = 0;
  const h = await harness({
    config: { provider: 'gemini' },
    secrets: { apiKey: 'isolated-secret' },
    inventoryStore: (store) => ({
      snapshot: () => store.snapshot(),
      transaction: (operation) => {
        transactions += 1;
        if (transactions === 2) throw new Error('fixture healthy projection failure');
        return store.transaction(operation);
      },
    }),
    closeRuntime: async (attempt) => {
      if (attempt === 1) throw new Error('fixture startup cleanup failed');
    },
  });

  await assert.rejects(h.supervisor.start('pi_video'), /failed to start/);

  assert.deepEqual(h.supervisor.activeContributionIds('pi_video'), []);
  assert.equal(h.releases(), 0);
  await h.supervisor.stop('pi_video', 'retry_failed_start_cleanup');
  assert.equal(h.closes(), 2);
  assert.equal(h.releases(), 1);
});
