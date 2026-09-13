// @ts-check

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { createAcpServiceForConfig, resolveEffectiveAcpSupportsMultiplexing } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
);
const { AcpProcessPool } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js');
const { mintDshCredentialFile } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/dsh-acp-bootstrap.js'
);

function catConfig(id) {
  return {
    id,
    name: id,
    displayName: id,
    color: { primary: '#111827', secondary: '#e5e7eb' },
    avatar: '/avatars/default.png',
    mentionPatterns: [`@${id}`],
    roleDescription: 'ACP test member',
    clientId: 'acp',
    defaultModel: 'test-model',
    mcpSupport: false,
  };
}

function writeDshFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-factory-'));
  const binDir = join(root, 'packages', 'examples', 'acp-demo', 'lib');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'bin.js'), '#!/usr/bin/env node\n');
  const mcpClientLib = join(root, 'packages', 'mcp', 'mcp-client', 'lib');
  mkdirSync(mcpClientLib, { recursive: true });
  writeFileSync(
    join(root, 'packages', 'mcp', 'mcp-client', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-mcp-client', type: 'module', main: 'lib/index.js' }),
  );
  writeFileSync(join(mcpClientLib, 'index.js'), 'export default {}\n');
  const configDir = join(root, 'examples', 'acp-agent');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'cordis.yml'), "- id: acp-agent\n  name: '@deepseek-ai/dsh-acp-demo'\n");
  return root;
}

function withDshRoot(root, fn) {
  const prevRoot = process.env.CAT_CAFE_DSH_ROOT;
  const prevConfig = process.env.CAT_CAFE_DSH_ACP_CONFIG;
  process.env.CAT_CAFE_DSH_ROOT = root;
  delete process.env.CAT_CAFE_DSH_ACP_CONFIG;
  return fn().finally(() => {
    if (prevRoot === undefined) delete process.env.CAT_CAFE_DSH_ROOT;
    else process.env.CAT_CAFE_DSH_ROOT = prevRoot;
    if (prevConfig === undefined) delete process.env.CAT_CAFE_DSH_ACP_CONFIG;
    else process.env.CAT_CAFE_DSH_ACP_CONFIG = prevConfig;
  });
}

function createDshLikeClient(projectRoot) {
  const credFile = mintDshCredentialFile(projectRoot, 'dsh');
  let alive = false;
  let closed = false;
  return {
    get isAlive() {
      return alive && !closed;
    },
    get isCwdIntact() {
      return true;
    },
    get isSafeForSingleFlightReuse() {
      return false;
    },
    get mcpCredentialFile() {
      return credFile;
    },
    async initialize() {
      alive = true;
    },
    async close() {
      closed = true;
      alive = false;
    },
    _isClosed() {
      return closed;
    },
  };
}

