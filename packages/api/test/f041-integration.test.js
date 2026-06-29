// @ts-check
/**
 * F041 Integration Tests — 红绿测试
 *
 * End-to-end verification of the capability management pipeline:
 * 1. Config round-trip: capabilities.json ↔ CLI configs
 * 2. Injection互斥: MCP available → no injection; unavailable → fallback
 * 3. Discovery consistency: external servers correctly merged
 * 4. Per-cat override resolution
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
  bootstrapCapabilities,
  resolveServersForCat,
  generateCliConfigs,
  orchestrate,
} = await import('../dist/config/capabilities/capability-orchestrator.js');

const { readGeminiMcpConfig } = await import('../dist/config/capabilities/mcp-config-adapters.js');

const { needsMcpInjection, buildMcpCallbackInstructions } = await import(
  '../dist/domains/cats/services/agents/invocation/McpPromptInjector.js'
);

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `f041-integ-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ════════════════════════════════════════════════════
// 1. Config Round-Trip
// ════════════════════════════════════════════════════

describe('F041 Config Round-Trip', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('roundtrip');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('capabilities.json → CLI configs → read back preserves servers', async () => {
    // Seed capabilities.json with cat-cafe + external
    const config = {
      version: /** @type {1} */ (1),
      capabilities: [
        {
          id: 'cat-cafe',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: true,
          source: /** @type {'cat-cafe'} */ ('cat-cafe'),
          mcpServer: { command: 'node', args: ['server.js'] },
        },
        {
          id: 'filesystem',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: true,
          source: /** @type {'external'} */ ('external'),
          mcpServer: { command: 'npx', args: ['-y', '@mcp/fs'] },
        },
        {
          id: 'disabled-tool',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: false,
          globalEnabled: false,
          source: /** @type {'external'} */ ('external'),
          mcpServer: { command: 'echo', args: [] },
        },
      ],
    };

    await writeCapabilitiesConfig(dir, config);

    // #712: Only Gemini gets persistent CLI config; Claude/Codex use invoke-time injection
    const paths = {
      google: join(dir, '.gemini', 'settings.json'),
    };
    await generateCliConfigs(config, paths, dir);

    // Read back Gemini CLI config — the only persistent config
    const geminiServers = await readGeminiMcpConfig(paths.google);

    assert.ok(
      geminiServers.find((s) => s.name === 'cat-cafe'),
      'Gemini should have cat-cafe',
    );
    assert.ok(
      geminiServers.find((s) => s.name === 'filesystem'),
      'Gemini should have filesystem',
    );
    assert.ok(!geminiServers.find((s) => s.name === 'disabled-tool'), 'Gemini should NOT have disabled tool');
  });

  it('orchestrate idempotent: run twice with same config = same output', async () => {
    const discoveryPaths = {
      claudeConfig: join(dir, '.mcp.json'),
      codexConfig: join(dir, 'x.toml'),
      geminiConfig: join(dir, 'x.json'),
      kimiConfig: join(dir, 'x-kimi.json'),
    };
    // #712: Only Gemini gets persistent CLI config
    const cliPaths = {
      google: join(dir, '.gemini', 'settings.json'),
    };

    const config1 = await orchestrate(dir, discoveryPaths, cliPaths);
    const config2 = await orchestrate(dir, discoveryPaths, cliPaths);

    assert.deepEqual(config1, config2, 'Two runs should produce identical config');
  });
});

// ════════════════════════════════════════════════════
// 1b. Cloud P1-1: Bootstrap must generate CLI configs
// ════════════════════════════════════════════════════

