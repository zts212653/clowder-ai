// @ts-check

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';
import {
  bootstrapCapabilities,
  buildCatCafeMcpDescriptor,
  comparePencilDirs,
  deduplicateDiscoveredMcpServers,
  discoverExternalMcpServers,
  generateCliConfigs,
  migrateLegacyCatCafeCapability,
  orchestrate,
  PENCIL_BINARY_SUFFIX,
  parsePencilVersion,
  readCapabilitiesConfig,
  resolvePencilBinary,
  resolveServersForCat,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';

// Bootstrap catRegistry so provider-gated tests can resolve cat → provider.
for (const [id, config] of Object.entries(CAT_CONFIGS)) {
  if (!catRegistry.has(id)) catRegistry.register(id, config);
}

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `cap-orch-test-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Helper: minimal capabilities.json */
function makeConfig(capabilities = []) {
  return { version: 1, capabilities };
}

// ────────── Read/Write capabilities.json ──────────

describe('readCapabilitiesConfig', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('cap-read');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads valid capabilities.json', async () => {
    await mkdir(join(dir, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(dir, '.cat-cafe', 'capabilities.json'),
      JSON.stringify(
        makeConfig([
          {
            id: 'cat-cafe',
            type: 'mcp',
            enabled: true,
            source: 'cat-cafe',
            mcpServer: { command: 'node', args: ['index.js'] },
          },
        ]),
      ),
    );

    const config = await readCapabilitiesConfig(dir);
    assert.ok(config);
    assert.equal(config.version, 1);
    assert.equal(config.capabilities.length, 1);
    assert.equal(config.capabilities[0].id, 'cat-cafe');
  });

  it('returns null for missing file', async () => {
    const config = await readCapabilitiesConfig(dir);
    assert.equal(config, null);
  });

  it('returns null for invalid JSON', async () => {
    await mkdir(join(dir, '.cat-cafe'), { recursive: true });
    await writeFile(join(dir, '.cat-cafe', 'capabilities.json'), 'not json');
    const config = await readCapabilitiesConfig(dir);
    assert.equal(config, null);
  });

  it('returns null for wrong version', async () => {
    await mkdir(join(dir, '.cat-cafe'), { recursive: true });
    await writeFile(join(dir, '.cat-cafe', 'capabilities.json'), JSON.stringify({ version: 99, capabilities: [] }));
    const config = await readCapabilitiesConfig(dir);
    assert.equal(config, null);
  });
});

describe('deduplicateDiscoveredMcpServers', () => {
  it('prefers enabled stdio over streamableHttp with the same name', () => {
    const deduped = deduplicateDiscoveredMcpServers([
      { name: 'remote', transport: 'streamableHttp', url: 'https://example.dev/mcp', enabled: true },
      { name: 'remote', command: 'node', args: ['stdio.js'], enabled: true },
    ]);

    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].command, 'node');
    assert.equal(deduped[0].transport, undefined);
  });

  it('keeps enabled streamableHttp when duplicate stdio entry is disabled', () => {
    const deduped = deduplicateDiscoveredMcpServers([
      { name: 'remote', transport: 'streamableHttp', url: 'https://example.dev/mcp', enabled: true },
      { name: 'remote', command: 'node', args: ['stdio.js'], enabled: false },
    ]);

    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].transport, 'streamableHttp');
    assert.equal(deduped[0].enabled, true);
  });

  it('prefers enabled duplicate over disabled duplicate when transport matches', () => {
    const deduped = deduplicateDiscoveredMcpServers([
      { name: 'filesystem', command: 'node', args: ['fs.js'], enabled: false },
      { name: 'filesystem', command: 'node', args: ['fs.js'], enabled: true },
    ]);

    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].enabled, true);
  });
});

describe('writeCapabilitiesConfig', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('cap-write');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates .cat-cafe/ dir and writes config', async () => {
    const config = makeConfig([
      { id: 'test', type: 'mcp', enabled: true, source: 'external', mcpServer: { command: 'echo', args: [] } },
    ]);

    await writeCapabilitiesConfig(dir, config);

    const raw = await readFile(join(dir, '.cat-cafe', 'capabilities.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.capabilities.length, 1);
  });

  it('round-trips correctly', async () => {
    const config = makeConfig([
      {
        id: 'cat-cafe',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['server.js'] },
      },
      {
        id: 'ext',
        type: 'mcp',
        enabled: false,
        source: 'external',
        mcpServer: { command: 'npx', args: ['ext-server'] },
        overrides: [{ catId: 'opus', enabled: true }],
      },
    ]);

    await writeCapabilitiesConfig(dir, config);
    const read = await readCapabilitiesConfig(dir);
    assert.deepEqual(read, config);
  });
});

// ────────── Discovery ──────────

describe('discoverExternalMcpServers', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('discover');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('discovers servers from Claude .mcp.json', async () => {
    const claudeFile = join(dir, '.mcp.json');
    await writeFile(
      claudeFile,
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@mcp/fs'] },
        },
      }),
    );

    const servers = await discoverExternalMcpServers({
      claudeConfig: claudeFile,
      codexConfig: join(dir, 'nonexistent.toml'),
      geminiConfig: join(dir, 'nonexistent.json'),
    });

    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'filesystem');
    assert.equal(servers[0].source, 'external');
  });

  it('deduplicates by name (first wins)', async () => {
    const claudeFile = join(dir, 'claude.json');
    const geminiFile = join(dir, 'gemini.json');
    await writeFile(
      claudeFile,
      JSON.stringify({
        mcpServers: { shared: { command: 'claude-cmd', args: [] } },
      }),
    );
    await writeFile(
      geminiFile,
      JSON.stringify({
        mcpServers: { shared: { command: 'gemini-cmd', args: [] } },
      }),
    );

    const servers = await discoverExternalMcpServers({
      claudeConfig: claudeFile,
      codexConfig: join(dir, 'nonexistent.toml'),
      geminiConfig: geminiFile,
    });

    assert.equal(servers.length, 1);
    assert.equal(servers[0].command, 'claude-cmd'); // first wins
  });

  it('returns empty when no configs exist', async () => {
    const servers = await discoverExternalMcpServers({
      claudeConfig: join(dir, 'a.json'),
      codexConfig: join(dir, 'b.toml'),
      geminiConfig: join(dir, 'c.json'),
    });
    assert.deepEqual(servers, []);
  });

  it('prefers enabled entry over disabled when same name and same transport', async () => {
    // Codex config supports the enabled field natively.
    // First entry: disabled stdio server.
    const codexFile = join(dir, 'codex.toml');
    await writeFile(
      codexFile,
      ['[mcp_servers.shared]', 'command = "codex-cmd"', 'args = []', 'enabled = false'].join('\n'),
    );
    // Second entry: enabled stdio server (same name, same transport).
    const geminiFile = join(dir, 'gemini.json');
    await writeFile(
      geminiFile,
      JSON.stringify({
        mcpServers: { shared: { command: 'gemini-cmd', args: [] } },
      }),
    );

    const servers = await discoverExternalMcpServers({
      claudeConfig: join(dir, 'nonexistent.json'),
      codexConfig: codexFile,
      geminiConfig: geminiFile,
    });

    assert.equal(servers.length, 1);
    // The enabled entry (gemini) should win over the disabled one (codex)
    assert.equal(servers[0].command, 'gemini-cmd');
    assert.notEqual(servers[0].enabled, false);
  });

  it('skips commandless entries (invalid for stdio config model)', async () => {
    const geminiFile = join(dir, 'gemini.json');
    await writeFile(
      geminiFile,
      JSON.stringify({
        mcpServers: {
          jetbrains: { command: '', args: [] },
          filesystem: { command: 'npx', args: ['-y', '@mcp/fs'] },
        },
      }),
    );

    const servers = await discoverExternalMcpServers({
      claudeConfig: join(dir, 'nonexistent.json'),
      codexConfig: join(dir, 'nonexistent.toml'),
      geminiConfig: geminiFile,
    });

    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'filesystem');
  });

  it('discovers streamableHttp server from Claude config (URL-based, no command)', async () => {
    const claudeFile = join(dir, 'claude.json');
    await writeFile(
      claudeFile,
      JSON.stringify({
        mcpServers: {
          'remote-tool': {
            type: 'http',
            url: 'https://mcp.example.com/sse',
            headers: { Authorization: 'Bearer tok' },
          },
        },
      }),
    );

    const servers = await discoverExternalMcpServers({
      claudeConfig: claudeFile,
      codexConfig: join(dir, 'nonexistent.toml'),
      geminiConfig: join(dir, 'nonexistent.json'),
    });

    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'remote-tool');
    assert.equal(servers[0].transport, 'streamableHttp');
    assert.equal(servers[0].url, 'https://mcp.example.com/sse');
    assert.deepEqual(servers[0].headers, { Authorization: 'Bearer tok' });
    assert.equal(servers[0].source, 'external');
  });

  it('discovers both type:http and type:streamableHttp from Claude config', async () => {
    const claudeFile = join(dir, 'claude.json');
    await writeFile(
      claudeFile,
      JSON.stringify({
        mcpServers: {
          'remote-http': {
            type: 'http',
            url: 'https://mcp.example.com/http',
          },
          'remote-streamable': {
            type: 'streamableHttp',
            url: 'https://mcp.example.com/streamable',
          },
        },
      }),
    );

    const servers = await discoverExternalMcpServers({
      claudeConfig: claudeFile,
      codexConfig: join(dir, 'nonexistent.toml'),
      geminiConfig: join(dir, 'nonexistent.json'),
    });

    assert.equal(servers.length, 2);

    const httpServer = servers.find((s) => s.name === 'remote-http');
    assert.ok(httpServer);
    assert.equal(httpServer.transport, 'streamableHttp');
    assert.equal(httpServer.url, 'https://mcp.example.com/http');

    const streamableServer = servers.find((s) => s.name === 'remote-streamable');
    assert.ok(streamableServer);
    assert.equal(streamableServer.transport, 'streamableHttp');
    assert.equal(streamableServer.url, 'https://mcp.example.com/streamable');
  });
});

// ────────── resolvePencilBinary ──────────

describe('parsePencilVersion', () => {
  it('parses standard version from directory name', () => {
    assert.deepEqual(parsePencilVersion('highagency.pencildev-0.6.33-universal'), [0, 6, 33]);
  });

  it('parses version without suffix', () => {
    assert.deepEqual(parsePencilVersion('highagency.pencildev-1.2.3'), [1, 2, 3]);
  });

  it('returns [0,0,0] for unparseable directory name', () => {
    assert.deepEqual(parsePencilVersion('highagency.pencildev-invalid'), [0, 0, 0]);
  });
});

describe('comparePencilDirs', () => {
  it('sorts 0.6.9 before 0.6.10 (the bug that lexicographic sort gets wrong)', () => {
    const dirs = ['highagency.pencildev-0.6.10-universal', 'highagency.pencildev-0.6.9-universal'];
    dirs.sort(comparePencilDirs);
    assert.equal(dirs[dirs.length - 1], 'highagency.pencildev-0.6.10-universal');
  });

  it('sorts multiple versions correctly', () => {
    const dirs = [
      'highagency.pencildev-0.7.1-universal',
      'highagency.pencildev-0.6.33-universal',
      'highagency.pencildev-1.0.0-universal',
      'highagency.pencildev-0.6.9-universal',
    ];
    dirs.sort(comparePencilDirs);
    assert.deepEqual(dirs, [
      'highagency.pencildev-0.6.9-universal',
      'highagency.pencildev-0.6.33-universal',
      'highagency.pencildev-0.7.1-universal',
      'highagency.pencildev-1.0.0-universal',
    ]);
  });

  it('handles equal versions', () => {
    assert.equal(
      comparePencilDirs('highagency.pencildev-0.6.33-universal', 'highagency.pencildev-0.6.33-universal'),
      0,
    );
  });
});

describe('resolvePencilBinary', () => {
  it('PENCIL_BINARY_SUFFIX must not start with / (deterministic regression guard)', () => {
    assert.ok(
      !PENCIL_BINARY_SUFFIX.startsWith('/'),
      `PENCIL_BINARY_SUFFIX is '${PENCIL_BINARY_SUFFIX}' — leading '/' causes path.resolve() to discard all prefix segments`,
    );
  });

  it('returns a full path under ~/.antigravity/extensions when Pencil is installed', async () => {
    const result = await resolvePencilBinary();
    if (result === null) {
      // No Pencil installation — skip gracefully (CI / environments without Antigravity)
      return;
    }
    assert.ok(
      !result.startsWith('/out/'),
      `resolvePencilBinary() returned '${result}' — looks like PENCIL_BINARY_SUFFIX has a leading '/' that breaks path.resolve()`,
    );
    assert.ok(
      result.includes('.antigravity/extensions'),
      `resolvePencilBinary() should return a path under ~/.antigravity/extensions, got '${result}'`,
    );
    assert.ok(
      result.includes('/out/mcp-server-'),
      `resolvePencilBinary() should include the binary suffix, got '${result}'`,
    );
  });
});

describe('buildCatCafeMcpDescriptor', () => {
  it('builds correct descriptor', () => {
    const desc = buildCatCafeMcpDescriptor('/project');
    assert.equal(desc.name, 'cat-cafe');
    assert.equal(desc.command, 'node');
    assert.ok(desc.args[0].includes('mcp-server/dist/index.js'));
    assert.equal(desc.enabled, true);
    assert.equal(desc.source, 'cat-cafe');
  });
});

// ────────── Bootstrap ──────────

describe('bootstrapCapabilities', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('bootstrap');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates capabilities.json with split cat-cafe servers + externals', async () => {
    // Seed a Claude config with one external server
    const claudeFile = join(dir, '.mcp.json');
    await writeFile(
      claudeFile,
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@mcp/fs'] },
        },
      }),
    );

    const config = await bootstrapCapabilities(dir, {
      claudeConfig: claudeFile,
      codexConfig: join(dir, 'nonexistent.toml'),
      geminiConfig: join(dir, 'nonexistent.json'),
    });

    assert.equal(config.version, 1);
    // cat-cafe split(3) + filesystem
    assert.equal(config.capabilities.length, 4);

    const catCafeCollab = config.capabilities.find((c) => c.id === 'cat-cafe-collab');
    assert.ok(catCafeCollab);
    assert.equal(catCafeCollab.source, 'cat-cafe');
    assert.equal(catCafeCollab.enabled, true);

    const catCafeMemory = config.capabilities.find((c) => c.id === 'cat-cafe-memory');
    assert.ok(catCafeMemory);
    assert.equal(catCafeMemory.source, 'cat-cafe');

    const catCafeSignals = config.capabilities.find((c) => c.id === 'cat-cafe-signals');
    assert.ok(catCafeSignals);
    assert.equal(catCafeSignals.source, 'cat-cafe');

    const fs = config.capabilities.find((c) => c.id === 'filesystem');
    assert.ok(fs);
    assert.equal(fs.source, 'external');

    // Also persisted to disk
    const persisted = await readCapabilitiesConfig(dir);
    assert.ok(persisted);
    assert.equal(persisted.capabilities.length, 4);
  });

  it('skips duplicate cat-cafe from external discovery', async () => {
    const claudeFile = join(dir, '.mcp.json');
    await writeFile(
      claudeFile,
      JSON.stringify({
        mcpServers: {
          'cat-cafe': { command: 'node', args: ['old-path.js'] },
        },
      }),
    );

    const config = await bootstrapCapabilities(dir, {
      claudeConfig: claudeFile,
      codexConfig: join(dir, 'x.toml'),
      geminiConfig: join(dir, 'x.json'),
    });

    // Only split built-ins should exist (legacy cat-cafe external duplicate skipped)
    const catCafeEntries = config.capabilities.filter((c) => c.id === 'cat-cafe');
    assert.equal(catCafeEntries.length, 0);
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-collab'));
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-memory'));
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-signals'));
  });

  it('uses catCafeRepoRoot for cat-cafe MCP descriptor when provided', async () => {
    const claudeFile = join(dir, '.mcp.json');
    await writeFile(claudeFile, JSON.stringify({ mcpServers: {} }));

    const config = await bootstrapCapabilities(
      dir,
      {
        claudeConfig: claudeFile,
        codexConfig: join(dir, 'nonexistent.toml'),
        geminiConfig: join(dir, 'nonexistent.json'),
      },
      { catCafeRepoRoot: '/host-repo' },
    );

    const splitIds = ['cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals'];
    for (const splitId of splitIds) {
      const cap = config.capabilities.find((c) => c.id === splitId);
      assert.ok(cap, `${splitId} should exist after bootstrap`);
      assert.equal(cap.type, 'mcp');
      assert.ok(cap.mcpServer);
      assert.ok(
        cap.mcpServer.args[0].includes('/host-repo'),
        `${splitId} MCP serverPath should be built from catCafeRepoRoot`,
      );
    }
  });
});

describe('migrateLegacyCatCafeCapability', () => {
  it('migrates legacy cat-cafe entry to split server entries and preserves legacy flags', () => {
    const config = makeConfig([
      {
        id: 'cat-cafe',
        type: 'mcp',
        enabled: false,
        source: 'cat-cafe',
        overrides: [{ catId: 'codex', enabled: true }],
        mcpServer: {
          command: 'node',
          args: ['dist/index.js'],
          env: { CAT_CAFE_FOO: 'bar' },
          workingDir: '/tmp/cat-cafe',
        },
      },
      {
        id: 'filesystem',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: { command: 'npx', args: ['-y', '@mcp/fs'] },
      },
    ]);

    const migrated = migrateLegacyCatCafeCapability(config, { projectRoot: '/repo' });
    assert.equal(migrated.migrated, true);
    const collab = migrated.config.capabilities.find((c) => c.id === 'cat-cafe-collab');
    const memory = migrated.config.capabilities.find((c) => c.id === 'cat-cafe-memory');
    const signals = migrated.config.capabilities.find((c) => c.id === 'cat-cafe-signals');
    assert.ok(collab);
    assert.ok(memory);
    assert.ok(signals);
    assert.ok(!migrated.config.capabilities.find((c) => c.id === 'cat-cafe'));
    assert.ok(migrated.config.capabilities.find((c) => c.id === 'filesystem'));

    for (const entry of [collab, memory, signals]) {
      assert.equal(entry?.enabled, false);
      assert.deepEqual(entry?.overrides, [{ catId: 'codex', enabled: true }]);
      assert.deepEqual(entry?.mcpServer?.env, { CAT_CAFE_FOO: 'bar' });
      assert.equal(entry?.mcpServer?.workingDir, '/tmp/cat-cafe');
    }
  });
});

// ────────── Resolve per-cat ──────────

describe('resolveServersForCat', () => {
  it('applies global enabled state', () => {
    const config = makeConfig([
      {
        id: 'cat-cafe',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['index.js'] },
      },
      { id: 'disabled', type: 'mcp', enabled: false, source: 'external', mcpServer: { command: 'echo', args: [] } },
    ]);

    const servers = resolveServersForCat(config, 'opus');
    assert.equal(servers.length, 2);
    assert.equal(servers.find((s) => s.name === 'cat-cafe')?.enabled, true);
    assert.equal(servers.find((s) => s.name === 'disabled')?.enabled, false);
  });

  it('applies per-cat override', () => {
    const config = makeConfig([
      {
        id: 'tool',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: { command: 'echo', args: [] },
        overrides: [{ catId: 'codex', enabled: false }],
      },
    ]);

    // codex has override → disabled
    const codexServers = resolveServersForCat(config, 'codex');
    assert.equal(codexServers[0].enabled, false);

    // opus has no override → uses global (true)
    const opusServers = resolveServersForCat(config, 'opus');
    assert.equal(opusServers[0].enabled, true);
  });

  it('skips skill entries', () => {
    const config = makeConfig([
      { id: 'cat-cafe', type: 'mcp', enabled: true, source: 'cat-cafe', mcpServer: { command: 'node', args: [] } },
      { id: 'some-skill', type: 'skill', enabled: true, source: 'external' },
    ]);

    const servers = resolveServersForCat(config, 'opus');
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'cat-cafe');
  });

  it('preserves env and workingDir', () => {
    const config = makeConfig([
      {
        id: 'tool',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: { command: 'node', args: [], env: { KEY: 'val' }, workingDir: '/tmp' },
      },
    ]);

    const servers = resolveServersForCat(config, 'opus');
    assert.deepEqual(servers[0].env, { KEY: 'val' });
    assert.equal(servers[0].workingDir, '/tmp');
  });

  it('forces commandless entries disabled for cleanup', () => {
    const config = makeConfig([
      { id: 'jetbrains', type: 'mcp', enabled: true, source: 'external', mcpServer: { command: '', args: [] } },
    ]);

    const servers = resolveServersForCat(config, 'opus');
    assert.equal(servers[0].enabled, false);
  });

  it('enables streamableHttp for Anthropic cat, disables for non-Anthropic cat', () => {
    const config = makeConfig([
      {
        id: 'remote-tool',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: {
          command: '',
          args: [],
          transport: 'streamableHttp',
          url: 'https://mcp.example.com/sse',
        },
      },
    ]);

    // opus is anthropic → streamableHttp should be enabled
    const opusServers = resolveServersForCat(config, 'opus');
    assert.equal(opusServers.length, 1);
    assert.equal(opusServers[0].name, 'remote-tool');
    assert.equal(opusServers[0].enabled, true);
    assert.equal(opusServers[0].transport, 'streamableHttp');
    assert.equal(opusServers[0].url, 'https://mcp.example.com/sse');

    // codex is openai → streamableHttp should be disabled
    const codexServers = resolveServersForCat(config, 'codex');
    assert.equal(codexServers.length, 1);
    assert.equal(codexServers[0].name, 'remote-tool');
    assert.equal(codexServers[0].enabled, false);

    // gemini is google → streamableHttp should also be disabled
    const geminiServers = resolveServersForCat(config, 'gemini');
    assert.equal(geminiServers.length, 1);
    assert.equal(geminiServers[0].name, 'remote-tool');
    assert.equal(geminiServers[0].enabled, false);
  });
});

// ────────── Generate CLI configs ──────────

describe('generateCliConfigs', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('gen-cli');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('generates config files for all providers', async () => {
    // Need cats registered for this test
    const hasAnyCats = catRegistry.getAllIds().length > 0;
    if (!hasAnyCats) {
      // Skip if no cats registered (test isolation)
      return;
    }

    const config = makeConfig([
      {
        id: 'cat-cafe',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['server.js'] },
      },
    ]);

    const paths = {
      anthropic: join(dir, '.mcp.json'),
      openai: join(dir, '.codex', 'config.toml'),
      google: join(dir, '.gemini', 'settings.json'),
    };

    await generateCliConfigs(config, paths);

    // At least one config should exist
    let configCount = 0;
    try {
      await readFile(paths.anthropic, 'utf-8');
      configCount++;
    } catch {
      /* ok */
    }
    try {
      await readFile(paths.openai, 'utf-8');
      configCount++;
    } catch {
      /* ok */
    }
    try {
      await readFile(paths.google, 'utf-8');
      configCount++;
    } catch {
      /* ok */
    }

    assert.ok(configCount > 0, 'At least one CLI config should be generated');
  });

  it('removes managed commandless entries from Gemini settings', async () => {
    const hasGoogleCat = catRegistry.getAllIds().some((id) => {
      const entry = catRegistry.tryGet(id);
      return entry?.config.provider === 'google';
    });
    if (!hasGoogleCat) return;

    const paths = {
      anthropic: join(dir, '.mcp.json'),
      openai: join(dir, '.codex', 'config.toml'),
      google: join(dir, '.gemini', 'settings.json'),
    };

    // Seed an existing invalid entry (historical config).
    await mkdir(join(dir, '.gemini'), { recursive: true });
    await writeFile(
      paths.google,
      JSON.stringify({
        mcpServers: {
          jetbrains: { command: '', args: [] },
        },
      }),
    );

    const config = makeConfig([
      { id: 'jetbrains', type: 'mcp', enabled: true, source: 'external', mcpServer: { command: '', args: [] } },
      {
        id: 'cat-cafe-collab',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['collab.js'] },
      },
    ]);

    await generateCliConfigs(config, paths);
    const data = JSON.parse(await readFile(paths.google, 'utf-8'));

    assert.equal(data.mcpServers.jetbrains, undefined, 'invalid managed entry should be removed');
    assert.ok(data.mcpServers['cat-cafe-collab'], 'valid managed entry should remain');
  });

  it('serializes streamableHttp to Claude config and omits it from Codex/Gemini', async () => {
    const hasAnyCats = catRegistry.getAllIds().length > 0;
    if (!hasAnyCats) return;

    const paths = {
      anthropic: join(dir, '.mcp.json'),
      openai: join(dir, '.codex', 'config.toml'),
      google: join(dir, '.gemini', 'settings.json'),
    };

    const config = makeConfig([
      {
        id: 'remote-tool',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: {
          command: '',
          args: [],
          transport: 'streamableHttp',
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: 'Bearer tok' },
        },
      },
    ]);

    await generateCliConfigs(config, paths);

    // Claude config should contain the streamableHttp entry with url
    const claudeData = JSON.parse(await readFile(paths.anthropic, 'utf-8'));
    const remoteTool = claudeData.mcpServers['remote-tool'];
    assert.ok(remoteTool, 'streamableHttp server should be written to Claude config');
    assert.equal(remoteTool.type, 'http');
    assert.equal(remoteTool.url, 'https://mcp.example.com/sse');
    assert.deepEqual(remoteTool.headers, { Authorization: 'Bearer tok' });

    // Codex config should NOT contain the streamableHttp entry
    try {
      const codexRaw = await readFile(paths.openai, 'utf-8');
      assert.ok(!codexRaw.includes('remote-tool'), 'streamableHttp should not appear in Codex config');
    } catch {
      // File may not exist if no openai cats — that's fine
    }

    // Gemini config should NOT contain the streamableHttp entry
    try {
      const geminiData = JSON.parse(await readFile(paths.google, 'utf-8'));
      assert.equal(
        geminiData.mcpServers?.['remote-tool'],
        undefined,
        'streamableHttp should not appear in Gemini config',
      );
    } catch {
      // File may not exist if no google cats — that's fine
    }
  });
});

// ────────── Full orchestrate ──────────

describe('orchestrate', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('orch');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('bootstraps on first run (no capabilities.json)', async () => {
    const config = await orchestrate(
      dir,
      {
        claudeConfig: join(dir, '.mcp.json'),
        codexConfig: join(dir, '.codex', 'config.toml'),
        geminiConfig: join(dir, '.gemini', 'settings.json'),
      },
      {
        anthropic: join(dir, '.mcp.json'),
        openai: join(dir, '.codex', 'config.toml'),
        google: join(dir, '.gemini', 'settings.json'),
      },
    );

    assert.ok(config);
    assert.equal(config.version, 1);
    // At minimum, split cat-cafe MCP servers should be present
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-collab'));
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-memory'));
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-signals'));
  });

  it('uses existing capabilities.json on subsequent runs', async () => {
    // Pre-seed capabilities.json
    await writeCapabilitiesConfig(
      dir,
      makeConfig([
        {
          id: 'custom',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'custom-cmd', args: ['--flag'] },
        },
      ]),
    );

    const config = await orchestrate(
      dir,
      {
        claudeConfig: join(dir, '.mcp.json'),
        codexConfig: join(dir, 'x.toml'),
        geminiConfig: join(dir, 'x.json'),
      },
      {
        anthropic: join(dir, '.mcp.json'),
        openai: join(dir, 'out.toml'),
        google: join(dir, 'out.json'),
      },
    );

    // Should use pre-seeded config, not bootstrap fresh
    assert.equal(config.capabilities.length, 1);
    assert.equal(config.capabilities[0].id, 'custom');
  });
});
