import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { resolveConfiguredMemberMcpFamilies } from '../dist/config/capabilities/member-mcp-families.js';
import { reconcileCatRegistry } from '../dist/config/cat-registry-reconciliation.js';
import { prepareSharedMcpLaunch } from '../dist/domains/cats/services/agents/invocation/shared-mcp-launch.js';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpProcessPool } from '../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js';
import { materializeIcodeSessionMcpServers } from '../dist/domains/cats/services/agents/providers/acp/acp-session-env.js';
import {
  generateOpenCodeRuntimeConfig,
  summarizeOpenCodeRuntimeConfigForDebug,
} from '../dist/domains/cats/services/agents/providers/opencode-config-template.js';
import { resolveCatCafeDataRoot } from '../dist/utils/cli-process-ownership.js';
import { buildChildEnv } from '../dist/utils/cli-spawn.js';
import './helpers/setup-cat-registry.js';

const families = ['collab', 'memory', 'signals', 'limb', 'audio', 'finance'];

test('a failed ACP turn close preserves the completed turn and releases its lease and capacity listener', async () => {
  let released = 0;
  let detached = 0;
  const client = {
    async newSession() {
      return { sessionId: 'fixture-close-session' };
    },
    async setSessionConfigOption() {},
    async *promptStream(sessionId) {
      yield { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } };
    },
    onCapacity() {},
    offCapacity() {
      detached++;
    },
    clearRecentCapacitySignal() {},
    recentCapacitySignal: null,
  };
  const service = new AcpAgentService({
    catId: 'kimi',
    pool: {
      async acquire(poolKey) {
        return {
          client,
          poolKey,
          release() {
            released++;
          },
          async closeTurn() {
            throw new Error('fixture-close-failed');
          },
        };
      },
      rememberSession() {},
    },
    poolKey: { projectPath: '/tmp', providerProfile: 'fixture' },
    projectRoot: '/tmp',
    providerName: 'kimi',
    modelName: 'fixture',
    mcpServers: [],
    mcpSupport: false,
  });
  await assert.doesNotReject(async () => {
    for await (const _event of service.invoke('fixture', {
      callbackEnv: {
        CAT_CAFE_MCP_TRANSPORT: 'shared',
        CAT_CAFE_CREDENTIAL_FILE: '/fixture/turn.json',
      },
    })) {
      /* drain the real service cleanup */
    }
  });
  assert.equal(released, 1, 'close failure cannot strand a pool lease');
  assert.equal(detached, 1, 'close failure cannot retain the capacity listener');
});