describe('F041 Cloud P1-1: bootstrap generates CLI configs', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('bootstrap-cli');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('bootstrapCapabilities + generateCliConfigs produces CLI config files', async () => {
    // Simulate first-run: no capabilities.json exists
    const discoveryPaths = {
      claudeConfig: join(dir, '.mcp.json'),
      codexConfig: join(dir, '.codex', 'config.toml'),
      geminiConfig: join(dir, '.gemini', 'settings.json'),
      kimiConfig: join(dir, '.kimi', 'mcp.json'),
    };
    // #712: Only Gemini gets persistent CLI config
    const cliPaths = {
      google: join(dir, '.gemini', 'settings.json'),
    };

    // Bootstrap creates capabilities.json
    const config = await bootstrapCapabilities(dir, discoveryPaths);
    assert.ok(config, 'Bootstrap should return config');

    // CLI configs should be generated after bootstrap
    await generateCliConfigs(config, cliPaths, dir);

    // Verify Gemini CLI config contains split cat-cafe servers
    const geminiServers = await readGeminiMcpConfig(cliPaths.google);
    const collab = geminiServers.find((s) => s.name === 'cat-cafe-collab');
    const memory = geminiServers.find((s) => s.name === 'cat-cafe-memory');
    const signals = geminiServers.find((s) => s.name === 'cat-cafe-signals');
    assert.ok(collab);
    assert.ok(memory);
    assert.ok(signals);
    for (const server of [collab, memory, signals]) {
      // #712: env placeholders now include all MCP_CALLBACK_ENV_KEYS from mcp-constants.ts
      assert.deepEqual(server.env, {
        CAT_CAFE_API_URL: '${CAT_CAFE_API_URL}',
        CAT_CAFE_INVOCATION_ID: '${CAT_CAFE_INVOCATION_ID}',
        CAT_CAFE_CALLBACK_TOKEN: '${CAT_CAFE_CALLBACK_TOKEN}',
        CAT_CAFE_USER_ID: '${CAT_CAFE_USER_ID}',
        CAT_CAFE_CAT_ID: '${CAT_CAFE_CAT_ID}',
        CAT_CAFE_THREAD_ID: '${CAT_CAFE_THREAD_ID}',
        CAT_CAFE_SIGNAL_USER: '${CAT_CAFE_SIGNAL_USER}',
        CAT_CAFE_RUN_TYPE: '${CAT_CAFE_RUN_TYPE}',
        CAT_CAFE_AUDIT_TOPIC: '${CAT_CAFE_AUDIT_TOPIC}',
      });
    }
  });
});

// ════════════════════════════════════════════════════
// 1c. Hot-Reload: PATCH toggle → CLI config regenerated
// ════════════════════════════════════════════════════

describe('F041 Hot-Reload: toggle → CLI config regenerated', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('hotreload');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('disabling MCP tool via PATCH removes it from CLI configs', async () => {
    // 1. Seed: two MCP tools, both enabled
    const config = {
      version: /** @type {1} */ (1),
      capabilities: [
        {
          id: 'cat-cafe',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: true,
          source: /** @type {'cat-cafe'} */ ('cat-cafe'),
          mcpServer: { command: 'node', args: ['server.js'] },
        },
        {
          id: 'filesystem',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: true,
          source: /** @type {'external'} */ ('external'),
          mcpServer: { command: 'npx', args: ['@mcp/fs'] },
        },
      ],
    };
    await writeCapabilitiesConfig(dir, config);

    // #712: Only Gemini gets persistent CLI config
    const paths = {
      google: join(dir, '.gemini', 'settings.json'),
    };
    await generateCliConfigs(config, paths, dir);

    // Verify both present in Gemini
    let gemini = await readGeminiMcpConfig(paths.google);
    assert.ok(
      gemini.find((s) => s.name === 'filesystem'),
      'filesystem should be in Gemini config',
    );

    // 2. PATCH: disable filesystem globally (set both enabled and globalEnabled)
    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    const fsCap = updated.capabilities.find((c) => c.id === 'filesystem');
    assert.ok(fsCap);
    fsCap.enabled = false;
    fsCap.globalEnabled = false;
    await writeCapabilitiesConfig(dir, updated);
    await generateCliConfigs(updated, paths, dir);

    // 3. Verify: filesystem removed from Gemini config
    gemini = await readGeminiMcpConfig(paths.google);
    assert.ok(
      !gemini.find((s) => s.name === 'filesystem'),
      'filesystem should be REMOVED from Gemini config after disable',
    );
    assert.ok(
      gemini.find((s) => s.name === 'cat-cafe'),
      'cat-cafe should still be present',
    );
  });

  it('re-enabling MCP tool via PATCH restores it in CLI configs', async () => {
    // 1. Seed: filesystem disabled
    const config = {
      version: /** @type {1} */ (1),
      capabilities: [
        {
          id: 'cat-cafe',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: true,
          source: /** @type {'cat-cafe'} */ ('cat-cafe'),
          mcpServer: { command: 'node', args: ['server.js'] },
        },
        {
          id: 'filesystem',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: false,
          globalEnabled: false,
          source: /** @type {'external'} */ ('external'),
          mcpServer: { command: 'npx', args: ['@mcp/fs'] },
        },
      ],
    };
    await writeCapabilitiesConfig(dir, config);

    // #712: Only Gemini gets persistent CLI config
    const paths = {
      google: join(dir, '.gemini', 'settings.json'),
    };
    await generateCliConfigs(config, paths, dir);

    // Verify filesystem not in Gemini
    let gemini = await readGeminiMcpConfig(paths.google);
    assert.ok(!gemini.find((s) => s.name === 'filesystem'), 'filesystem starts disabled in Gemini');

    // 2. PATCH: re-enable filesystem (set both enabled and globalEnabled)
    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    const fsCap = updated.capabilities.find((c) => c.id === 'filesystem');
    assert.ok(fsCap);
    fsCap.enabled = true;
    fsCap.globalEnabled = true;
    await writeCapabilitiesConfig(dir, updated);
    await generateCliConfigs(updated, paths, dir);

    // 3. Verify: filesystem restored in Gemini config
    gemini = await readGeminiMcpConfig(paths.google);
    assert.ok(
      gemini.find((s) => s.name === 'filesystem'),
      'filesystem should be RESTORED in Gemini config after re-enable',
    );
  });
});

