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

const { readClaudeMcpConfig, readCodexMcpConfig, readGeminiMcpConfig } = await import(
  '../dist/config/capabilities/mcp-config-adapters.js'
);

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
          source: /** @type {'external'} */ ('external'),
          mcpServer: { command: 'echo', args: [] },
        },
      ],
    };

    await writeCapabilitiesConfig(dir, config);

    // Generate CLI configs
    const paths = {
      anthropic: join(dir, '.mcp.json'),
      openai: join(dir, '.codex', 'config.toml'),
      google: join(dir, '.gemini', 'settings.json'),
    };
    await generateCliConfigs(config, paths);

    // Read back each CLI config
    const claudeServers = await readClaudeMcpConfig(paths.anthropic);
    const codexServers = await readCodexMcpConfig(paths.openai);
    const geminiServers = await readGeminiMcpConfig(paths.google);

    // Claude/Gemini: only enabled servers (no 'enabled' field in these formats)
    assert.ok(
      claudeServers.find((s) => s.name === 'cat-cafe'),
      'Claude should have cat-cafe',
    );
    assert.ok(
      claudeServers.find((s) => s.name === 'filesystem'),
      'Claude should have filesystem',
    );
    assert.ok(!claudeServers.find((s) => s.name === 'disabled-tool'), 'Claude should NOT have disabled tool');

    assert.ok(
      geminiServers.find((s) => s.name === 'cat-cafe'),
      'Gemini should have cat-cafe',
    );
    assert.ok(!geminiServers.find((s) => s.name === 'disabled-tool'), 'Gemini should NOT have disabled tool');

    // Codex: all servers with explicit enabled field
    assert.ok(
      codexServers.find((s) => s.name === 'cat-cafe'),
      'Codex should have cat-cafe',
    );
    const disabledInCodex = codexServers.find((s) => s.name === 'disabled-tool');
    assert.ok(disabledInCodex, 'Codex should have disabled-tool (with enabled=false)');
    assert.equal(disabledInCodex.enabled, false, 'disabled-tool should be disabled in Codex');
  });

  it('orchestrate idempotent: run twice with same config = same output', async () => {
    const discoveryPaths = {
      claudeConfig: join(dir, '.mcp.json'),
      codexConfig: join(dir, 'x.toml'),
      geminiConfig: join(dir, 'x.json'),
    };
    const cliPaths = {
      anthropic: join(dir, '.mcp.json'),
      openai: join(dir, '.codex', 'config.toml'),
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
    };
    const cliPaths = {
      anthropic: join(dir, '.mcp.json'),
      openai: join(dir, '.codex', 'config.toml'),
      google: join(dir, '.gemini', 'settings.json'),
    };

    // Bootstrap creates capabilities.json
    const config = await bootstrapCapabilities(dir, discoveryPaths);
    assert.ok(config, 'Bootstrap should return config');

    // CLI configs should be generated after bootstrap
    await generateCliConfigs(config, cliPaths);

    // Verify CLI configs contain split cat-cafe servers
    const claudeServers = await readClaudeMcpConfig(cliPaths.anthropic);
    assert.ok(claudeServers.find((s) => s.name === 'cat-cafe-collab'));
    assert.ok(claudeServers.find((s) => s.name === 'cat-cafe-memory'));
    assert.ok(claudeServers.find((s) => s.name === 'cat-cafe-signals'));

    const codexServers = await readCodexMcpConfig(cliPaths.openai);
    assert.ok(codexServers.find((s) => s.name === 'cat-cafe-collab'));
    assert.ok(codexServers.find((s) => s.name === 'cat-cafe-memory'));
    assert.ok(codexServers.find((s) => s.name === 'cat-cafe-signals'));

    const geminiServers = await readGeminiMcpConfig(cliPaths.google);
    const collab = geminiServers.find((s) => s.name === 'cat-cafe-collab');
    const memory = geminiServers.find((s) => s.name === 'cat-cafe-memory');
    const signals = geminiServers.find((s) => s.name === 'cat-cafe-signals');
    assert.ok(collab);
    assert.ok(memory);
    assert.ok(signals);
    for (const server of [collab, memory, signals]) {
      assert.deepEqual(server.env, {
        CAT_CAFE_API_URL: '${CAT_CAFE_API_URL}',
        CAT_CAFE_INVOCATION_ID: '${CAT_CAFE_INVOCATION_ID}',
        CAT_CAFE_CALLBACK_TOKEN: '${CAT_CAFE_CALLBACK_TOKEN}',
        CAT_CAFE_USER_ID: '${CAT_CAFE_USER_ID}',
        CAT_CAFE_SIGNAL_USER: '${CAT_CAFE_SIGNAL_USER}',
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

    const paths = {
      anthropic: join(dir, '.mcp.json'),
      openai: join(dir, '.codex', 'config.toml'),
      google: join(dir, '.gemini', 'settings.json'),
    };
    await generateCliConfigs(config, paths);

    // Verify both present
    let claude = await readClaudeMcpConfig(paths.anthropic);
    assert.ok(
      claude.find((s) => s.name === 'filesystem'),
      'filesystem should be in Claude config',
    );

    // 2. PATCH: disable filesystem globally
    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    const fsCap = updated.capabilities.find((c) => c.id === 'filesystem');
    assert.ok(fsCap);
    fsCap.enabled = false;
    await writeCapabilitiesConfig(dir, updated);
    await generateCliConfigs(updated, paths);

    // 3. Verify: filesystem removed from Claude/Gemini configs
    claude = await readClaudeMcpConfig(paths.anthropic);
    assert.ok(
      !claude.find((s) => s.name === 'filesystem'),
      'filesystem should be REMOVED from Claude config after disable',
    );
    assert.ok(
      claude.find((s) => s.name === 'cat-cafe'),
      'cat-cafe should still be present',
    );

    const gemini = await readGeminiMcpConfig(paths.google);
    assert.ok(
      !gemini.find((s) => s.name === 'filesystem'),
      'filesystem should be REMOVED from Gemini config after disable',
    );

    // Codex: should have filesystem with enabled=false
    const codex = await readCodexMcpConfig(paths.openai);
    const fsCodex = codex.find((s) => s.name === 'filesystem');
    assert.ok(fsCodex, 'Codex should still list filesystem');
    assert.equal(fsCodex.enabled, false, 'filesystem should be disabled in Codex');
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
          source: /** @type {'external'} */ ('external'),
          mcpServer: { command: 'npx', args: ['@mcp/fs'] },
        },
      ],
    };
    await writeCapabilitiesConfig(dir, config);

    const paths = {
      anthropic: join(dir, '.mcp.json'),
      openai: join(dir, '.codex', 'config.toml'),
      google: join(dir, '.gemini', 'settings.json'),
    };
    await generateCliConfigs(config, paths);

    // Verify filesystem not in Claude
    let claude = await readClaudeMcpConfig(paths.anthropic);
    assert.ok(!claude.find((s) => s.name === 'filesystem'), 'filesystem starts disabled in Claude');

    // 2. PATCH: re-enable filesystem
    const updated = await readCapabilitiesConfig(dir);
    assert.ok(updated);
    const fsCap = updated.capabilities.find((c) => c.id === 'filesystem');
    assert.ok(fsCap);
    fsCap.enabled = true;
    await writeCapabilitiesConfig(dir, updated);
    await generateCliConfigs(updated, paths);

    // 3. Verify: filesystem restored in all configs
    claude = await readClaudeMcpConfig(paths.anthropic);
    assert.ok(
      claude.find((s) => s.name === 'filesystem'),
      'filesystem should be RESTORED in Claude config after re-enable',
    );

    const gemini = await readGeminiMcpConfig(paths.google);
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
    });

    // Should have: cat-cafe main(1) + split(3) + pencil + jetbrains (discovered)
    assert.equal(config.capabilities.length, 6);

    const catCafeMain = config.capabilities.find((c) => c.id === 'cat-cafe');
    assert.ok(catCafeMain);
    assert.equal(catCafeMain.source, 'cat-cafe');

    const catCafeCollab = config.capabilities.find((c) => c.id === 'cat-cafe-collab');
    assert.ok(catCafeCollab);
    assert.equal(catCafeCollab.source, 'cat-cafe');
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-memory'));
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-signals'));

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