test('a declared but unavailable capability source cannot grant every shared family', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-unavailable-capability-'));
  const saved = process.env.CAT_CAFE_CONFIG_ROOT;
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  try {
    await assert.rejects(resolveConfiguredMemberMcpFamilies(root, 'codex'), /capabilities source/i);
  } finally {
    if (saved === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared roots use the existing Host data-root resolver, including its home-relative configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-data-root-'));
  const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_DATA_DIR', 'CAT_CAFE_MCP_TRANSPORT'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  process.env.CAT_CAFE_DATA_DIR = '~/.f333-fixture';
  process.env.CAT_CAFE_MCP_TRANSPORT = 'shared';
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(join(root, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }));
  try {
    const context = await prepareSharedMcpLaunch({
      catId: 'codex',
      apiUrl: 'http://127.0.0.1:3102',
      workingDirectory: root,
    });
    assert.equal(context.dataDir, resolveCatCafeDataRoot());
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP-only OpenCode projection preserves existing provider routing, aliases and omitted auth', () => {
  const config = generateOpenCodeRuntimeConfig({
    providerName: 'openai',
    models: ['gpt-6.1-sol'],
    modelAliases: { 'gpt-6.1-sol': 'fixture-upstream' },
    defaultModel: 'openai/gpt-6.1-sol',
    omitProviderAuth: true,
    mcpOnly: true,
  });
  assert.deepEqual(config.provider['openai-compat'].models['gpt-6.1-sol'], {
    id: 'fixture-upstream',
    name: 'gpt-6.1-sol',
  });
  assert.deepEqual(config.provider['openai-compat'].options, {});
  assert.equal(config.model, 'openai-compat/gpt-6.1-sol');
});

test('the existing iCode HTTP overlay keeps shared principals in the scoped gateway', () => {
  const base = [
    { name: 'cat-cafe-memory', command: process.execPath, args: [resolve('../mcp-server/dist/memory.js')], env: [] },
  ];
  const callback = {
    CAT_CAFE_API_URL: 'http://127.0.0.1:3102',
    CAT_CAFE_INVOCATION_ID: 'fixture-A',
    CAT_CAFE_CALLBACK_TOKEN: 'fixture-token-A',
    CAT_CAFE_MCP_TRANSPORT: 'shared',
  };
  const foreign = materializeIcodeSessionMcpServers(
    [{ name: 'cat-cafe-memory', command: 'foreign', args: [], env: [] }],
    callback,
  );
  assert.deepEqual(foreign.gatewayRouted, []);
  assert.deepEqual(foreign.droppedStdio, ['cat-cafe-memory']);
  const { servers } = materializeIcodeSessionMcpServers(base, callback);
  assert.equal(new URL(servers[0].url).searchParams.get('shared'), '1');
  assert.ok(servers[0].headers.some((header) => header.name === 'x-mcp-connection-id' && header.value));
  const rollback = materializeIcodeSessionMcpServers(base, { ...callback, CAT_CAFE_MCP_TRANSPORT: 'stdio' });
  assert.equal(new URL(rollback.servers[0].url).searchParams.get('shared'), '1');
  const { CAT_CAFE_MCP_TRANSPORT: _transport, ...legacyCallback } = callback;
  const legacy = materializeIcodeSessionMcpServers(base, legacyCallback);
  assert.equal(new URL(legacy.servers[0].url).searchParams.has('shared'), false);
});

test('provider diagnostics cannot resolve MCP without the launch member and abort an already prepared OpenCode run', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-opencode-diagnostic-'));
  const saved = process.env.CAT_CAFE_CONFIG_ROOT;
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  try {
    const summary = summarizeOpenCodeRuntimeConfigForDebug({
      providerName: 'zhipu',
      models: ['glm-5.2'],
      mcpServerPath: resolve('../mcp-server/dist/index.js'),
    });
    assert.deepEqual(summary.providerKeys, ['zhipu']);
  } finally {
    if (saved === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared families consume canonical enabled sets, ACP auto-discovery and current switches without bootstrapping a catalog', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-families-'));
  const savedTemplate = process.env.CAT_TEMPLATE_PATH;
  const savedMembers = catRegistry.getAllConfigs();
  try {
    mkdirSync(join(root, '.cat-cafe'));
    copyFileSync(resolve('../../cat-template.json'), join(root, 'cat-template.json'));
    process.env.CAT_TEMPLATE_PATH = join(root, 'cat-template.json');
    const capabilities = {
      version: 1,
      capabilities: families.map((family) => ({
        id: `cat-cafe-${family}`,
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: process.execPath, args: [resolve(`../mcp-server/dist/${family}.js`)] },
      })),
    };
    const capabilityPath = join(root, '.cat-cafe/capabilities.json');
    writeFileSync(capabilityPath, JSON.stringify(capabilities));
    assert.deepEqual(await resolveConfiguredMemberMcpFamilies(root, 'codex'), families);
    assert.equal(
      existsSync(join(root, '.cat-cafe/cat-catalog.json')),
      false,
      'authorization reads do not create a second member owner',
    );
    const catalog = JSON.parse(readFileSync(join(root, 'cat-template.json'), 'utf8'));
    const variant = catalog.breeds.find((breed) => breed.catId === 'codex').variants[0];
    variant.clientId = 'acp';
    variant.carrier = 'acp';
    variant.acp = { command: 'fixture-acp', mcpWhitelist: [] };
    writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(catalog));
    reconcileCatRegistry(root, new Set(catRegistry.getAllIds()));
    assert.deepEqual(
      await resolveConfiguredMemberMcpFamilies(root, 'codex'),
      families,
      'empty ACP whitelist means canonical auto-discovery',
    );
    variant.acp.mcpWhitelist = ['cat-cafe-memory'];
    writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(catalog));
    assert.deepEqual(await resolveConfiguredMemberMcpFamilies(root, 'codex'), ['memory']);
    capabilities.capabilities.find((entry) => entry.id === 'cat-cafe-memory').enabled = false;
    writeFileSync(capabilityPath, JSON.stringify(capabilities));
    assert.deepEqual(await resolveConfiguredMemberMcpFamilies(root, 'codex'), []);
    writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), '{broken');
    assert.deepEqual(
      await resolveConfiguredMemberMcpFamilies(root, 'codex'),
      [],
      'missing current ACP metadata fails closed',
    );
  } finally {
    if (savedTemplate === undefined) delete process.env.CAT_TEMPLATE_PATH;
    else process.env.CAT_TEMPLATE_PATH = savedTemplate;
    catRegistry.reset();
    for (const [id, config] of Object.entries(savedMembers)) catRegistry.register(id, config);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const transport of ['shared', 'stdio'])
  test(`${transport} launch exposes credential paths and keeps inline callback secrets out of child env`, () => {
    const env = buildChildEnv({
      CAT_CAFE_MCP_TRANSPORT: transport,
      CAT_CAFE_CREDENTIAL_FILE: '/fixture/credentials.json',
      CAT_CAFE_INVOCATION_ID: 'fixture-A',
      CAT_CAFE_CALLBACK_TOKEN: 'fixture-token-A',
      F333_FIXTURE_SETTING: 'preserved',
    });
    assert.equal(env.CAT_CAFE_CREDENTIAL_FILE, '/fixture/credentials.json');
    assert.equal(env.CAT_CAFE_INVOCATION_ID, 'fixture-A', 'non-secret hook/provenance identity survives');
    assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, undefined);
    assert.equal(env.F333_FIXTURE_SETTING, 'preserved');
  });