// ════════════════════════════════════════════════════
// 2. Injection 互斥 (Mutual Exclusion)
// ════════════════════════════════════════════════════

describe('F041 Injection互斥', () => {
  it('MCP available → no HTTP callback injection', () => {
    assert.equal(needsMcpInjection(true), false, 'When MCP is available, should NOT inject HTTP callback');
  });

  it('MCP unavailable → HTTP callback fallback injection', () => {
    assert.equal(needsMcpInjection(false), true, 'When MCP is unavailable, should inject HTTP callback as fallback');
  });

  it('HTTP callback instructions contain required tool names', () => {
    const instructions = buildMcpCallbackInstructions({});
    assert.ok(instructions.includes('post-message'), 'Should reference post-message');
    assert.ok(instructions.includes('thread-context'), 'Should reference thread-context');
    assert.ok(instructions.includes('CAT_CAFE_CALLBACK_TOKEN'), 'Should reference callback token');
  });

  it('injection decision matches mcpAvailable = mcpSupport && serverPath', () => {
    // Simulates the route logic: mcpAvailable = mcpSupport && !!serverPath
    const scenarios = [
      { mcpSupport: true, serverPath: '/path', expectedInjection: false },
      { mcpSupport: true, serverPath: '', expectedInjection: true },
      { mcpSupport: false, serverPath: '/path', expectedInjection: true },
      { mcpSupport: false, serverPath: '', expectedInjection: true },
    ];

    for (const s of scenarios) {
      const mcpAvailable = s.mcpSupport && !!s.serverPath;
      const shouldInject = needsMcpInjection(mcpAvailable);
      assert.equal(
        shouldInject,
        s.expectedInjection,
        `mcpSupport=${s.mcpSupport}, serverPath='${s.serverPath}' → inject=${s.expectedInjection}`,
      );
    }
  });
});

// ════════════════════════════════════════════════════
// 3. Discovery Consistency
// ════════════════════════════════════════════════════

