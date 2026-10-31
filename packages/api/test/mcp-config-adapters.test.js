// @ts-check

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  cleanStaleClaudeProjectOverrides,
  readAntigravityMcpConfig,
  readClaudeMcpConfig,
  readCodexMcpConfig,
  readGeminiMcpConfig,
  readKimiMcpConfig,
  writeKimiMcpConfig,
  writeOpenCodeMcpConfig,
} from '../dist/config/capabilities/mcp-config-adapters.js';

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `mcp-config-test-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ────────── Readers ──────────

describe('readClaudeMcpConfig', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('claude-read');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses standard .mcp.json', async () => {
    const file = join(dir, '.mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          'cat-cafe': { command: 'node', args: ['./mcp/index.js'], env: { PORT: '3000' } },
          filesystem: { command: 'npx', args: ['-y', '@mcp/fs'] },
        },
      }),
    );

    const result = await readClaudeMcpConfig(file);
    assert.equal(result.length, 2);

    const cafe = result.find((s) => s.name === 'cat-cafe');
    assert.ok(cafe);
    assert.equal(cafe.command, 'node');
    assert.deepEqual(cafe.args, ['./mcp/index.js']);
    assert.deepEqual(cafe.env, { PORT: '3000' });
    assert.equal(cafe.enabled, true);
    assert.equal(cafe.source, 'external');
  });

  it('returns empty for missing file', async () => {
    const result = await readClaudeMcpConfig(join(dir, 'nonexistent.json'));
    assert.deepEqual(result, []);
  });

  it('returns empty for invalid JSON', async () => {
    const file = join(dir, 'bad.json');
    await writeFile(file, 'not json');
    const result = await readClaudeMcpConfig(file);
    assert.deepEqual(result, []);
  });

  it('returns empty when mcpServers key missing', async () => {
    const file = join(dir, 'no-key.json');
    await writeFile(file, JSON.stringify({ other: 'stuff' }));
    const result = await readClaudeMcpConfig(file);
    assert.deepEqual(result, []);
  });

  it('reads cwd as workingDir', async () => {
    const file = join(dir, 'cwd.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: { test: { command: 'echo', args: [], cwd: '/tmp/work' } },
      }),
    );
    const result = await readClaudeMcpConfig(file);
    assert.equal(result[0].workingDir, '/tmp/work');
  });
});

describe('readCodexMcpConfig', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('codex-read');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses .codex/config.toml with MCP servers', async () => {
    const file = join(dir, 'config.toml');
    await writeFile(
      file,
      `
[mcp_servers.cat_cafe]
command = "node"
args = ["./mcp/index.js"]
enabled = true

[mcp_servers.disabled_server]
command = "echo"
args = ["hello"]
enabled = false
`,
    );

    const result = await readCodexMcpConfig(file);
    assert.equal(result.length, 2);

    const cafe = result.find((s) => s.name === 'cat_cafe');
    assert.ok(cafe);
    assert.equal(cafe.command, 'node');
    assert.equal(cafe.enabled, true);

    const disabled = result.find((s) => s.name === 'disabled_server');
    assert.ok(disabled);
    assert.equal(disabled.enabled, false);
  });

  it('returns empty for missing file', async () => {
    const result = await readCodexMcpConfig(join(dir, 'nonexistent.toml'));
    assert.deepEqual(result, []);
  });

  it('returns empty for invalid TOML', async () => {
    const file = join(dir, 'bad.toml');
    await writeFile(file, '[[[[not valid toml');
    const result = await readCodexMcpConfig(file);
    assert.deepEqual(result, []);
  });

  it('returns empty when mcp_servers key missing', async () => {
    const file = join(dir, 'no-mcp.toml');
    await writeFile(file, '[model]\nname = "gpt-4"');
    const result = await readCodexMcpConfig(file);
    assert.deepEqual(result, []);
  });

  it('defaults enabled to true when omitted', async () => {
    const file = join(dir, 'no-enabled.toml');
    await writeFile(
      file,
      `
[mcp_servers.test]
command = "echo"
args = []
`,
    );
    const result = await readCodexMcpConfig(file);
    assert.equal(result[0].enabled, true);
  });

  it('reads env as string record', async () => {
    const file = join(dir, 'with-env.toml');
    await writeFile(
      file,
      `