describe('F041 Per-Cat Override Resolution', () => {
  it('global enabled + per-cat disabled = disabled for that cat', () => {
    const config = {
      version: /** @type {1} */ (1),
      capabilities: [
        {
          id: 'tool',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: true,
          source: /** @type {'external'} */ ('external'),
          mcpServer: { command: 'echo', args: [] },
          overrides: [{ catId: 'codex', enabled: false }],
        },
      ],
    };

    const codex = resolveServersForCat(config, 'codex');
    assert.equal(codex[0].enabled, false, 'Codex should have override disabled');

    const opus = resolveServersForCat(config, 'opus');
    assert.equal(opus[0].enabled, true, 'Opus should use global enabled');
  });

  it('global disabled + per-cat enabled = enabled for that cat only', () => {
    const config = {
      version: /** @type {1} */ (1),
      capabilities: [
        {
          id: 'tool',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: false,
          source: /** @type {'external'} */ ('external'),
          mcpServer: { command: 'echo', args: [] },
          overrides: [{ catId: 'gemini', enabled: true }],
        },
      ],
    };

    const gemini = resolveServersForCat(config, 'gemini');
    assert.equal(gemini[0].enabled, true, 'Gemini override should be enabled');

    const opus = resolveServersForCat(config, 'opus');
    assert.equal(opus[0].enabled, false, 'Opus should use global disabled');

    const codex = resolveServersForCat(config, 'codex');
    assert.equal(codex[0].enabled, false, 'Codex should use global disabled');
  });

  it('multiple per-cat overrides are independent', () => {
    const config = {
      version: /** @type {1} */ (1),
      capabilities: [
        {
          id: 'tool',
          type: /** @type {'mcp'} */ ('mcp'),
          enabled: true,
          source: /** @type {'external'} */ ('external'),
          mcpServer: { command: 'echo', args: [] },
          overrides: [
            { catId: 'codex', enabled: false },
            { catId: 'gemini', enabled: false },
          ],
        },
      ],
    };

    assert.equal(resolveServersForCat(config, 'opus')[0].enabled, true);
    assert.equal(resolveServersForCat(config, 'codex')[0].enabled, false);
    assert.equal(resolveServersForCat(config, 'gemini')[0].enabled, false);
  });
});
