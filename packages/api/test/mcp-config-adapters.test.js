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
  writeAntigravityMcpConfig,
  writeClaudeMcpConfig,
  writeCodexMcpConfig,
  writeGeminiMcpConfig,
  writeKimiMcpConfig,
} from '../dist/config/capabilities/mcp-config-adapters.js';

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `mcp-config-test-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function expectedAntigravityApiUrl() {
  return process.env.CAT_CAFE_API_URL?.trim() || 'http://localhost:3004';
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

// ────────── Writers ──────────

describe('writeClaudeMcpConfig', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('claude-write');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes enabled servers to .mcp.json', async () => {
    const file = join(dir, '.mcp.json');
    await writeClaudeMcpConfig(file, [
      { name: 'cat-cafe', command: 'node', args: ['index.js'], enabled: true, source: 'cat-cafe' },
      { name: 'disabled', command: 'echo', args: [], enabled: false, source: 'external' },
    ]);

    const raw = await readFile(file, 'utf-8');
    const data = JSON.parse(raw);
    // Only enabled servers are written (Claude has no enabled field)
    assert.ok(data.mcpServers['cat-cafe']);
    assert.equal(data.mcpServers.disabled, undefined);
  });

  it('writes env and cwd when present', async () => {
    const file = join(dir, '.mcp.json');
    await writeClaudeMcpConfig(file, [
      {
        name: 'test',
        command: 'node',
        args: [],
        enabled: true,
        source: 'external',
        env: { KEY: 'val' },
        workingDir: '/tmp',
      },
    ]);

    const data = JSON.parse(await readFile(file, 'utf-8'));
    assert.deepEqual(data.mcpServers.test.env, { KEY: 'val' });
    assert.equal(data.mcpServers.test.cwd, '/tmp');
  });

  it('creates parent directories', async () => {
    const file = join(dir, 'sub', 'dir', '.mcp.json');
    await writeClaudeMcpConfig(file, []);
    const raw = await readFile(file, 'utf-8');
    assert.ok(raw.includes('mcpServers'));
  });
});

describe('writeCodexMcpConfig', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('codex-write');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes MCP servers to TOML', async () => {
    const file = join(dir, 'config.toml');
    await writeCodexMcpConfig(file, [
      { name: 'cat_cafe', command: 'node', args: ['index.js'], enabled: true, source: 'cat-cafe' },
      { name: 'disabled', command: 'echo', args: [], enabled: false, source: 'external' },
    ]);

    const raw = await readFile(file, 'utf-8');
    // Both servers written (Codex has enabled field)
    assert.ok(raw.includes('[mcp_servers.cat_cafe]'));
    assert.ok(raw.includes('[mcp_servers.disabled]'));
    assert.ok(raw.includes('enabled = true'));
    assert.ok(raw.includes('enabled = false'));
  });

  it('preserves existing non-MCP config', async () => {
    const file = join(dir, 'config.toml');
    await writeFile(file, '[model]\nname = "gpt-4"\n');

    await writeCodexMcpConfig(file, [{ name: 'test', command: 'echo', args: [], enabled: true, source: 'external' }]);

    const raw = await readFile(file, 'utf-8');
    assert.ok(raw.includes('[model]'));
    assert.ok(raw.includes('name = "gpt-4"'));
    assert.ok(raw.includes('[mcp_servers.test]'));
  });
});

describe('writeGeminiMcpConfig', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('gemini-write');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes enabled servers to settings.json', async () => {
    const file = join(dir, 'settings.json');
    await writeGeminiMcpConfig(file, [
      { name: 'cat-cafe', command: 'node', args: ['index.js'], enabled: true, source: 'cat-cafe' },
      { name: 'disabled', command: 'echo', args: [], enabled: false, source: 'external' },
    ]);

    const data = JSON.parse(await readFile(file, 'utf-8'));
    // Only enabled servers (Gemini has no enabled field)
    assert.ok(data.mcpServers['cat-cafe']);
    assert.equal(data.mcpServers.disabled, undefined);
  });

  it('preserves existing non-MCP settings', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(file, JSON.stringify({ theme: 'dark', mcpServers: {} }));

    await writeGeminiMcpConfig(file, [{ name: 'test', command: 'echo', args: [], enabled: true, source: 'external' }]);

    const data = JSON.parse(await readFile(file, 'utf-8'));
    assert.equal(data.theme, 'dark');
    assert.ok(data.mcpServers.test);
  });

  it('injects callback env placeholders for managed cat-cafe servers', async () => {
    const file = join(dir, 'settings.json');
    await writeGeminiMcpConfig(file, [
      { name: 'cat-cafe-collab', command: 'node', args: ['collab.js'], enabled: true, source: 'cat-cafe' },
    ]);

    const data = JSON.parse(await readFile(file, 'utf-8'));
    assert.deepEqual(data.mcpServers['cat-cafe-collab'].env, {
      CAT_CAFE_API_URL: '${CAT_CAFE_API_URL}',
      CAT_CAFE_INVOCATION_ID: '${CAT_CAFE_INVOCATION_ID}',
      CAT_CAFE_CALLBACK_TOKEN: '${CAT_CAFE_CALLBACK_TOKEN}',
      CAT_CAFE_USER_ID: '${CAT_CAFE_USER_ID}',
      CAT_CAFE_SIGNAL_USER: '${CAT_CAFE_SIGNAL_USER}',
    });
  });

  it('injects callback env placeholders for preserved legacy cat-cafe server', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          'cat-cafe': { command: 'node', args: ['legacy-index.js'] },
        },
      }),
    );

    await writeGeminiMcpConfig(file, [
      { name: 'cat-cafe-collab', command: 'node', args: ['collab.js'], enabled: true, source: 'cat-cafe' },
    ]);

    const data = JSON.parse(await readFile(file, 'utf-8'));
    assert.deepEqual(data.mcpServers['cat-cafe'].env, {
      CAT_CAFE_API_URL: '${CAT_CAFE_API_URL}',
      CAT_CAFE_INVOCATION_ID: '${CAT_CAFE_INVOCATION_ID}',
      CAT_CAFE_CALLBACK_TOKEN: '${CAT_CAFE_CALLBACK_TOKEN}',
      CAT_CAFE_USER_ID: '${CAT_CAFE_USER_ID}',
      CAT_CAFE_SIGNAL_USER: '${CAT_CAFE_SIGNAL_USER}',
    });
  });

  it('keeps project-level pencil entry when a resolved command is available', async () => {
    const file = join(dir, '.gemini', 'settings.json');
    await mkdir(join(dir, '.gemini'), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          pencil: { command: '/old/pencil', args: ['--app', 'antigravity'] },
        },
      }),
    );

    await writeGeminiMcpConfig(file, [
      { name: 'pencil', command: '/new/pencil', args: ['--app', 'antigravity'], enabled: true, source: 'external' },
      { name: 'cat-cafe', command: 'node', args: ['index.js'], enabled: true, source: 'cat-cafe' },
    ]);

    const data = JSON.parse(await readFile(file, 'utf-8'));
    assert.deepEqual(data.mcpServers.pencil, {
      command: '/new/pencil',
      args: ['--app', 'antigravity'],
    });
    assert.ok(data.mcpServers['cat-cafe'], 'cat-cafe server should still be written');
  });
});

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
    assert.deepEqual(raw.mcpServers['cat-cafe'].env, {
      CAT_CAFE_API_URL: '${CAT_CAFE_API_URL}',
      CAT_CAFE_INVOCATION_ID: '${CAT_CAFE_INVOCATION_ID}',
      CAT_CAFE_CALLBACK_TOKEN: '${CAT_CAFE_CALLBACK_TOKEN}',
      CAT_CAFE_USER_ID: '${CAT_CAFE_USER_ID}',
      CAT_CAFE_SIGNAL_USER: '${CAT_CAFE_SIGNAL_USER}',
    });
  });
});

describe('writeAntigravityMcpConfig', () => {
  /** @type {string} */ let dir;
  /** @type {string | undefined} */ let originalAgentKeyFile;
  /** @type {string | undefined} */ let originalAgentKeyFiles;
  /** @type {string | undefined} */ let originalAgentKeySecret;

  beforeEach(async () => {
    dir = await makeTmpDir('antigravity-write');
    originalAgentKeyFile = process.env.CAT_CAFE_AGENT_KEY_FILE;
    originalAgentKeyFiles = process.env.CAT_CAFE_AGENT_KEY_FILES;
    originalAgentKeySecret = process.env.CAT_CAFE_AGENT_KEY_SECRET;
    delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    delete process.env.CAT_CAFE_AGENT_KEY_FILES;
    delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
  });
  afterEach(async () => {
    if (originalAgentKeyFile === undefined) delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    else process.env.CAT_CAFE_AGENT_KEY_FILE = originalAgentKeyFile;
    if (originalAgentKeyFiles === undefined) delete process.env.CAT_CAFE_AGENT_KEY_FILES;
    else process.env.CAT_CAFE_AGENT_KEY_FILES = originalAgentKeyFiles;
    if (originalAgentKeySecret === undefined) delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    else process.env.CAT_CAFE_AGENT_KEY_SECRET = originalAgentKeySecret;
    await rm(dir, { recursive: true, force: true });
  });

  it('injects readonly env for managed cat-cafe servers', async () => {
    const file = join(dir, 'mcp_config.json');
    const originalAwd = process.env.ALLOWED_WORKSPACE_DIRS;
    const originalWsr = process.env.CAT_CAFE_WORKSPACE_ROOT;
    delete process.env.ALLOWED_WORKSPACE_DIRS;
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    try {
      await writeAntigravityMcpConfig(file, [
        { name: 'cat-cafe', command: 'node', args: ['index.js'], enabled: true, source: 'cat-cafe' },
      ]);

      const raw = JSON.parse(await readFile(file, 'utf-8'));
      assert.deepEqual(raw.mcpServers['cat-cafe'].env, {
        CAT_CAFE_API_URL: expectedAntigravityApiUrl(),
        CAT_CAFE_READONLY: 'true',
        ALLOWED_WORKSPACE_DIRS: process.cwd(),
      });
    } finally {
      if (originalAwd === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
      else process.env.ALLOWED_WORKSPACE_DIRS = originalAwd;
      if (originalWsr === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWsr;
    }
  });

  it('passes agent-key sidecar file path to managed cat-cafe servers', async () => {
    const file = join(dir, 'mcp_config.json');
    const keyFile = join(dir, 'agent-key.secret');
    const keyFiles = JSON.stringify({ antigravity: keyFile, 'antig-opus': join(dir, 'antig-opus.secret') });
    const originalKeyFile = process.env.CAT_CAFE_AGENT_KEY_FILE;
    const originalKeyFiles = process.env.CAT_CAFE_AGENT_KEY_FILES;
    try {
      process.env.CAT_CAFE_AGENT_KEY_FILE = keyFile;
      process.env.CAT_CAFE_AGENT_KEY_FILES = keyFiles;
      await writeAntigravityMcpConfig(file, [
        { name: 'cat-cafe-collab', command: 'node', args: ['collab.js'], enabled: true, source: 'cat-cafe' },
      ]);

      const raw = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(
        raw.mcpServers['cat-cafe-collab'].env.CAT_CAFE_AGENT_KEY_FILE,
        keyFile,
        'persistent Antigravity MCP needs the sidecar path so agent-key tools appear in tools/list',
      );
      assert.equal(
        raw.mcpServers['cat-cafe-collab'].env.CAT_CAFE_AGENT_KEY_FILES,
        keyFiles,
        'shared Antigravity MCP needs variant-scoped sidecar file mapping for correct cat identity',
      );
      assert.equal(
        raw.mcpServers['cat-cafe-collab'].env.CAT_CAFE_AGENT_KEY_SECRET,
        undefined,
        'long-lived agent-key secret must not be written directly into mcp_config.json',
      );
    } finally {
      if (originalKeyFile === undefined) delete process.env.CAT_CAFE_AGENT_KEY_FILE;
      else process.env.CAT_CAFE_AGENT_KEY_FILE = originalKeyFile;
      if (originalKeyFiles === undefined) delete process.env.CAT_CAFE_AGENT_KEY_FILES;
      else process.env.CAT_CAFE_AGENT_KEY_FILES = originalKeyFiles;
    }
  });

  it('preserves legacy cat-cafe entry while backfilling readonly env', async () => {
    const file = join(dir, 'mcp_config.json');
    const originalAwd = process.env.ALLOWED_WORKSPACE_DIRS;
    const originalWsr = process.env.CAT_CAFE_WORKSPACE_ROOT;
    delete process.env.ALLOWED_WORKSPACE_DIRS;
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    try {
      await writeFile(
        file,
        JSON.stringify({
          mcpServers: {
            'cat-cafe': { command: 'node', args: ['legacy-index.js'] },
          },
        }),
      );

      await writeAntigravityMcpConfig(file, [
        { name: 'cat-cafe-memory', command: 'node', args: ['memory.js'], enabled: true, source: 'cat-cafe' },
      ]);

      const servers = await readAntigravityMcpConfig(file);
      const legacy = servers.find((s) => s.name === 'cat-cafe');
      assert.ok(legacy);
      assert.deepEqual(legacy.env, {
        CAT_CAFE_API_URL: expectedAntigravityApiUrl(),
        CAT_CAFE_READONLY: 'true',
        ALLOWED_WORKSPACE_DIRS: process.cwd(),
      });
    } finally {
      if (originalAwd === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
      else process.env.ALLOWED_WORKSPACE_DIRS = originalAwd;
      if (originalWsr === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWsr;
    }
  });

  it('forces readonly env keys over legacy antigravity values while preserving unrelated env', async () => {
    const file = join(dir, 'mcp_config.json');
    const originalAwd = process.env.ALLOWED_WORKSPACE_DIRS;
    const originalWsr = process.env.CAT_CAFE_WORKSPACE_ROOT;
    delete process.env.ALLOWED_WORKSPACE_DIRS;
    delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    try {
      await writeFile(
        file,
        JSON.stringify({
          mcpServers: {
            'cat-cafe': {
              command: 'node',
              args: ['legacy-index.js'],
              env: {
                CAT_CAFE_API_URL: 'http://legacy.invalid:9999',
                CAT_CAFE_READONLY: 'false',
                EXTRA_FLAG: 'keep-me',
              },
            },
          },
        }),
      );

      await writeAntigravityMcpConfig(file, [
        { name: 'cat-cafe-memory', command: 'node', args: ['memory.js'], enabled: true, source: 'cat-cafe' },
      ]);

      const raw = JSON.parse(await readFile(file, 'utf-8'));
      assert.deepEqual(raw.mcpServers['cat-cafe'].env, {
        CAT_CAFE_API_URL: expectedAntigravityApiUrl(),
        CAT_CAFE_READONLY: 'true',
        ALLOWED_WORKSPACE_DIRS: process.cwd(),
        EXTRA_FLAG: 'keep-me',
      });
    } finally {
      if (originalAwd === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
      else process.env.ALLOWED_WORKSPACE_DIRS = originalAwd;
      if (originalWsr === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWsr;
    }
  });

  it('F061 Bug-F: respects ALLOWED_WORKSPACE_DIRS env override when set', async () => {
    const file = join(dir, 'mcp_config.json');
    const originalEnv = process.env.ALLOWED_WORKSPACE_DIRS;
    try {
      process.env.ALLOWED_WORKSPACE_DIRS = '/custom/workspace:/another/dir';
      await writeAntigravityMcpConfig(file, [
        { name: 'cat-cafe', command: 'node', args: ['index.js'], enabled: true, source: 'cat-cafe' },
      ]);
      const raw = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(raw.mcpServers['cat-cafe'].env.ALLOWED_WORKSPACE_DIRS, '/custom/workspace:/another/dir');
    } finally {
      if (originalEnv === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
      else process.env.ALLOWED_WORKSPACE_DIRS = originalEnv;
    }
  });

  it('F061 binary/workspace separation: CAT_CAFE_WORKSPACE_ROOT scopes workspace independent of process.cwd', async () => {
    const file = join(dir, 'mcp_config.json');
    const originalAwd = process.env.ALLOWED_WORKSPACE_DIRS;
    const originalWs = process.env.CAT_CAFE_WORKSPACE_ROOT;
    try {
      delete process.env.ALLOWED_WORKSPACE_DIRS;
      process.env.CAT_CAFE_WORKSPACE_ROOT = '/path/to/project';
      await writeAntigravityMcpConfig(file, [
        { name: 'cat-cafe', command: 'node', args: ['/runtime/dist/collab.js'], enabled: true, source: 'cat-cafe' },
      ]);
      const raw = JSON.parse(await readFile(file, 'utf-8'));
      // Workspace env reflects CAT_CAFE_WORKSPACE_ROOT (where Bengal operates)
      assert.equal(
        raw.mcpServers['cat-cafe'].env.ALLOWED_WORKSPACE_DIRS,
        '/path/to/project',
        'ALLOWED_WORKSPACE_DIRS should reflect CAT_CAFE_WORKSPACE_ROOT, not process.cwd()',
      );
      // Binary path stays at whatever the descriptor pointed at (runtime)
      assert.equal(
        raw.mcpServers['cat-cafe'].args[0],
        '/runtime/dist/collab.js',
        'args[0] (binary path) should not be rewritten by workspace env',
      );
    } finally {
      if (originalAwd === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
      else process.env.ALLOWED_WORKSPACE_DIRS = originalAwd;
      if (originalWs === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWs;
    }
  });

  it('F061 binary/workspace separation: ALLOWED_WORKSPACE_DIRS overrides CAT_CAFE_WORKSPACE_ROOT', async () => {
    const file = join(dir, 'mcp_config.json');
    const originalAwd = process.env.ALLOWED_WORKSPACE_DIRS;
    const originalWs = process.env.CAT_CAFE_WORKSPACE_ROOT;
    try {
      // Both set: ALLOWED_WORKSPACE_DIRS wins (highest precedence)
      process.env.ALLOWED_WORKSPACE_DIRS = '/explicit/allowed';
      process.env.CAT_CAFE_WORKSPACE_ROOT = '/should-be-ignored';
      await writeAntigravityMcpConfig(file, [
        { name: 'cat-cafe', command: 'node', args: ['index.js'], enabled: true, source: 'cat-cafe' },
      ]);
      const raw = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(
        raw.mcpServers['cat-cafe'].env.ALLOWED_WORKSPACE_DIRS,
        '/explicit/allowed',
        'ALLOWED_WORKSPACE_DIRS env must take precedence over CAT_CAFE_WORKSPACE_ROOT',
      );
    } finally {
      if (originalAwd === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
      else process.env.ALLOWED_WORKSPACE_DIRS = originalAwd;
      if (originalWs === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWs;
    }
  });

  it('F061 codex P1-2 e2e: runtime mode → args[0] points at runtime dist, env.ALLOWED_WORKSPACE_DIRS points at workspace', async () => {
    // The single end-to-end invariant codex required: when runtime root and
    // workspace root are different (true production runtime config),
    // generated Antigravity config MUST split them. Binary path = runtime
    // dist (where freshly-built code lives), workspace env = active user
    // workspace (where Bengal runs git/ls/cat).
    const file = join(dir, 'mcp_config.json');
    const originalAwd = process.env.ALLOWED_WORKSPACE_DIRS;
    const originalWs = process.env.CAT_CAFE_WORKSPACE_ROOT;
    const originalRuntime = process.env.CAT_CAFE_RUNTIME_ROOT;
    try {
      delete process.env.ALLOWED_WORKSPACE_DIRS;
      // Simulate runtime startup having exported both env vars. Use neutral
      // temp paths so public sync sanitization does not rewrite the assertion.
      const runtimeRoot = join(dir, 'cat-cafe-runtime');
      const workspaceRoot = join(dir, 'cat-cafe-workspace');
      process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
      process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;

      // Descriptors come pre-resolved with runtime dist paths (capability
      // orchestrator's resolveBinaryRoot path). Writer must NOT clobber.
      const runtimeBinary = join(runtimeRoot, 'packages/mcp-server/dist/collab.js');
      await writeAntigravityMcpConfig(file, [
        {
          name: 'cat-cafe-collab',
          command: 'node',
          args: [runtimeBinary],
          enabled: true,
          source: 'cat-cafe',
        },
      ]);

      const raw = JSON.parse(await readFile(file, 'utf-8'));
      const collab = raw.mcpServers['cat-cafe-collab'];

      // Binary = runtime worktree dist (NOT workspace path)
      assert.equal(collab.args[0], runtimeBinary, 'args[0] must point at runtime binary dist, not workspace');
      assert.ok(collab.args[0].startsWith(runtimeRoot), 'binary path must live under runtime root');

      // Workspace = user's active workspace (NOT runtime internals)
      assert.equal(
        collab.env.ALLOWED_WORKSPACE_DIRS,
        workspaceRoot,
        'ALLOWED_WORKSPACE_DIRS must point at user workspace, not runtime internals',
      );
      assert.ok(
        !collab.env.ALLOWED_WORKSPACE_DIRS.includes('cat-cafe-runtime'),
        'workspace env must NOT include runtime worktree path',
      );

      // Security baseline preserved
      assert.equal(collab.env.CAT_CAFE_READONLY, 'true', 'persistent MCP must stay read-only');
    } finally {
      if (originalAwd === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
      else process.env.ALLOWED_WORKSPACE_DIRS = originalAwd;
      if (originalWs === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWs;
      if (originalRuntime === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = originalRuntime;
    }
  });

  it('F061 codex P1-2 merge order: descriptor wins for user-controlled keys, enforced for security/deployment', async () => {
    // Three-tier merge after PR #1414:
    //   - ALLOWED_WORKSPACE_DIRS: user-controlled, descriptor wins
    //   - CAT_CAFE_API_URL: deployment truth, ALWAYS overwritten by current process env
    //   - CAT_CAFE_READONLY: security, ALWAYS 'true'
    const file = join(dir, 'mcp_config.json');
    const originalAwd = process.env.ALLOWED_WORKSPACE_DIRS;
    const originalWs = process.env.CAT_CAFE_WORKSPACE_ROOT;
    try {
      delete process.env.ALLOWED_WORKSPACE_DIRS;
      delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      await writeAntigravityMcpConfig(file, [
        {
          name: 'cat-cafe',
          command: 'node',
          args: ['index.js'],
          enabled: true,
          source: 'cat-cafe',
          env: {
            ALLOWED_WORKSPACE_DIRS: '/user-set/workspace',
            CAT_CAFE_API_URL: 'https://stale.legacy.example.com',
          },
        },
      ]);
      const raw = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(
        raw.mcpServers['cat-cafe'].env.ALLOWED_WORKSPACE_DIRS,
        '/user-set/workspace',
        'user-controlled key: descriptor must win over process.cwd() default',
      );
      assert.equal(
        raw.mcpServers['cat-cafe'].env.CAT_CAFE_API_URL,
        expectedAntigravityApiUrl(),
        'deployment key: enforced env must override stale descriptor URL',
      );
      assert.equal(
        raw.mcpServers['cat-cafe'].env.CAT_CAFE_READONLY,
        'true',
        'security key: CAT_CAFE_READONLY must always be enforced',
      );
    } finally {
      if (originalAwd === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
      else process.env.ALLOWED_WORKSPACE_DIRS = originalAwd;
      if (originalWs === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = originalWs;
    }
  });

  it('F061 codex P1-2 security: descriptor cannot opt out of CAT_CAFE_READONLY', async () => {
    const file = join(dir, 'mcp_config.json');
    const originalAwd = process.env.ALLOWED_WORKSPACE_DIRS;
    try {
      delete process.env.ALLOWED_WORKSPACE_DIRS;
      // Malicious / buggy descriptor tries to disable read-only mode
      await writeAntigravityMcpConfig(file, [
        {
          name: 'cat-cafe',
          command: 'node',
          args: ['index.js'],
          enabled: true,
          source: 'cat-cafe',
          env: { CAT_CAFE_READONLY: 'false' },
        },
      ]);
      const raw = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(
        raw.mcpServers['cat-cafe'].env.CAT_CAFE_READONLY,
        'true',
        'persistent MCP read-only boundary must be hard-enforced regardless of descriptor',
      );
    } finally {
      if (originalAwd === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
      else process.env.ALLOWED_WORKSPACE_DIRS = originalAwd;
    }
  });
});

// ────────── P1-2 Regression: Preserve user's non-managed MCP servers ──────────

describe('P1-2: writers preserve non-managed MCP servers', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('preserve');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writeClaudeMcpConfig preserves user MCP servers not in managed list', async () => {
    const file = join(dir, '.mcp.json');
    // User already has their own MCP servers
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          'user-custom': { command: 'my-server', args: ['--port', '9999'] },
          'cat-cafe': { command: 'node', args: ['old-server.js'] },
        },
      }),
    );

    // Cat Cafe orchestrator writes only managed servers
    await writeClaudeMcpConfig(file, [
      { name: 'cat-cafe', command: 'node', args: ['new-server.js'], enabled: true, source: 'cat-cafe' },
    ]);

    const data = JSON.parse(await readFile(file, 'utf-8'));
    // cat-cafe should be updated
    assert.deepEqual(data.mcpServers['cat-cafe'].args, ['new-server.js']);
    // user-custom should still be there!
    assert.ok(data.mcpServers['user-custom'], 'User MCP server should be preserved');
    assert.equal(data.mcpServers['user-custom'].command, 'my-server');
  });

  it('writeCodexMcpConfig preserves user MCP servers not in managed list', async () => {
    const file = join(dir, 'config.toml');
    await writeFile(
      file,
      `[model]