describe('AcpServiceFactory', () => {
  it('uses one effective model for ACP bootstrap, context policy, and the concrete service binding', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-effective-model-'));
    const profileId = 'acp-effective-model';
    const envKey = 'CAT_ACP_EFFECTIVE_MODEL_MODEL';
    const previousModel = process.env[envKey];
    const poolRegistry = new Map();

    try {
      process.env[envKey] = 'claude-opus-4-6';
      const service = await createAcpServiceForConfig({
        projectRoot,
        profileId,
        effectiveModel: process.env[envKey],
        config: {
          id: profileId,
          name: 'ACP Effective Model',
          displayName: 'ACP Effective Model',
          color: { primary: '#111827', secondary: '#e5e7eb' },
          avatar: '/avatars/default.png',
          mentionPatterns: [`@${profileId}`],
          roleDescription: 'ACP effective model test member',
          clientId: 'opencode',
          provider: undefined,
          defaultModel: 'anthropic/claude-haiku-4-5',
          mcpSupport: false,
        },
        acpConfig: { command: 'mock-acp', startupArgs: ['--model', '$' + '{model}', '--acp'] },
        poolRegistry,
        log: { info() {}, warn() {} },
      });

      assert.ok(service);
      assert.equal(service.sessionModel, 'anthropic/claude-opus-4-6');
      assert.deepEqual(service.contextBinding(), {
        model: 'anthropic/claude-opus-4-6',
        windowTokens: 1_000_000,
        source: 'service_spawn',
      });
      assert.deepEqual(poolRegistry.get(profileId).clientFactory().config.args, [
        '--model',
        'anthropic/claude-opus-4-6',
        '--acp',
      ]);
    } finally {
      if (previousModel === undefined) delete process.env[envKey];
      else process.env[envKey] = previousModel;
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  for (const [clientId, provider, defaultModel] of [
    ['opencode', 'zhipu', 'zhipu/glm-5.2'],
    ['google', 'google', 'gemini-test-model'],
    ['kimi', 'kimi', 'kimi-test-model'],
  ]) {
    it(`rebuilds the ${clientId} ACP pool when the derived member context policy changes`, async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), `acp-context-policy-${clientId}-`));
      const profileId = `${clientId}-context-policy`;
      const poolRegistry = new Map();
      const makeConfig = (contextWindow) => ({
        id: profileId,
        name: `${clientId} ACP`,
        displayName: `${clientId} ACP`,
        color: { primary: '#111827', secondary: '#e5e7eb' },
        avatar: '/avatars/default.png',
        mentionPatterns: [`@${profileId}`],
        roleDescription: 'ACP context policy test member',
        clientId,
        provider,
        defaultModel,
        contextWindow,
        mcpSupport: false,
      });
      const baseInput = {
        projectRoot,
        profileId,
        effectiveModel: defaultModel,
        acpConfig: { command: 'mock-acp', startupArgs: ['--acp'] },
        poolRegistry,
        log: { info() {}, warn() {} },
      };

      let closeFirstPool;
      try {
        assert.ok(await createAcpServiceForConfig({ ...baseInput, config: makeConfig(200_000) }));
        const firstPool = poolRegistry.get(profileId);
        assert.ok(firstPool);
        closeFirstPool = firstPool.closeAll.bind(firstPool);
        let retireCalls = 0;
        let forcedCloseCalls = 0;
        firstPool.retireWhenIdle = () => {
          retireCalls++;
        };
        firstPool.closeAll = async () => {
          forcedCloseCalls++;
        };
        if (clientId === 'kimi') {
          const client = firstPool.clientFactory();
          assert.equal(client.config.env.KIMI_MODEL_MAX_CONTEXT_SIZE, '200000');
        }
        assert.ok(await createAcpServiceForConfig({ ...baseInput, config: makeConfig(128_000) }));
        const secondPool = poolRegistry.get(profileId);
        assert.ok(secondPool);
        assert.notEqual(secondPool, firstPool, 'policy change must replace the old process pool');
        assert.equal(retireCalls, 1, 'the old generation must drain instead of being synchronously closed');
        assert.equal(forcedCloseCalls, 0, 'config refresh must not force-close active leases');
      } finally {
        await closeFirstPool?.();
        await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  }

  it('uses the active project root when building ACP services', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-service-active-root-'));
    const poolRegistry = new Map();

    try {
      const service = await createAcpServiceForConfig({
        projectRoot,
        profileId: 'active-root-acp',
        effectiveModel: 'test-model',
        config: {
          id: 'active-root-acp',
          name: 'Active Root ACP',
          displayName: 'Active Root ACP',
          color: { primary: '#111827', secondary: '#e5e7eb' },
          avatar: '/avatars/default.png',
          mentionPatterns: ['@active-root-acp'],
          roleDescription: 'ACP test member',
          clientId: 'acp',
          defaultModel: 'test-model',
          mcpSupport: false,
        },
        acpConfig: { command: 'mock-acp', startupArgs: ['--config=./agent.json'] },
        poolRegistry,
        log: { info() {}, warn() {} },
      });

      assert.ok(service, 'ACP service should be created for valid generic ACP config');
      assert.equal(service.projectRoot, projectRoot, 'service must retain the active runtime project root');
      assert.equal(service.poolKey.projectPath, projectRoot, 'pool key must be scoped to the active project root');
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps DSH bootstrap then skips when upstream rejects a torn account binding', async () => {
    const dshRoot = writeDshFixture();
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-dsh-rejected-account-'));
    const globalRoot = mkdtempSync(join(tmpdir(), 'acp-dsh-rejected-global-'));
    const previousGlobal = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    const warnings = [];
    mkdirSync(join(globalRoot, '.cat-cafe'), { recursive: true });
    // Credential without account metadata → AccountStoreVerdictError (upstream isolation).
    writeFileSync(
      join(globalRoot, '.cat-cafe', 'credentials.json'),
      JSON.stringify({ 'torn-dsh-account': { apiKey: 'sk-torn' } }),
    );

    try {
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
      await withDshRoot(dshRoot, async () => {
        const service = await createAcpServiceForConfig({
          projectRoot,
          profileId: 'dsh-torn',
          effectiveModel: 'deepseek-chat',
          config: {
            ...catConfig('dsh-torn'),
            clientId: 'anthropic',
            provider: 'anthropic',
            accountRef: 'torn-dsh-account',
            defaultModel: 'deepseek-chat',
          },
          acpConfig: { command: 'dsh', startupArgs: ['--acp'], mcpWhitelist: [] },
          poolRegistry: new Map(),
          log: {
            info() {},
            warn(obj, msg) {
              warnings.push({ obj, msg });
            },
          },
        });

        assert.equal(service, null, 'rejected account must skip ACP registration after DSH prep');
        assert.ok(
          warnings.some(
            (entry) =>
              entry.obj?.reason === 'rejected-account-binding' ||
              String(entry.msg ?? '').includes('could not be adjudicated') ||
              String(entry.obj?.err?.message ?? '').includes('torn credential'),
          ),
          `expected rejected-account-binding warning, got ${JSON.stringify(warnings)}`,
        );
      });
    } finally {
      if (previousGlobal === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobal;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(globalRoot, { recursive: true, force: true });
      rmSync(dshRoot, { recursive: true, force: true });
    }
  });

  it('skips registration and closes existing pools when bound accountRef is missing', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-service-missing-account-'));
    let closed = 0;
    const poolRegistry = new Map([
      [
        'missing-account-acp',
        {
          async closeAll() {
            closed++;
          },
        },
      ],
    ]);

    try {
      const service = await createAcpServiceForConfig({
        projectRoot,
        profileId: 'missing-account-acp',
        effectiveModel: 'gpt-test',
        config: {
          id: 'missing-account-acp',
          name: 'Missing Account ACP',
          displayName: 'Missing Account ACP',
          color: { primary: '#111827', secondary: '#e5e7eb' },
          avatar: '/avatars/default.png',
          mentionPatterns: ['@missing-account-acp'],
          roleDescription: 'ACP test member',
          clientId: 'openai',
          provider: 'openai',
          accountRef: 'missing-acp-account',
          defaultModel: 'gpt-test',
          mcpSupport: false,
        },
        acpConfig: { command: 'mock-acp', startupArgs: ['--acp'] },
        poolRegistry,
        log: { info() {}, warn() {} },
      });

      assert.equal(service, null, 'missing bound account must skip ACP service registration');
      assert.equal(closed, 1, 'stale pool for missing account binding should be closed');
      assert.equal(poolRegistry.has('missing-account-acp'), false, 'stale pool should be removed from registry');
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('DSH cannot opt into multiplexing via catalog config', () => {
    assert.equal(resolveEffectiveAcpSupportsMultiplexing({ command: 'dsh', supportsMultiplexing: true }), false);
    assert.equal(
      resolveEffectiveAcpSupportsMultiplexing({ command: 'dsh-acp-demo', supportsMultiplexing: true }),
      false,
    );
    assert.equal(
      resolveEffectiveAcpSupportsMultiplexing({ command: '/opt/dsh-acp-demo', supportsMultiplexing: true }),
      false,
    );
    assert.equal(resolveEffectiveAcpSupportsMultiplexing({ command: 'grok', supportsMultiplexing: true }), true);
    assert.equal(resolveEffectiveAcpSupportsMultiplexing({ command: 'mock-acp' }), false);
  });

  it('leaves non-DSH multiplexing config intact in spawn signature and pool', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-service-mux-'));
    const poolRegistry = new Map();
    try {
      const service = await createAcpServiceForConfig({
        projectRoot,
        profileId: 'mux-acp',
        config: catConfig('mux-acp'),
        effectiveModel: 'test-model',
        acpConfig: { command: 'mock-acp', startupArgs: ['--acp'], supportsMultiplexing: true },
        poolRegistry,
        log: { info() {}, warn() {} },
      });
      assert.ok(service);
      assert.equal(JSON.parse(service.pool.spawnSignature).supportsMultiplexing, true);
      assert.equal(service.pool.supportsMultiplexing, true);
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('forces DSH spawn signature and pool to single-flight even when config enables multiplexing', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-service-dsh-mux-'));
    const dshRoot = writeDshFixture();
    const poolRegistry = new Map();
    await withDshRoot(dshRoot, async () => {
      try {
        const service = await createAcpServiceForConfig({
          projectRoot,
          profileId: 'dsh',
          config: catConfig('dsh'),
          effectiveModel: 'test-model',
          acpConfig: {
            command: 'dsh',
            startupArgs: [],
            supportsMultiplexing: true,
            pool: { maxLiveProcesses: 1 },
          },
          poolRegistry,
          log: { info() {}, warn() {} },
        });
        assert.ok(service, 'DSH ACP demo fixture must register');
        assert.equal(JSON.parse(service.pool.spawnSignature).supportsMultiplexing, false);
        assert.equal(service.pool.supportsMultiplexing, false);
      } finally {
        await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
        rmSync(projectRoot, { recursive: true, force: true });
        rmSync(dshRoot, { recursive: true, force: true });
      }
    });
  });

  it('DSH invocations with supportsMultiplexing:true do not share client or credential path', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dsh-mux-isolation-'));
    const acpConfig = {
      command: 'dsh',
      startupArgs: [],
      supportsMultiplexing: true,
      pool: { maxLiveProcesses: 1 },
    };
    const supportsMultiplexing = resolveEffectiveAcpSupportsMultiplexing(acpConfig);
    const pool = new AcpProcessPool(
      { maxLiveProcesses: 1, idleTtlMs: 60_000, healthCheckIntervalMs: 999_999 },
      { ...acpConfig, supportsMultiplexing },
      () => createDshLikeClient(projectRoot),
    );
    const key = { projectPath: projectRoot, providerProfile: 'dsh' };
    try {
      const leaseA = await pool.acquire(key);
      const clientA = leaseA.client;
      const pathA = clientA.mcpCredentialFile;
      await assert.rejects(
        () => pool.acquire(key),
        /Pool at capacity/,
        'maxLiveProcesses:1 must not multiplex a second live DSH lease onto the same credential path',
      );
      leaseA.release();
      assert.equal(clientA._isClosed(), true, 'release must retire the DSH process');
      assert.equal(clientA.isAlive, false);

      const leaseB = await pool.acquire(key);
      assert.notStrictEqual(leaseB.client, clientA, 'next invocation must not share the retired client');
      assert.notEqual(
        leaseB.client.mcpCredentialFile,
        pathA,
        'next invocation must not share the spawn-frozen credential path',
      );
      leaseB.release();
    } finally {
      await pool.closeAll();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