test('turn cleanup retires only its exclusive ACP carrier and preserves another active lease', async () => {
  const clients = [];
  const pool = new AcpProcessPool({ maxLiveProcesses: 2 }, {}, () => {
    const client = {
      isAlive: true,
      isCwdIntact: true,
      initialize: async () => {},
      close: async () => {
        client.isAlive = false;
      },
    };
    clients.push(client);
    return client;
  });
  const key = { projectPath: '/fixture', providerProfile: 'fixture' };
  const first = await pool.acquire(key);
  const second = await pool.acquire(key);
  try {
    await first.closeTurn('session-A');
    assert.equal(clients[0].isAlive, false);
    assert.equal(clients[1].isAlive, true);
    first.release();
    assert.equal(pool.getMetrics().activeLeaseCount, 1);
  } finally {
    first.release();
    second.release();
    await pool.closeAll();
  }
});

test('multiplexed ACP cleanup ends the original logical session without stopping its shared carrier', async () => {
  const sessions = [];
  let processCloses = 0;
  const pool = new AcpProcessPool({ maxLiveProcesses: 1 }, { supportsMultiplexing: true }, () => ({
    isAlive: true,
    isCwdIntact: true,
    initialize: async () => {},
    agentCapabilities: { sessionCapabilities: { close: {} } },
    closeSession: async (id) => {
      sessions.push(id);
    },
    close: async () => {
      processCloses++;
    },
  }));
  const key = { projectPath: '/fixture', providerProfile: 'fixture' };
  const first = await pool.acquire(key);
  const second = await pool.acquire(key);
  try {
    await first.closeTurn('session-A');
    assert.deepEqual(sessions, ['session-A']);
    assert.equal(processCloses, 0);
    assert.equal(first.client, second.client);
  } finally {
    first.release();
    second.release();
    await pool.closeAll();
  }
});

test('failed ACP session close drains only its carrier after active peers finish and prevents warm reuse', async () => {
  const clients = [];
  const pool = new AcpProcessPool({ maxLiveProcesses: 2 }, { supportsMultiplexing: true }, () => {
    const client = {
      isAlive: true,
      isCwdIntact: true,
      initialize: async () => {},
      agentCapabilities: { sessionCapabilities: { close: {} } },
      closeSession: async () => {
        throw new Error('fixture-session-close-failed');
      },
      close: async () => {
        client.isAlive = false;
      },
    };
    clients.push(client);
    return client;
  });
  const key = { projectPath: '/fixture', providerProfile: 'fixture-close-failure' };
  const first = await pool.acquire(key);
  const peer = await pool.acquire(key);
  pool.rememberSession(key, 'session-A', first);
  let replacement;
  try {
    await assert.rejects(first.closeTurn('session-A'), /fixture-session-close-failed/);
    assert.equal(first.client.isAlive, true, 'an active peer cannot be killed by another turn cleanup');
    replacement = await pool.acquire(key, { sessionId: 'session-A' });
    assert.notEqual(replacement.client, first.client, 'failed cleanup cannot return the old carrier to warm reuse');
    first.release();
    assert.equal(peer.client.isAlive, true);
    peer.release();
    await new Promise((done) => setImmediate(done));
    assert.equal(peer.client.isAlive, false, 'drained unsafe carrier must retire');
    assert.equal(replacement.client.isAlive, true);
    assert.equal(pool.getMetrics().activeLeaseCount, 1);
  } finally {
    first.release();
    peer.release();
    replacement?.release();
    await pool.closeAll();
  }
});
