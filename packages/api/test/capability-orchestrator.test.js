// @ts-check

import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import './helpers/setup-cat-registry.js';
import {
  bootstrapCapabilities,
  buildCatCafeMcpDescriptor,
  comparePencilDirs,
  deduplicateDiscoveredMcpServers,
  discoverExternalMcpServers,
  ensureCatCafeMainServer,
  generateCliConfigs,
  migrateLegacyCatCafeCapability,
  migrateResolverBackedCapabilities,
  orchestrate,
  PENCIL_BINARY_SUFFIX,
  parsePencilVersion,
  readCapabilitiesConfig,
  readResolvedMcpState,
  realignManagedCatCafeServerPaths,
  resolveMachineSpecificServers,
  resolvePencilBinary,
  resolvePencilCommand,
  resolveRequiredMcpStatus,
  resolveServersForCat,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';

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

async function writeExecutable(filePath) {
  await writeFile(filePath, '#!/bin/sh\nexit 0\n');
  await chmod(filePath, 0o755);
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

describe('resolveRequiredMcpStatus', () => {
  it('marks missing local artifact args as unresolved', async () => {
    const dir = await makeTmpDir('cap-required-artifact');
    const status = await resolveRequiredMcpStatus('artifact-test', {
      capabilities: makeConfig([
        {
          id: 'artifact-test',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'node', args: ['./missing.json'] },
        },
      ]),
      projectRoot: dir,
    });

    try {
      assert.equal(status.status, 'unresolved');
      assert.equal(status.reason, 'command args reference missing local artifact');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts home-relative command paths when the binary exists', async () => {
    const dir = await makeTmpDir('cap-required-home-command');
    try {
      const homeDir = join(dir, 'home');
      await mkdir(join(homeDir, 'bin'), { recursive: true });
      const commandPath = join(homeDir, 'bin', 'doctor-bin');
      await writeExecutable(commandPath);

      const status = await resolveRequiredMcpStatus('home-command', {
        capabilities: makeConfig([
          {
            id: 'home-command',
            type: 'mcp',
            enabled: true,
            source: 'external',
            mcpServer: { command: '~/bin/doctor-bin', args: [] },
          },
        ]),
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        projectRoot: dir,
      });

      assert.equal(status.status, 'ready');
      assert.match(status.reason, /stdio ~\/bin\/doctor-bin/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not treat slash-bearing package specs as local artifacts', async () => {
    const dir = await makeTmpDir('cap-required-package-spec');
    const status = await resolveRequiredMcpStatus('package-spec', {
      capabilities: makeConfig([
        {
          id: 'package-spec',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'npx', args: ['github:modelcontextprotocol/servers'] },
        },
      ]),
      projectRoot: dir,
    });

    try {
      assert.equal(status.status, 'ready');
      assert.match(status.reason, /stdio npx/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it('returns a full path under a known editor extension root when Pencil is installed', async () => {
    const result = await resolvePencilBinary();
    if (result === null) {
      // No Pencil installation — skip gracefully (CI / environments without Antigravity)
      return;
    }
    const knownRoots = [
      join(homedir(), '.antigravity', 'extensions'),
      join(homedir(), '.vscode', 'extensions'),
      join(homedir(), '.cursor', 'extensions'),
      join(homedir(), '.vscode-insiders', 'extensions'),
    ];
    assert.ok(
      !result.startsWith('/out/'),
      `resolvePencilBinary() returned '${result}' — looks like PENCIL_BINARY_SUFFIX has a leading '/' that breaks path.resolve()`,
    );
    assert.ok(
      knownRoots.some((root) => result === root || result.startsWith(`${root}${sep}`)),
      `resolvePencilBinary() should return a path under a known editor extension root, got '${result}'`,
    );
    assert.ok(
      result.includes('/out/mcp-server-'),
      `resolvePencilBinary() should include the binary suffix, got '${result}'`,
    );
  });

  it('prefers the newest accessible binary across known editor extension dirs', async () => {
    const antigravityDir = join(await makeTmpDir('pencil-ag'), 'extensions');
    const cursorDir = join(await makeTmpDir('pencil-cursor'), 'extensions');
    const vscodeInsidersDir = join(await makeTmpDir('pencil-vsi'), 'extensions');

    await mkdir(join(antigravityDir, 'highagency.pencildev-0.6.40-universal', 'out'), { recursive: true });
    await writeExecutable(join(antigravityDir, 'highagency.pencildev-0.6.40-universal', PENCIL_BINARY_SUFFIX));

    await mkdir(join(cursorDir, 'highagency.pencildev-0.7.1-universal', 'out'), { recursive: true });
    await writeExecutable(join(cursorDir, 'highagency.pencildev-0.7.1-universal', PENCIL_BINARY_SUFFIX));

    // Newer version exists, but the binary is missing. resolvePencilBinary() should
    // skip it and fall back to the newest accessible install instead of returning
    // a broken path.
    await mkdir(join(vscodeInsidersDir, 'highagency.pencildev-1.0.0-universal', 'out'), { recursive: true });

    const result = await resolvePencilBinary({
      antigravityDir,
      cursorDir,
      vscodeInsidersDir,
    });

    assert.equal(
      result,
      join(cursorDir, 'highagency.pencildev-0.7.1-universal', PENCIL_BINARY_SUFFIX),
      'should pick newest accessible binary across Antigravity/Cursor/VSCode Insiders',
    );

    await rm(antigravityDir.replace(/\/extensions$/, ''), { recursive: true, force: true });
    await rm(cursorDir.replace(/\/extensions$/, ''), { recursive: true, force: true });
    await rm(vscodeInsidersDir.replace(/\/extensions$/, ''), { recursive: true, force: true });
  });
});

describe('resolvePencilCommand', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('pencil-resolve');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prefers explicit env override over discovered installations', async () => {
    const antigravityDir = join(dir, 'ag');
    await mkdir(join(antigravityDir, 'highagency.pencildev-0.6.40-universal'), { recursive: true });
    const explicitBin = join(dir, 'custom-pencil-bin');
    await writeExecutable(explicitBin);

    const resolved = await resolvePencilCommand({
      env: { PENCIL_MCP_BIN: explicitBin, PENCIL_MCP_APP: 'vscode' },
      antigravityDir,
      vscodeDir: join(dir, 'vscode'),
    });

    assert.deepEqual(resolved, {
      command: explicitBin,
      args: ['--app', 'vscode'],
    });
  });

  it('falls back to VS Code when Antigravity is unavailable', async () => {
    const vscodeDir = join(dir, '.vscode', 'extensions');
    await mkdir(join(vscodeDir, 'highagency.pencildev-0.6.41-universal', 'out'), { recursive: true });
    await writeExecutable(join(vscodeDir, 'highagency.pencildev-0.6.41-universal', PENCIL_BINARY_SUFFIX));

    const resolved = await resolvePencilCommand({
      antigravityDir: join(dir, 'missing-ag'),
      vscodeDir,
    });

    assert.ok(resolved);
    assert.ok(resolved.command.includes('.vscode/extensions'));
    assert.deepEqual(resolved.args, ['--app', 'vscode']);
  });

  it('prefers Antigravity over VS Code when both have the same version', async () => {
    const antigravityDir = join(dir, 'ag');
    const vscodeDir = join(dir, 'vsc');
    // Both have 0.6.40 — Antigravity as -universal suffix, VS Code without
    await mkdir(join(antigravityDir, 'highagency.pencildev-0.6.40-universal', 'out'), { recursive: true });
    await writeExecutable(join(antigravityDir, 'highagency.pencildev-0.6.40-universal', PENCIL_BINARY_SUFFIX));
    await mkdir(join(vscodeDir, 'highagency.pencildev-0.6.40', 'out'), { recursive: true });
    await writeExecutable(join(vscodeDir, 'highagency.pencildev-0.6.40', PENCIL_BINARY_SUFFIX));

    const resolved = await resolvePencilCommand({
      antigravityDir,
      vscodeDir,
      cursorDir: join(dir, 'cursor-empty'),
      vscodeInsidersDir: join(dir, 'insiders-empty'),
    });

    assert.ok(resolved);
    assert.ok(resolved.command.includes('ag'), `expected Antigravity path, got: ${resolved.command}`);
    assert.deepEqual(resolved.args, ['--app', 'antigravity']);
  });

  it('respects PENCIL_MCP_APP env to filter candidates (without PENCIL_MCP_BIN)', async () => {
    const antigravityDir = join(dir, 'ag');
    const vscodeDir = join(dir, 'vsc');
    // Antigravity has older version, VS Code has newer — but env says prefer antigravity
    await mkdir(join(antigravityDir, 'highagency.pencildev-0.6.39-universal', 'out'), { recursive: true });
    await writeExecutable(join(antigravityDir, 'highagency.pencildev-0.6.39-universal', PENCIL_BINARY_SUFFIX));
    await mkdir(join(vscodeDir, 'highagency.pencildev-0.6.40', 'out'), { recursive: true });
    await writeExecutable(join(vscodeDir, 'highagency.pencildev-0.6.40', PENCIL_BINARY_SUFFIX));

    const resolved = await resolvePencilCommand({
      env: { PENCIL_MCP_APP: 'antigravity' },
      antigravityDir,
      vscodeDir,
      cursorDir: join(dir, 'cursor-empty'),
      vscodeInsidersDir: join(dir, 'insiders-empty'),
    });

    assert.ok(resolved);
    assert.ok(resolved.command.includes('ag'), `expected Antigravity path, got: ${resolved.command}`);
    assert.deepEqual(resolved.args, ['--app', 'antigravity']);
  });

  it('normalizes PENCIL_MCP_APP aliases (vscode-insiders → vscode)', async () => {
    const antigravityDir = join(dir, 'ag');
    const vscodeDir = join(dir, 'vsc');
    // Both have same version — env says vscode-insiders (alias for vscode)
    await mkdir(join(antigravityDir, 'highagency.pencildev-0.6.40-universal', 'out'), { recursive: true });
    await writeExecutable(join(antigravityDir, 'highagency.pencildev-0.6.40-universal', PENCIL_BINARY_SUFFIX));
    await mkdir(join(vscodeDir, 'highagency.pencildev-0.6.40', 'out'), { recursive: true });
    await writeExecutable(join(vscodeDir, 'highagency.pencildev-0.6.40', PENCIL_BINARY_SUFFIX));

    const resolved = await resolvePencilCommand({
      env: { PENCIL_MCP_APP: 'vscode-insiders' },
      antigravityDir,
      vscodeDir,
      cursorDir: join(dir, 'cursor-empty'),
      vscodeInsidersDir: join(dir, 'insiders-empty'),
    });

    assert.ok(resolved);
    assert.ok(resolved.command.includes('vsc'), `expected VS Code path, got: ${resolved.command}`);
    assert.deepEqual(resolved.args, ['--app', 'vscode']);
  });

  it('PENCIL_MCP_APP falls back to any candidate if preferred app has no installations', async () => {
    const vscodeDir = join(dir, 'vsc');
    await mkdir(join(vscodeDir, 'highagency.pencildev-0.6.40', 'out'), { recursive: true });
    await writeExecutable(join(vscodeDir, 'highagency.pencildev-0.6.40', PENCIL_BINARY_SUFFIX));

    const resolved = await resolvePencilCommand({
      env: { PENCIL_MCP_APP: 'antigravity' },
      antigravityDir: join(dir, 'ag-empty'),
      vscodeDir,
      cursorDir: join(dir, 'cursor-empty'),
      vscodeInsidersDir: join(dir, 'insiders-empty'),
    });

    assert.ok(resolved, 'should fall back to VS Code when Antigravity is empty');
    assert.deepEqual(resolved.args, ['--app', 'vscode']);
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
    // cat-cafe main(1) + split(3) + filesystem
    assert.equal(config.capabilities.length, 5);

    const catCafeMain = config.capabilities.find((c) => c.id === 'cat-cafe');
    assert.ok(catCafeMain);
    assert.equal(catCafeMain.source, 'cat-cafe');
    assert.equal(catCafeMain.enabled, true);

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
    assert.equal(persisted.capabilities.length, 5);
  });

  it('normalizes pencil into a resolver-backed capability on bootstrap', async () => {
    const claudeFile = join(dir, '.mcp.json');
    await writeFile(
      claudeFile,
      JSON.stringify({
        mcpServers: {
          pencil: {
            command: '/home/user/mcp-server-darwin-arm64',
            args: ['--app', 'antigravity'],
          },
        },
      }),
    );

    const config = await bootstrapCapabilities(dir, {
      claudeConfig: claudeFile,
      codexConfig: join(dir, 'nonexistent.toml'),
      geminiConfig: join(dir, 'nonexistent.json'),
    });

    const pencil = config.capabilities.find((c) => c.id === 'pencil');
    assert.ok(pencil);
    assert.equal(pencil.mcpServer?.resolver, 'pencil');
    assert.equal(pencil.mcpServer?.command, '');
    assert.deepEqual(pencil.mcpServer?.args, []);
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

    // Builtin cat-cafe main + splits; external duplicate skipped
    const catCafeEntries = config.capabilities.filter((c) => c.id === 'cat-cafe');
    assert.equal(catCafeEntries.length, 1);
    assert.equal(catCafeEntries[0].source, 'cat-cafe');
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-collab'));
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-memory'));
    assert.ok(config.capabilities.find((c) => c.id === 'cat-cafe-signals'));
  });

  it('uses catCafeRepoRoot for cat-cafe MCP descriptor when provided', async () => {
    const claudeFile = join(dir, '.mcp.json');
    await writeFile(claudeFile, JSON.stringify({ mcpServers: {} }));
    const origRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
    delete process.env.CAT_CAFE_RUNTIME_ROOT;
    try {
      const config = await bootstrapCapabilities(
        dir,
        {
          claudeConfig: claudeFile,
          codexConfig: join(dir, 'nonexistent.toml'),
          geminiConfig: join(dir, 'nonexistent.json'),
        },
        { catCafeRepoRoot: '/host-repo' },
      );

      const allIds = ['cat-cafe', 'cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals'];
      for (const id of allIds) {
        const cap = config.capabilities.find((c) => c.id === id);
        assert.ok(cap, `${id} should exist after bootstrap`);
        assert.equal(cap.type, 'mcp');
        assert.ok(cap.mcpServer);
        assert.ok(
          cap.mcpServer.args[0].includes('/host-repo'),
          `${id} MCP serverPath should be built from catCafeRepoRoot`,
        );
      }
    } finally {
      if (origRuntimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = origRuntimeRoot;
    }
  });

  it('F061 binary/workspace separation: CAT_CAFE_RUNTIME_ROOT env builds binary paths when no explicit opts', async () => {
    const claudeFile = join(dir, '.mcp.json');
    await writeFile(claudeFile, JSON.stringify({ mcpServers: {} }));
    const originalRuntime = process.env.CAT_CAFE_RUNTIME_ROOT;
    try {
      process.env.CAT_CAFE_RUNTIME_ROOT = '/path/to/project-runtime';
      // No catCafeRepoRoot opt — env should drive resolution. The first
      // positional arg (`projectRoot`) is the workspace project's API root,
      // which the orchestrator must NOT use as the binary root anymore.
      const config = await bootstrapCapabilities(dir, {
        claudeConfig: claudeFile,
        codexConfig: join(dir, 'nonexistent.toml'),
        geminiConfig: join(dir, 'nonexistent.json'),
      });

      const splits = ['cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals'];
      for (const id of splits) {
        const cap = config.capabilities.find((c) => c.id === id);
        assert.ok(cap, `${id} should exist`);
        assert.ok(
          cap.mcpServer?.args[0].startsWith('/path/to/project-runtime/'),
          `${id} args[0] should resolve under CAT_CAFE_RUNTIME_ROOT, got ${cap.mcpServer?.args[0]}`,
        );
        assert.ok(!cap.mcpServer?.args[0].includes(dir), `${id} args[0] must NOT use the projectRoot positional arg`);
      }
    } finally {
      if (originalRuntime === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = originalRuntime;
    }
  });

  it('F061 binary/workspace separation: CAT_CAFE_RUNTIME_ROOT env overrides explicit opts (codex PR #1414 P1-1)', async () => {
    // Production route shape: routes/capabilities.ts always passes
    // catCafeRepoRoot from resolveMainRepoPath() (canonical main repo, first
    // git worktree). When API actually runs from cat-cafe-runtime worktree,
    // that explicit opt is auto-detected and STALE — env must win so MCP
    // config points at fresh runtime dist instead of stale main dist.
    const claudeFile = join(dir, '.mcp.json');
    await writeFile(claudeFile, JSON.stringify({ mcpServers: {} }));
    const originalRuntime = process.env.CAT_CAFE_RUNTIME_ROOT;
    try {
      process.env.CAT_CAFE_RUNTIME_ROOT = '/runtime-binary';
      const config = await bootstrapCapabilities(
        dir,
        {
          claudeConfig: claudeFile,
          codexConfig: join(dir, 'nonexistent.toml'),
          geminiConfig: join(dir, 'nonexistent.json'),
        },
        // simulates `routes/capabilities.ts:426` calling resolveMainRepoPath()
        { catCafeRepoRoot: '/stale-main-from-resolveMainRepoPath' },
      );

      const collab = config.capabilities.find((c) => c.id === 'cat-cafe-collab');
      assert.ok(
        collab?.mcpServer?.args[0].startsWith('/runtime-binary/'),
        `expected runtime path to win, got ${collab?.mcpServer?.args[0]}`,
      );
      assert.ok(
        !collab?.mcpServer?.args[0].includes('/stale-main-from-resolveMainRepoPath'),
        'CAT_CAFE_RUNTIME_ROOT must override the auto-detected explicit opt',
      );
    } finally {
      if (originalRuntime === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = originalRuntime;
    }
  });

  it('F061 binary/workspace separation: explicit opts still used when env is unset (dev mode)', async () => {
    const claudeFile = join(dir, '.mcp.json');
    await writeFile(claudeFile, JSON.stringify({ mcpServers: {} }));
    const originalRuntime = process.env.CAT_CAFE_RUNTIME_ROOT;
    try {
      delete process.env.CAT_CAFE_RUNTIME_ROOT;
      const config = await bootstrapCapabilities(
        dir,
        {
          claudeConfig: claudeFile,
          codexConfig: join(dir, 'nonexistent.toml'),
          geminiConfig: join(dir, 'nonexistent.json'),
        },
        { catCafeRepoRoot: '/dev-main-repo' },
      );

      const collab = config.capabilities.find((c) => c.id === 'cat-cafe-collab');
      assert.ok(
        collab?.mcpServer?.args[0].startsWith('/dev-main-repo/'),
        `dev mode: explicit opt should win when env unset, got ${collab?.mcpServer?.args[0]}`,
      );
    } finally {
      if (originalRuntime === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = originalRuntime;
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

describe('migrateResolverBackedCapabilities', () => {
  it('rewrites pencil paths into a resolver-backed declarative entry', () => {
    const config = makeConfig([
      {
        id: 'pencil',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: {
          command: '/home/user/mcp-server-darwin-arm64',
          args: ['--app', 'antigravity'],
        },
      },
    ]);

    const migrated = migrateResolverBackedCapabilities(config);
    assert.equal(migrated.migrated, true);
    assert.deepEqual(migrated.config.capabilities[0].mcpServer, {
      command: '',
      args: [],
      resolver: 'pencil',
    });
  });
});

// ────────── ensureCatCafeMainServer (F145 Phase C AC-C3) ──────────

describe('ensureCatCafeMainServer', () => {
  it('adds cat-cafe main server when splits exist but main is missing', () => {
    const config = makeConfig([
      {
        id: 'cat-cafe-collab',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['collab.js'] },
      },
      {
        id: 'cat-cafe-memory',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['memory.js'] },
      },
      {
        id: 'cat-cafe-signals',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['signals.js'] },
      },
    ]);

    const result = ensureCatCafeMainServer(config, { projectRoot: '/repo' });
    assert.equal(result.migrated, true);
    const main = result.config.capabilities.find((c) => c.id === 'cat-cafe');
    assert.ok(main);
    assert.equal(main.type, 'mcp');
    assert.equal(main.source, 'cat-cafe');
    assert.ok(main.mcpServer?.args[0].includes('index.js'));
  });

  it('inserts main server before first split server', () => {
    const config = makeConfig([
      {
        id: 'filesystem',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: { command: 'npx', args: ['@mcp/fs'] },
      },
      {
        id: 'cat-cafe-signals',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['signals.js'] },
      },
    ]);

    const result = ensureCatCafeMainServer(config, { projectRoot: '/repo' });
    assert.equal(result.migrated, true);
    assert.equal(result.config.capabilities[0].id, 'filesystem');
    assert.equal(result.config.capabilities[1].id, 'cat-cafe');
    assert.equal(result.config.capabilities[2].id, 'cat-cafe-signals');
  });

  it('no-op when main server already exists', () => {
    const config = makeConfig([
      {
        id: 'cat-cafe',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['index.js'] },
      },
      {
        id: 'cat-cafe-collab',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['collab.js'] },
      },
    ]);

    const result = ensureCatCafeMainServer(config, { projectRoot: '/repo' });
    assert.equal(result.migrated, false);
  });

  it('no-op when no split servers exist', () => {
    const config = makeConfig([
      {
        id: 'filesystem',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: { command: 'npx', args: ['@mcp/fs'] },
      },
    ]);

    const result = ensureCatCafeMainServer(config, { projectRoot: '/repo' });
    assert.equal(result.migrated, false);
  });

  it('falls back to process.cwd() for binary root when no opts (codex PR #1396 R3)', () => {
    const origRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
    delete process.env.CAT_CAFE_RUNTIME_ROOT;
    try {
      const config = makeConfig([
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['collab.js'] },
        },
      ]);

      const result = ensureCatCafeMainServer(config);
      assert.equal(result.migrated, true, 'ensure should add main server using cwd fallback');
      const main = result.config.capabilities.find((c) => c.id === 'cat-cafe');
      assert.ok(main?.mcpServer?.args[0].startsWith(process.cwd()));
    } finally {
      if (origRuntimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = origRuntimeRoot;
    }
  });

  it('inherits disabled + overrides + env from split servers (R1 regression)', () => {
    const config = makeConfig([
      {
        id: 'cat-cafe-collab',
        type: 'mcp',
        enabled: false,
        source: 'cat-cafe',
        overrides: [{ catId: 'codex', enabled: true }],
        mcpServer: {
          command: 'node',
          args: ['collab.js'],
          env: { CAT_CAFE_FOO: 'bar' },
          workingDir: '/tmp/cat-cafe',
        },
      },
      {
        id: 'cat-cafe-memory',
        type: 'mcp',
        enabled: false,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['memory.js'] },
      },
    ]);

    const result = ensureCatCafeMainServer(config, { projectRoot: '/repo' });
    assert.equal(result.migrated, true);
    const main = result.config.capabilities.find((c) => c.id === 'cat-cafe');
    assert.ok(main);
    assert.equal(main.enabled, false, 'must inherit disabled state');
    assert.deepEqual(main.overrides, [{ catId: 'codex', enabled: true }]);
    assert.deepEqual(main.mcpServer?.env, { CAT_CAFE_FOO: 'bar' });
    assert.equal(main.mcpServer?.workingDir, '/tmp/cat-cafe');
  });

  it('uses catCafeRepoRoot for main server path', () => {
    const origRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
    delete process.env.CAT_CAFE_RUNTIME_ROOT;
    try {
      const config = makeConfig([
        {
          id: 'cat-cafe-memory',
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['memory.js'] },
        },
      ]);

      const result = ensureCatCafeMainServer(config, {
        catCafeRepoRoot: '/custom-root',
      });
      assert.equal(result.migrated, true);
      const main = result.config.capabilities.find((c) => c.id === 'cat-cafe');
      assert.ok(main);
      assert.ok(main.mcpServer?.args[0].includes('/custom-root'));
    } finally {
      if (origRuntimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = origRuntimeRoot;
    }
  });

  it('realigns managed cat-cafe server paths to stable repo root', () => {
    const origRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
    delete process.env.CAT_CAFE_RUNTIME_ROOT;
    try {
      const config = makeConfig([
        {
          id: 'cat-cafe',
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['/tmp/deleted-worktree/packages/mcp-server/dist/index.js'] },
        },
        {
          id: 'cat-cafe-memory',
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          mcpServer: { command: 'node', args: ['/tmp/deleted-worktree/packages/mcp-server/dist/memory.js'] },
        },
        {
          id: 'external-tool',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'echo', args: ['ok'] },
        },
      ]);

      const result = realignManagedCatCafeServerPaths(config, { catCafeRepoRoot: '/stable-root' });
      assert.equal(result.migrated, true);
      const main = result.config.capabilities.find((c) => c.id === 'cat-cafe');
      const memory = result.config.capabilities.find((c) => c.id === 'cat-cafe-memory');
      const external = result.config.capabilities.find((c) => c.id === 'external-tool');
      assert.ok(main?.mcpServer?.args[0].includes('/stable-root/packages/mcp-server/dist/index.js'));
      assert.ok(memory?.mcpServer?.args[0].includes('/stable-root/packages/mcp-server/dist/memory.js'));
      assert.deepEqual(external?.mcpServer?.args, ['ok']);
    } finally {
      if (origRuntimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = origRuntimeRoot;
    }
  });

  it('F061 binary/workspace separation: realign activates from CAT_CAFE_RUNTIME_ROOT env alone (no opts)', () => {
    const config = makeConfig([
      {
        id: 'cat-cafe-collab',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['/main-repo/packages/mcp-server/dist/collab.js'] },
      },
    ]);
    const originalRuntime = process.env.CAT_CAFE_RUNTIME_ROOT;
    try {
      process.env.CAT_CAFE_RUNTIME_ROOT = '/runtime-worktree';
      // No opts at all — env alone should activate realignment so runtime
      // startup gets fresh dist paths even when the caller has no projectRoot.
      const result = realignManagedCatCafeServerPaths(config);
      assert.equal(result.migrated, true, 'env-only realign should migrate');
      const collab = result.config.capabilities.find((c) => c.id === 'cat-cafe-collab');
      assert.ok(
        collab?.mcpServer?.args[0].includes('/runtime-worktree/packages/mcp-server/dist/collab.js'),
        `expected runtime path, got ${collab?.mcpServer?.args[0]}`,
      );
    } finally {
      if (originalRuntime === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = originalRuntime;
    }
  });

  it('F061 binary/workspace separation: realign no-op when neither env nor opts provided', () => {
    const config = makeConfig([
      {
        id: 'cat-cafe-collab',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['/main-repo/packages/mcp-server/dist/collab.js'] },
      },
    ]);
    const originalRuntime = process.env.CAT_CAFE_RUNTIME_ROOT;
    try {
      delete process.env.CAT_CAFE_RUNTIME_ROOT;
      // Without env and without opts, realign should preserve original paths
      // (no inference from process.cwd — that would clobber valid paths).
      const result = realignManagedCatCafeServerPaths(config);
      assert.equal(result.migrated, false, 'no env + no opts should be a no-op');
      const collab = result.config.capabilities.find((c) => c.id === 'cat-cafe-collab');
      assert.equal(
        collab?.mcpServer?.args[0],
        '/main-repo/packages/mcp-server/dist/collab.js',
        'paths should not be rewritten without explicit signal',
      );
    } finally {
      if (originalRuntime === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = originalRuntime;
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

  it('treats resolver-backed stdio MCPs as transport-usable before local resolution', () => {
    const config = makeConfig([
      {
        id: 'pencil',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: { command: '', args: [], resolver: 'pencil' },
      },
    ]);

    const servers = resolveServersForCat(config, 'opus');
    assert.equal(servers[0].enabled, true);
    assert.equal(servers[0].resolver, 'pencil');
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
      return entry?.config.clientId === 'google';
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

  it('writes Antigravity global MCP config with readonly cat-cafe env', async () => {
    if (!catRegistry.has('antigravity')) {
      catRegistry.register('antigravity', {
        id: 'antigravity',
        name: '孟加拉猫',
        displayName: '孟加拉猫',
        avatar: '/avatars/antigravity.png',
        color: { primary: '#D4853A', secondary: '#FAEBDB' },
        mentionPatterns: ['@antigravity'],
        clientId: 'antigravity',
        defaultModel: 'gemini-3.1-pro',
        mcpSupport: true,
        roleDescription: 'bridge cat',
        personality: 'steady',
      });
    }
    const paths = {
      anthropic: join(dir, '.mcp.json'),
      openai: join(dir, '.codex', 'config.toml'),
      google: join(dir, '.gemini', 'settings.json'),
      antigravity: join(dir, '.gemini', 'antigravity', 'mcp_config.json'),
    };

    const config = makeConfig([
      {
        id: 'cat-cafe-collab',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: ['collab.js'] },
      },
    ]);

    const originalAwd = process.env.ALLOWED_WORKSPACE_DIRS;
    const originalWsr = process.env.CAT_CAFE_WORKSPACE_ROOT;
    const originalAgentKeyFile = process.env.CAT_CAFE_AGENT_KEY_FILE;
    const originalAgentKeyFiles = process.env.CAT_CAFE_AGENT_KEY_FILES;
    const originalAgentKeySecret = process.env.CAT_CAFE_AGENT_KEY_SECRET;
    delete process.env.ALLOWED_WORKSPACE_DIRS;
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    delete process.env.CAT_CAFE_AGENT_KEY_FILES;
    delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    try {
      await generateCliConfigs(config, paths);
      const data = JSON.parse(await readFile(paths.antigravity, 'utf-8'));

      assert.deepEqual(data.mcpServers['cat-cafe-collab'].env, {
        CAT_CAFE_API_URL: process.env.CAT_CAFE_API_URL?.trim() || 'http://localhost:3004',
        CAT_CAFE_READONLY: 'true',
        ALLOWED_WORKSPACE_DIRS: process.cwd(),
      });
    } finally {
      if (originalAwd === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
      else process.env.ALLOWED_WORKSPACE_DIRS = originalAwd;
      if (originalWsr === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWsr;
      if (originalAgentKeyFile === undefined) delete process.env.CAT_CAFE_AGENT_KEY_FILE;
      else process.env.CAT_CAFE_AGENT_KEY_FILE = originalAgentKeyFile;
      if (originalAgentKeyFiles === undefined) delete process.env.CAT_CAFE_AGENT_KEY_FILES;
      else process.env.CAT_CAFE_AGENT_KEY_FILES = originalAgentKeyFiles;
      if (originalAgentKeySecret === undefined) delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
      else process.env.CAT_CAFE_AGENT_KEY_SECRET = originalAgentKeySecret;
    }
  });

  it('resolves pencil from env override and records resolved state', async () => {
    const hasAnyCats = catRegistry.getAllIds().length > 0;
    if (!hasAnyCats) return;

    const paths = {
      anthropic: join(dir, '.mcp.json'),
      openai: join(dir, '.codex', 'config.toml'),
      google: join(dir, '.gemini', 'settings.json'),
    };

    const config = makeConfig([
      {
        id: 'pencil',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: { command: '', args: [], resolver: 'pencil' },
      },
    ]);

    const originalEnv = process.env.PENCIL_MCP_BIN;
    const originalApp = process.env.PENCIL_MCP_APP;
    const explicitBin = join(dir, 'custom-pencil');
    await writeExecutable(explicitBin);
    process.env.PENCIL_MCP_BIN = explicitBin;
    process.env.PENCIL_MCP_APP = 'vscode';
    try {
      await generateCliConfigs(config, paths);
    } finally {
      if (originalEnv === undefined) delete process.env.PENCIL_MCP_BIN;
      else process.env.PENCIL_MCP_BIN = originalEnv;
      if (originalApp === undefined) delete process.env.PENCIL_MCP_APP;
      else process.env.PENCIL_MCP_APP = originalApp;
    }

    const codexRaw = await readFile(paths.openai, 'utf-8');
    assert.ok(codexRaw.includes(explicitBin));
    assert.ok(codexRaw.includes('vscode'));

    const resolvedState = await readResolvedMcpState(dir);
    assert.deepEqual(resolvedState.pencil, {
      resolver: 'pencil',
      status: 'resolved',
      command: explicitBin,
      args: ['--app', 'vscode'],
    });
  });

  it('does not write unresolved pencil entries into CLI configs', async () => {
    const hasAnyCats = catRegistry.getAllIds().length > 0;
    if (!hasAnyCats) return;

    const paths = {
      anthropic: join(dir, '.mcp.json'),
      openai: join(dir, '.codex', 'config.toml'),
      google: join(dir, '.gemini', 'settings.json'),
    };

    const config = makeConfig([
      {
        id: 'pencil',
        type: 'mcp',
        enabled: true,
        source: 'external',
        mcpServer: { command: '', args: [], resolver: 'pencil' },
      },
    ]);

    const originalEnv = process.env.PENCIL_MCP_BIN;
    const originalApp = process.env.PENCIL_MCP_APP;
    process.env.PENCIL_MCP_BIN = join(dir, 'missing-pencil');
    delete process.env.PENCIL_MCP_APP;
    try {
      await generateCliConfigs(config, paths);
    } finally {
      if (originalEnv !== undefined) process.env.PENCIL_MCP_BIN = originalEnv;
      if (originalApp !== undefined) process.env.PENCIL_MCP_APP = originalApp;
    }

    const claudeData = JSON.parse(await readFile(paths.anthropic, 'utf-8'));
    assert.equal(claudeData.mcpServers?.pencil, undefined);

    const codexRaw = await readFile(paths.openai, 'utf-8');
    assert.ok(!codexRaw.includes('[mcp_servers.pencil]'));

    const geminiData = JSON.parse(await readFile(paths.google, 'utf-8'));
    assert.equal(geminiData.mcpServers?.pencil, undefined);

    const resolvedState = await readResolvedMcpState(dir);
    assert.deepEqual(resolvedState.pencil, {
      resolver: 'pencil',
      status: 'unresolved',
    });
  });

  it('resolves pencil once and reuses the result across providers', async () => {
    /** @type {import('@cat-cafe/shared').McpServerDescriptor[]} */
    const anthro = [{ name: 'pencil', command: '', args: [], enabled: true, source: 'external', resolver: 'pencil' }];
    /** @type {import('@cat-cafe/shared').McpServerDescriptor[]} */
    const openai = [{ name: 'pencil', command: '', args: [], enabled: true, source: 'external', resolver: 'pencil' }];
    /** @type {import('@cat-cafe/shared').McpServerDescriptor[]} */
    const google = [{ name: 'pencil', command: '', args: [], enabled: true, source: 'external', resolver: 'pencil' }];

    let calls = 0;
    await resolveMachineSpecificServers(
      {
        anthropic: anthro,
        openai,
        google,
      },
      {
        projectRoot: dir,
        resolvePencilCommandFn: async () => {
          calls += 1;
          return { command: '/tmp/pencil-bin', args: ['--app', 'vscode'] };
        },
      },
    );

    assert.equal(calls, 1);
    for (const providerServers of [anthro, openai, google]) {
      assert.equal(providerServers[0].command, '/tmp/pencil-bin');
      assert.deepEqual(providerServers[0].args, ['--app', 'vscode']);
      assert.equal(providerServers[0].enabled, true);
    }

    const resolvedState = await readResolvedMcpState(dir);
    assert.deepEqual(resolvedState.pencil, {
      resolver: 'pencil',
      status: 'resolved',
      command: '/tmp/pencil-bin',
      args: ['--app', 'vscode'],
    });
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

  it('migrates existing pencil paths to resolver-backed capabilities on subsequent runs', async () => {
    await writeCapabilitiesConfig(
      dir,
      makeConfig([
        {
          id: 'pencil',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            command: '/home/user/mcp-server-darwin-arm64',
            args: ['--app', 'antigravity'],
          },
        },
      ]),
    );

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

    const pencil = config.capabilities.find((c) => c.id === 'pencil');
    assert.ok(pencil);
    assert.equal(pencil.mcpServer?.resolver, 'pencil');
    assert.equal(pencil.mcpServer?.command, '');
    assert.deepEqual(pencil.mcpServer?.args, []);
  });
});