describe('F041 Discovery Consistency', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('discovery');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('bootstrap discovers external servers and includes split cat-cafe servers', async () => {
    // Seed Claude config with external server
    const claudeFile = join(dir, '.mcp.json');
    await writeFile(
      claudeFile,
      JSON.stringify({
        mcpServers: {
          pencil: { command: 'node', args: ['pencil-server.js'] },
          jetbrains: { command: 'npx', args: ['jb-mcp'] },
        },
      }),
    );

    const config = await bootstrapCapabilities(dir, {
      claudeConfig: claudeFile,
      codexConfig: join(dir, 'nonexistent.toml'),
      geminiConfig: join(dir, 'nonexistent.json'),
      kimiConfig: join(dir, 'nonexistent-kimi.json'),
    });

    // F193/F195/F207: 6 splits (collab/memory/signals/limb/audio/finance) + pencil + jetbrains. No legacy 'cat-cafe'.
    assert.equal(config.capabilities.length, 8);

    const catCafeLegacy = config.capabilities.find((c) => c.id === 'cat-cafe');
    assert.equal(catCafeLegacy, undefined, 'legacy cat-cafe must not be bootstrapped (Phase C)');

    const catCafeCollab = config.capabilities.find((c) => c.id === 'cat-cafe-collab');
    assert.ok(catCafeCollab);
    assert.equal(catCafeCollab.source, 'cat-cafe');
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-memory'));
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-signals'));
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-limb'));
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-finance'));

    const pencil = config.capabilities.find((c) => c.id === 'pencil');
    assert.ok(pencil);
    assert.equal(pencil.source, 'external');

    const jb = config.capabilities.find((c) => c.id === 'jetbrains');
    assert.ok(jb);
    assert.equal(jb.source, 'external');
  });

  it('external servers discovered from multiple CLI configs are deduplicated', async () => {
    const claudeFile = join(dir, 'claude.json');
    const geminiFile = join(dir, 'gemini.json');

    // Same server name in both Claude and Gemini configs
    await writeFile(
      claudeFile,
      JSON.stringify({
        mcpServers: { shared: { command: 'node', args: ['shared-v1.js'] } },
      }),
    );
    await writeFile(
      geminiFile,
      JSON.stringify({
        mcpServers: { shared: { command: 'node', args: ['shared-v2.js'] } },
      }),
    );

    const config = await bootstrapCapabilities(dir, {
      claudeConfig: claudeFile,
      codexConfig: join(dir, 'x.toml'),
      geminiConfig: geminiFile,
      kimiConfig: join(dir, 'x-kimi.json'),
    });

    // cat-cafe + shared (deduplicated — first wins = claude version)
    const shared = config.capabilities.filter((c) => c.id === 'shared');
    assert.equal(shared.length, 1, 'Should deduplicate by name');
    assert.deepEqual(shared[0].mcpServer?.args, ['shared-v1.js'], 'First discovery wins');
  });
});

// ════════════════════════════════════════════════════
// 4. Per-Cat Override Resolution
// ════════════════════════════════════════════════════

describe('F041 Per-Cat Access Resolution (globalEnabled + blockedCats)', () => {
  it('globalEnabled true + blockedCats blocks specific cat', () => {
    const config = {
      version: /** @type {1} */ (1),
      capabilities: [
        {
          id: 'tool',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: true,
          globalEnabled: true,
          source: /** @type {'external'} */ ('external'),
          mcpServer: { command: 'echo', args: [] },
          blockedCats: ['codex'],
        },
      ],
    };

    const codex = resolveServersForCat(config, 'codex');
    assert.equal(codex[0].enabled, false, 'Codex should be blocked');

    const opus = resolveServersForCat(config, 'opus');
    assert.equal(opus[0].enabled, true, 'Opus should use global enabled');
  });

  it('globalEnabled false disables all cats regardless of blockedCats', () => {
    const config = {
      version: /** @type {1} */ (1),
      capabilities: [
        {
          id: 'tool',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: false,
          globalEnabled: false,
          source: /** @type {'external'} */ ('external'),
          mcpServer: { command: 'echo', args: [] },
          blockedCats: [],
        },
      ],
    };

    const gemini = resolveServersForCat(config, 'gemini');
    assert.equal(gemini[0].enabled, false, 'Gemini should be disabled (global off)');

    const opus = resolveServersForCat(config, 'opus');
    assert.equal(opus[0].enabled, false, 'Opus should be disabled (global off)');

    const codex = resolveServersForCat(config, 'codex');
    assert.equal(codex[0].enabled, false, 'Codex should be disabled (global off)');
  });

  it('multiple blockedCats are independent', () => {
    const config = {
      version: /** @type {1} */ (1),
      capabilities: [
        {
          id: 'tool',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: true,
          globalEnabled: true,
          source: /** @type {'external'} */ ('external'),
          mcpServer: { command: 'echo', args: [] },
          blockedCats: ['codex', 'gemini'],
        },
      ],
    };

    assert.equal(resolveServersForCat(config, 'opus')[0].enabled, true);
    assert.equal(resolveServersForCat(config, 'codex')[0].enabled, false);
    assert.equal(resolveServersForCat(config, 'gemini')[0].enabled, false);
  });
});