name = "gpt-4"

[mcp_servers.user_tool]
command = "my-tool"
args = ["--mode", "dev"]
enabled = true

[mcp_servers.cat_cafe]
command = "node"
args = ["old-server.js"]
enabled = true
`,
    );

    await writeCodexMcpConfig(file, [
      { name: 'cat_cafe', command: 'node', args: ['new-server.js'], enabled: true, source: 'cat-cafe' },
    ]);

    const raw = await readFile(file, 'utf-8');
    // cat_cafe updated
    assert.ok(raw.includes('new-server.js'));
    // user_tool preserved
    assert.ok(raw.includes('[mcp_servers.user_tool]'), 'User MCP server should be preserved');
    assert.ok(raw.includes('my-tool'));
    // model section preserved
    assert.ok(raw.includes('[model]'));
  });

  it('writeGeminiMcpConfig preserves user MCP servers not in managed list', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      JSON.stringify({
        theme: 'dark',
        mcpServers: {
          'user-tool': { command: 'my-tool', args: [] },
          'cat-cafe': { command: 'node', args: ['old-server.js'] },
        },
      }),
    );

    await writeGeminiMcpConfig(file, [
      { name: 'cat-cafe', command: 'node', args: ['new-server.js'], enabled: true, source: 'cat-cafe' },
    ]);

    const data = JSON.parse(await readFile(file, 'utf-8'));
    // cat-cafe updated
    assert.deepEqual(data.mcpServers['cat-cafe'].args, ['new-server.js']);
    // user-tool preserved
    assert.ok(data.mcpServers['user-tool'], 'User MCP server should be preserved');
    assert.equal(data.mcpServers['user-tool'].command, 'my-tool');
    // theme preserved
    assert.equal(data.theme, 'dark');
  });
});

// ────────── Stale Override Cleanup (F145 Phase D) ──────────

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

describe('round-trip: read → write → read', () => {
  /** @type {string} */ let dir;

  beforeEach(async () => {
    dir = await makeTmpDir('roundtrip');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('Claude .mcp.json round-trips correctly', async () => {
    const servers = [
      {
        name: 'cat-cafe',
        command: 'node',
        args: ['./mcp/index.js'],
        env: { PORT: '3000' },
        enabled: true,
        source: /** @type {const} */ ('cat-cafe'),
      },
      { name: 'fs', command: 'npx', args: ['-y', '@mcp/fs'], enabled: true, source: /** @type {const} */ ('external') },
    ];

    const file = join(dir, '.mcp.json');
    await writeClaudeMcpConfig(file, servers);
    const roundTripped = await readClaudeMcpConfig(file);

    assert.equal(roundTripped.length, 2);
    assert.equal(roundTripped[0].name, 'cat-cafe');
    assert.equal(roundTripped[0].command, 'node');
    assert.deepEqual(roundTripped[0].env, { PORT: '3000' });
  });

  it('Codex config.toml round-trips correctly', async () => {
    const servers = [
      {
        name: 'cat_cafe',
        command: 'node',
        args: ['index.js'],
        enabled: true,
        source: /** @type {const} */ ('cat-cafe'),
      },
      { name: 'disabled', command: 'echo', args: [], enabled: false, source: /** @type {const} */ ('external') },
    ];

    const file = join(dir, 'config.toml');
    await writeCodexMcpConfig(file, servers);
    const roundTripped = await readCodexMcpConfig(file);

    assert.equal(roundTripped.length, 2);
    const cafe = roundTripped.find((s) => s.name === 'cat_cafe');
    assert.ok(cafe);
    assert.equal(cafe.enabled, true);
    const dis = roundTripped.find((s) => s.name === 'disabled');
    assert.ok(dis);
    assert.equal(dis.enabled, false);
  });

  it('Gemini settings.json round-trips correctly', async () => {
    const servers = [
      {
        name: 'cat-cafe',
        command: 'node',
        args: ['index.js'],
        enabled: true,
        source: /** @type {const} */ ('cat-cafe'),
        workingDir: '/tmp',
      },
    ];

    const file = join(dir, 'settings.json');
    await writeGeminiMcpConfig(file, servers);
    const roundTripped = await readGeminiMcpConfig(file);

    assert.equal(roundTripped.length, 1);
    assert.equal(roundTripped[0].workingDir, '/tmp');
  });
});