[mcp_servers.test]
command = "node"
args = ["index.js"]

[mcp_servers.test.env]
API_KEY = "secret"
PORT = "8080"
`,
    );
    const result = await readCodexMcpConfig(file);
    assert.deepEqual(result[0].env, { API_KEY: 'secret', PORT: '8080' });
  });
});

describe('readGeminiMcpConfig', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('gemini-read');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses .gemini/settings.json', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          'cat-cafe': { command: 'node', args: ['./mcp/index.js'] },
        },
        otherSetting: true,
      }),
    );

    const result = await readGeminiMcpConfig(file);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'cat-cafe');
    assert.equal(result[0].command, 'node');
  });

  it('returns empty for missing file', async () => {
    const result = await readGeminiMcpConfig(join(dir, 'nonexistent.json'));
    assert.deepEqual(result, []);
  });

  it('reads cwd as workingDir', async () => {
    const file = join(dir, 'cwd.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: { test: { command: 'echo', args: [], cwd: '/work' } },
      }),
    );
    const result = await readGeminiMcpConfig(file);
    assert.equal(result[0].workingDir, '/work');
  });
});

describe('readKimiMcpConfig', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('kimi-read');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses ~/.kimi/mcp.json compatible config', async () => {
    const file = join(dir, 'mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          context7: {
            url: 'https://mcp.context7.com/mcp',
            headers: { CONTEXT7_API_KEY: 'test-key' },
          },
          filesystem: {
            command: 'npx',
            args: ['-y', '@mcp/fs'],
            env: { DEBUG: '1' },
          },
        },
      }),
    );

    const result = await readKimiMcpConfig(file);
    assert.equal(result.length, 2);
    const remote = result.find((server) => server.name === 'context7');
    assert.equal(remote?.transport, 'streamableHttp');
    assert.equal(remote?.url, 'https://mcp.context7.com/mcp');
    assert.deepEqual(remote?.headers, { CONTEXT7_API_KEY: 'test-key' });
  });
});

describe('readAntigravityMcpConfig', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('antigravity-read');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses serverUrl remote entries as streamableHttp transport', async () => {
    const file = join(dir, 'mcp_config.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          remote_docs: {
            serverUrl: 'https://mcp.example.com/remote',
            headers: { Authorization: 'Bearer token' },
          },
        },
      }),
    );

    const result = await readAntigravityMcpConfig(file);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, 'remote_docs');
    assert.equal(result[0]?.transport, 'streamableHttp');
    assert.equal(result[0]?.url, 'https://mcp.example.com/remote');
    assert.deepEqual(result[0]?.headers, { Authorization: 'Bearer token' });
  });
});

// readOpenCodeMcpConfig removed — had zero production callers (OpenCode
// config is built at invoke time via opencode-config-template.ts, not read
// back via this adapter). See commit for cleanup rationale.

// ────────── Writers ──────────
// NOTE: writeClaudeMcpConfig and writeCodexMcpConfig were removed — Claude and
// Codex use invoke-time CLI injection, so persistent file writers were dead code.

describe('writeKimiMcpConfig', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('kimi-write');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes stdio and http MCP servers in kimi format', async () => {
    const file = join(dir, 'mcp.json');
    await writeKimiMcpConfig(file, [
      {
        name: 'context7',
        command: '',
        args: [],
        enabled: true,
        source: 'external',
        transport: 'streamableHttp',
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: 'test-key' },
      },
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@mcp/fs'],
        enabled: true,
        source: 'external',
        env: { DEBUG: '1' },
      },
    ]);

    const raw = JSON.parse(await readFile(file, 'utf-8'));
    assert.deepEqual(raw.mcpServers.context7, {
      url: 'https://mcp.context7.com/mcp',
      headers: { CONTEXT7_API_KEY: 'test-key' },
    });
    assert.deepEqual(raw.mcpServers.filesystem, {
      command: 'npx',
      args: ['-y', '@mcp/fs'],
      env: { DEBUG: '1' },
    });
  });

  it('injects cat-cafe callback env placeholders for kimi cat-cafe servers', async () => {
    const file = join(dir, 'mcp.json');
    await writeKimiMcpConfig(file, [
      {
        name: 'cat-cafe',
        command: 'node',
        args: ['index.js'],
        enabled: true,
        source: 'cat-cafe',
      },
    ]);

    const raw = JSON.parse(await readFile(file, 'utf-8'));
    const kimiEnv = raw.mcpServers['cat-cafe'].env;
    assert.equal(kimiEnv.CAT_CAFE_API_URL, '${CAT_CAFE_API_URL}');
    assert.equal(kimiEnv.CAT_CAFE_INVOCATION_ID, '${CAT_CAFE_INVOCATION_ID}');
    assert.equal(kimiEnv.CAT_CAFE_CALLBACK_TOKEN, '${CAT_CAFE_CALLBACK_TOKEN}');
    assert.equal(kimiEnv.CAT_CAFE_USER_ID, '${CAT_CAFE_USER_ID}');
    assert.equal(kimiEnv.CAT_CAFE_CAT_ID, '${CAT_CAFE_CAT_ID}');
    assert.equal(kimiEnv.CAT_CAFE_THREAD_ID, '${CAT_CAFE_THREAD_ID}');
    assert.equal(kimiEnv.CAT_CAFE_SIGNAL_USER, '${CAT_CAFE_SIGNAL_USER}');
  });

  // F213 Phase B: L5 cleanup applied to Kimi writer (.kimi/mcp.json).

  it('F213: removes echoLegacyShim cat-cafe entry from kimi config', async () => {
    const file = join(dir, 'mcp.json');
    await writeFile(file, JSON.stringify({ mcpServers: { 'cat-cafe': { command: 'echo', args: ['legacy-shim'] } } }));
    await writeKimiMcpConfig(file, []);
    const data = JSON.parse(await readFile(file, 'utf-8'));
    assert.equal(data.mcpServers['cat-cafe'], undefined);
  });

  it('F213: preserves fork-like cat-cafe entry in kimi config (砚砚 P1 regression guard)', async () => {
    const file = join(dir, 'mcp.json');
    const forkPath = '/home/user/cat-cafe/packages/mcp-server/dist/index.js';
    await writeFile(file, JSON.stringify({ mcpServers: { 'cat-cafe': { command: 'node', args: [forkPath] } } }));
    await writeKimiMcpConfig(file, []);
    const data = JSON.parse(await readFile(file, 'utf-8'));
    assert.ok(data.mcpServers['cat-cafe']);
    assert.equal(data.mcpServers['cat-cafe'].args[0], forkPath);
  });

  it('F213: preserves third-party cat-cafe entry in kimi config', async () => {
    const file = join(dir, 'mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: { 'cat-cafe': { command: '/opt/third-party/cat-cafe-server', args: ['main.js'] } },
      }),
    );
    await writeKimiMcpConfig(file, []);
    const data = JSON.parse(await readFile(file, 'utf-8'));
    assert.ok(data.mcpServers['cat-cafe']);
    assert.equal(data.mcpServers['cat-cafe'].command, '/opt/third-party/cat-cafe-server');
  });

  it('F213: is no-op when no legacy cat-cafe entry in kimi config', async () => {
    const file = join(dir, 'mcp.json');
    await writeFile(
      file,
      JSON.stringify({ mcpServers: { 'unrelated-tool': { command: 'node', args: ['other.js'] } } }),
    );
    await writeKimiMcpConfig(file, []);
    const data = JSON.parse(await readFile(file, 'utf-8'));
    assert.ok(data.mcpServers['unrelated-tool']);
    assert.equal(data.mcpServers['cat-cafe'], undefined);
  });
});

describe('writeOpenCodeMcpConfig', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('opencode-write');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes stdio and remote MCP servers in OpenCode format', async () => {
    const file = join(dir, 'opencode.json');
    await writeOpenCodeMcpConfig(file, [
      {
        name: 'context7',
        command: '',
        args: [],
        enabled: true,
        source: 'external',
        transport: 'streamableHttp',
        url: 'https://mcp.context7.com/mcp',
        headers: { Authorization: 'Bearer test-token' },
      },
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@mcp/fs'],
        enabled: true,
        source: 'external',
        env: { DEBUG: '1' },
      },
    ]);

    const raw = JSON.parse(await readFile(file, 'utf-8'));
    assert.deepEqual(raw.mcp.context7, {
      type: 'remote',
      url: 'https://mcp.context7.com/mcp',
      enabled: true,
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.deepEqual(raw.mcp.filesystem, {
      type: 'local',
      command: ['npx', '-y', '@mcp/fs'],
      environment: { DEBUG: '1' },
    });
  });
});

describe('cleanStaleClaudeProjectOverrides', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('stale-override');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes resolver-managed server from per-project mcpServers', async () => {
    const file = join(dir, '.claude.json');
    await writeFile(
      file,
      JSON.stringify({
        projects: {
          '/home/user/my-project': {
            mcpServers: {
              pencil: { command: '/old/pencil', args: ['--app', 'antigravity'] },
              xiaohongshu: { command: 'npx', args: ['mcp-remote'] },
            },
          },
        },
      }),
    );

    const cleaned = await cleanStaleClaudeProjectOverrides(file, '/home/user/my-project', ['pencil']);

    const data = JSON.parse(await readFile(file, 'utf-8'));
    assert.equal(data.projects['/home/user/my-project'].mcpServers.pencil, undefined);
    assert.ok(data.projects['/home/user/my-project'].mcpServers.xiaohongshu);
    assert.deepEqual(cleaned, ['pencil']);
  });

  it('leaves global mcpServers untouched', async () => {
    const file = join(dir, '.claude.json');
    await writeFile(
      file,
      JSON.stringify({
        projects: {
          '/my/project': {
            mcpServers: { pencil: { command: '/proj/pencil' } },
          },
        },
        mcpServers: {
          pencil: { command: '/global/pencil' },
        },
      }),
    );

    const cleaned = await cleanStaleClaudeProjectOverrides(file, '/my/project', ['pencil']);

    const data = JSON.parse(await readFile(file, 'utf-8'));
    // Per-project cleaned
    assert.equal(data.projects['/my/project'].mcpServers.pencil, undefined);
    // Global preserved — lower priority than .mcp.json, may serve other projects
    assert.ok(data.mcpServers.pencil, 'global mcpServers should be preserved');
    assert.equal(data.mcpServers.pencil.command, '/global/pencil');
    assert.deepEqual(cleaned, ['pencil']);
  });

  it('returns empty array when no matching entries found', async () => {
    const file = join(dir, '.claude.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: { jetbrains: { type: 'sse' } },
      }),
    );

    const cleaned = await cleanStaleClaudeProjectOverrides(file, '/any', ['pencil']);
    assert.deepEqual(cleaned, []);

    // File should not be rewritten
    const raw = await readFile(file, 'utf-8');
    assert.ok(!raw.includes('\n'), 'file should remain compact (not rewritten)');
  });

  it('does not modify non-resolver-backed servers', async () => {
    const file = join(dir, '.claude.json');
    await writeFile(
      file,
      JSON.stringify({
        projects: {
          '/my/project': {
            mcpServers: {
              pencil: { command: '/old/pencil' },
              xiaohongshu: { command: 'npx', args: ['mcp-remote'] },
              jetbrains: { type: 'sse', url: 'http://localhost:64342/sse' },
            },
          },
        },
      }),
    );

    await cleanStaleClaudeProjectOverrides(file, '/my/project', ['pencil']);

    const data = JSON.parse(await readFile(file, 'utf-8'));
    assert.ok(data.projects['/my/project'].mcpServers.xiaohongshu);
    assert.ok(data.projects['/my/project'].mcpServers.jetbrains);
  });

  it('handles missing file gracefully', async () => {
    const cleaned = await cleanStaleClaudeProjectOverrides(join(dir, 'nonexistent.json'), '/any', ['pencil']);
    assert.deepEqual(cleaned, []);
  });

  it('handles malformed JSON gracefully', async () => {
    const file = join(dir, '.claude.json');
    await writeFile(file, 'not valid json');
    const cleaned = await cleanStaleClaudeProjectOverrides(file, '/any', ['pencil']);
    assert.deepEqual(cleaned, []);
  });
});

// ────────── Round-trip tests ──────────
