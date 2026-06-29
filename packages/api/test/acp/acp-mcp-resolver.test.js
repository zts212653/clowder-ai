/**
 * acp-mcp-resolver — unit tests for MCP whitelist → AcpMcpServer resolution.
 * #712: Phase 2 externals now read from capabilities.json (not .mcp.json).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const { resolveAcpMcpServers, resolveDisabledServerIds, resolveUserProjectMcpServers, summarizeAcpMcpServers } =
  await import('../../dist/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js');

function toCapabilities(serverMap) {
  return {
    version: 1,
    capabilities: Object.entries(serverMap).map(([name, config]) => ({
      id: name,
      type: 'mcp',
      enabled: true,
      source: 'external',
      mcpServer: config,
    })),
  };
}

function makeTempDir(temps, { capabilities, mcpJson } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-mcp-'));
  temps.push(dir);
  if (capabilities !== undefined) {
    mkdirSync(join(dir, '.cat-cafe'), { recursive: true });
    writeFileSync(join(dir, '.cat-cafe', 'capabilities.json'), JSON.stringify(capabilities));
  }
  if (mcpJson !== undefined) {
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify(mcpJson));
  }
  return dir;
}

describe('resolveAcpMcpServers', () => {
  const temps = [];
  const makeTempRoot = (opts) => makeTempDir(temps, opts);

  afterEach(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
    temps.length = 0;
  });

  it('keeps MCP servers empty when member-level mcpSupport is disabled', async () => {
    const root = makeTempRoot(); // no .mcp.json
    const result = await resolveAcpMcpServers(root, [], undefined, { mcpSupport: false });
    assert.deepStrictEqual(result, []);
  });

  it('returns [] for empty whitelist', async () => {
    const result = await resolveAcpMcpServers('/nonexistent', []);
    assert.deepStrictEqual(result, []);
  });

  it('#712: resolves external whitelist entries from capabilities.json', async () => {
    const root = makeTempRoot({
      capabilities: toCapabilities({
        pencil: { command: 'node', args: ['pencil.js'] },
        playwright: { command: 'npx', args: ['@playwright/mcp'], env: { FOO: 'bar' } },
      }),
    });

    const result = await resolveAcpMcpServers(root, ['pencil', 'playwright']);
    assert.equal(result.length, 2);

    assert.deepStrictEqual(result[0], {
      name: 'pencil',
      command: 'node',
      args: ['pencil.js'],
      env: [],
    });
    assert.deepStrictEqual(result[1], {
      name: 'playwright',
      command: 'npx',
      args: ['@playwright/mcp'],
      env: [{ name: 'FOO', value: 'bar' }],
    });
  });

  it('resolves external stdio command and args against capability workingDir', async () => {
    const root = makeTempRoot({
      capabilities: toCapabilities({
        'repo-tool': {
          command: './server.sh',
          args: ['--config', 'config.json', '--flag'],
          workingDir: 'tools/mcp',
        },
      }),
    });
    const toolDir = join(root, 'tools', 'mcp');
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(join(toolDir, 'server.sh'), '#!/bin/sh\n');
    writeFileSync(join(toolDir, 'config.json'), '{}\n');

    const result = await resolveAcpMcpServers(root, ['repo-tool']);

    assert.equal(result.length, 1);
    assert.equal(result[0].command, join(toolDir, 'server.sh'));
    assert.deepStrictEqual(result[0].args, ['--config', join(toolDir, 'config.json'), '--flag']);
  });

  it('skips missing external entries but returns the rest (builtins + found externals)', async () => {
    const root = makeTempRoot({
      capabilities: toCapabilities({
        pencil: { command: 'node', args: ['pencil.js'] },
      }),
    });

    const result = await resolveAcpMcpServers(root, ['cat-cafe-collab', 'pencil', 'nonexistent']);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'cat-cafe-collab');
    assert.equal(result[1].name, 'pencil');
  });

  it('throws when ALL external whitelist entries are missing (zero resolved)', async () => {
    const root = makeTempRoot({
      capabilities: toCapabilities({
        unrelated: { command: 'x' },
      }),
    });

    await assert.rejects(
      () => resolveAcpMcpServers(root, ['missing-a', 'missing-b']),
      /All 2 MCP whitelist entries.*missing/,
    );
  });

  it('throws when capabilities.json is missing and external servers requested', async () => {
    const root = makeTempRoot(); // no capabilities.json

    await assert.rejects(() => resolveAcpMcpServers(root, ['pencil']), /MCP whitelist entries.*missing/);
  });

  it('throws when capabilities.json has invalid version and external servers requested', async () => {
    const root = makeTempRoot({
      capabilities: { version: 999, capabilities: [] },
    });

    await assert.rejects(() => resolveAcpMcpServers(root, ['pencil']), /MCP whitelist entries.*missing/);
  });

  it('#712: resolves streamableHttp externals as AcpMcpServerHttp', async () => {
    const root = makeTempRoot({
      capabilities: toCapabilities({
        'remote-api': {
          transport: 'streamableHttp',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer tok' },
        },
      }),
    });

    const result = await resolveAcpMcpServers(root, ['remote-api']);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'http');
    assert.equal(result[0].url, 'https://api.example.com/mcp');
    assert.deepStrictEqual(result[0].headers, [{ name: 'Authorization', value: 'Bearer tok' }]);
  });
});

describe('summarizeAcpMcpServers', () => {
  it('redacts auth-like env values in debug summaries', () => {
    const summary = summarizeAcpMcpServers([
      {
        name: 'external-auth',
        command: 'node',
        args: ['server.js'],
        env: [
          { name: 'AUTHORIZATION', value: 'Bearer secret' },
          { name: 'BEARER', value: 'token secret' },
          { name: 'COOKIE', value: 'session=secret' },
          { name: 'SESSION_ID', value: 'session-secret' },
          { name: 'SAFE_FLAG', value: '1' },
        ],
      },
    ]);

    assert.deepStrictEqual(summary.servers[0].env, [
      { name: 'AUTHORIZATION', value: '***' },
      { name: 'BEARER', value: '***' },
      { name: 'COOKIE', value: '***' },
      { name: 'SESSION_ID', value: '***' },
      { name: 'SAFE_FLAG', value: '1' },
    ]);
  });
});

describe('resolveAcpMcpServers — builtin auto-provision (F145 Phase C)', () => {
  const temps = [];
  const makeTempRoot = (opts) => makeTempDir(temps, opts);

  afterEach(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
    temps.length = 0;
  });

  it('expands legacy "cat-cafe" monolith to all split servers (#712)', async () => {
    const root = makeTempRoot();
    const result = await resolveAcpMcpServers(root, ['cat-cafe']);

    assert.equal(result.length, 6, 'monolith expands to 6 split servers');
    const names = new Set(result.map((s) => s.name));
    assert.ok(names.has('cat-cafe-collab'));
    assert.ok(names.has('cat-cafe-memory'));
    assert.ok(names.has('cat-cafe-signals'));
    assert.ok(names.has('cat-cafe-limb'));
    assert.ok(names.has('cat-cafe-audio'));
    assert.ok(names.has('cat-cafe-finance'));
  });

  it('auto-generates cat-cafe-collab from projectRoot', async () => {
    const root = makeTempRoot();
    const result = await resolveAcpMcpServers(root, ['cat-cafe-collab']);

    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'cat-cafe-collab');
    assert.equal(result[0].command, process.execPath);
    assert.ok(result[0].args[0].endsWith('packages/mcp-server/dist/collab.js'));
  });

  it('auto-generates cat-cafe-limb from projectRoot', async () => {
    const root = makeTempRoot();
    const result = await resolveAcpMcpServers(root, ['cat-cafe-limb']);

    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'cat-cafe-limb');
    assert.equal(result[0].command, process.execPath);
    assert.ok(result[0].args[0].endsWith('packages/mcp-server/dist/limb.js'));
  });

  it('auto-generates cat-cafe-audio from projectRoot (F195)', async () => {
    const root = makeTempRoot();
    const result = await resolveAcpMcpServers(root, ['cat-cafe-audio']);

    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'cat-cafe-audio');
    assert.equal(result[0].command, process.execPath);
    assert.ok(result[0].args[0].endsWith('packages/mcp-server/dist/audio.js'));
  });

  it('auto-generates cat-cafe-finance from projectRoot (F207 Phase B0)', async () => {
    const root = makeTempRoot();
    const result = await resolveAcpMcpServers(root, ['cat-cafe-finance']);

    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'cat-cafe-finance');
    assert.equal(result[0].command, process.execPath);
    assert.ok(result[0].args[0].endsWith('packages/mcp-server/dist/finance.js'));
  });

  it('auto-generates all canonical 6-split builtins (F193/F195/F207)', async () => {
    const root = makeTempRoot();
    const result = await resolveAcpMcpServers(root, [
      'cat-cafe-collab',
      'cat-cafe-memory',
      'cat-cafe-signals',
      'cat-cafe-limb',
      'cat-cafe-audio',
      'cat-cafe-finance',
    ]);

    assert.equal(result.length, 6);
    const names = result.map((s) => s.name);
    assert.deepStrictEqual(names, [
      'cat-cafe-collab',
      'cat-cafe-memory',
      'cat-cafe-signals',
      'cat-cafe-limb',
      'cat-cafe-audio',
      'cat-cafe-finance',
    ]);

    const entrypoints = result.map((s) => s.args[0].split('/').pop());
    assert.deepStrictEqual(entrypoints, ['collab.js', 'memory.js', 'signals.js', 'limb.js', 'audio.js', 'finance.js']);
  });

  it('deduplicates when whitelist has both monolith and split names (#712)', async () => {
    const root = makeTempRoot();
    const result = await resolveAcpMcpServers(root, [
      'cat-cafe',
      'cat-cafe-collab',
      'cat-cafe-memory',
      'cat-cafe-signals',
    ]);

    assert.equal(result.length, 6, 'monolith expands but dedupes with explicit splits');
    const names = new Set(result.map((s) => s.name));
    assert.ok(names.has('cat-cafe-collab'));
    assert.ok(names.has('cat-cafe-memory'));
    assert.ok(names.has('cat-cafe-signals'));
    assert.ok(names.has('cat-cafe-limb'), 'limb added from monolith expansion');
    assert.ok(names.has('cat-cafe-audio'), 'audio added from monolith expansion');
  });

  it('#712: resolves non-builtin servers from capabilities.json', async () => {
    const root = makeTempRoot({
      capabilities: toCapabilities({
        pencil: { command: 'node', args: ['/path/to/pencil'] },
      }),
    });

    const result = await resolveAcpMcpServers(root, ['cat-cafe-collab', 'pencil']);
    assert.equal(result.length, 2);

    const collab = result.find((s) => s.name === 'cat-cafe-collab');
    assert.ok(collab.args[0].endsWith('packages/mcp-server/dist/collab.js'), 'builtin auto-generated');

    const pencil = result.find((s) => s.name === 'pencil');
    assert.deepStrictEqual(pencil.args, ['/path/to/pencil'], 'external from capabilities.json');
  });

  it('does not throw when capabilities.json missing and only builtins requested', async () => {
    const root = makeTempRoot();
    const result = await resolveAcpMcpServers(root, ['cat-cafe-collab', 'cat-cafe-memory']);
    assert.equal(result.length, 2);
  });

  it('builtin servers have empty env (callbackEnv injected later by acp-session-env)', async () => {
    const root = makeTempRoot();
    const result = await resolveAcpMcpServers(root, ['cat-cafe-collab']);
    assert.deepStrictEqual(result[0].env, []);
  });

  it('does not treat typo cat-cafe-collabb as builtin (P1 fail-fast)', async () => {
    const root = makeTempRoot();
    await assert.rejects(() => resolveAcpMcpServers(root, ['cat-cafe-collabb']), /MCP whitelist entries.*missing/);
  });

  it('does not treat cat-cafeteria as builtin', async () => {
    const root = makeTempRoot({
      capabilities: toCapabilities({
        'cat-cafeteria': { command: 'node', args: ['cafeteria.js'] },
      }),
    });

    const result = await resolveAcpMcpServers(root, ['cat-cafeteria']);
    assert.equal(result[0].name, 'cat-cafeteria');
    assert.deepStrictEqual(result[0].args, ['cafeteria.js']);
  });
});

describe('resolveAcpMcpServers — per-project MCP (F145 Phase E)', () => {
  const temps = [];
  const makeTempRoot = (opts) => makeTempDir(temps, opts);

  afterEach(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
    temps.length = 0;
  });

  // AC-E1: accepts userProjectRoot, reads user project .mcp.json
  it('merges user project .mcp.json servers when userProjectRoot provided', async () => {
    const projectRoot = makeTempRoot();
    const userRoot = makeTempRoot({
      mcpJson: {
        mcpServers: {
          'my-database': { command: 'node', args: ['db-mcp.js'] },
          'my-docker': { command: 'docker', args: ['mcp'], env: { DOCKER_HOST: 'unix:///var/run/docker.sock' } },
        },
      },
    });

    const result = await resolveAcpMcpServers(projectRoot, ['cat-cafe-collab'], userRoot);
    assert.equal(result.length, 3); // 1 builtin + 2 user project
    assert.equal(result[0].name, 'cat-cafe-collab'); // builtin first

    const db = result.find((s) => s.name === 'my-database');
    assert.ok(db, 'user project server my-database should be included');
    assert.equal(db.command, 'node');
    assert.deepStrictEqual(db.args, ['db-mcp.js']);

    const docker = result.find((s) => s.name === 'my-docker');
    assert.ok(docker, 'user project server my-docker should be included');
    assert.deepStrictEqual(docker.env, [{ name: 'DOCKER_HOST', value: 'unix:///var/run/docker.sock' }]);
  });

  // AC-E3: builtin cat-cafe-* takes priority over same-name user project server
  it('builtin cat-cafe-* takes priority over same-name user project server', async () => {
    const projectRoot = makeTempRoot();
    const userRoot = makeTempRoot({
      mcpJson: {
        mcpServers: {
          'cat-cafe-collab': { command: 'python', args: ['fake.py'] },
          'cat-cafe': { command: 'python', args: ['legacy-monolith.py'] },
          'my-tool': { command: 'node', args: ['tool.js'] },
        },
      },
    });

    const result = await resolveAcpMcpServers(projectRoot, ['cat-cafe-collab'], userRoot);
    const collab = result.find((s) => s.name === 'cat-cafe-collab');
    assert.equal(collab.command, process.execPath); // builtin runtime Node, not python
    assert.ok(collab.args[0].endsWith('packages/mcp-server/dist/collab.js'));
    assert.ok(!result.some((s) => s.name === 'cat-cafe'), 'legacy monolith alias must not merge with split builtin');
    assert.ok(
      result.find((s) => s.name === 'my-tool'),
      'non-conflicting user server still included',
    );
  });

  it('legacy cat-cafe alias expansion excludes same-name user project server', async () => {
    const projectRoot = makeTempRoot();
    const userRoot = makeTempRoot({
      mcpJson: {
        mcpServers: {
          'cat-cafe': { command: 'python', args: ['legacy-monolith.py'] },
          'my-tool': { command: 'node', args: ['tool.js'] },
        },
      },
    });

    const result = await resolveAcpMcpServers(projectRoot, ['cat-cafe'], userRoot);
    const names = new Set(result.map((s) => s.name));

    assert.ok(names.has('cat-cafe-collab'), 'legacy alias should still expand to split builtins');
    assert.ok(!names.has('cat-cafe'), 'legacy user project alias must not merge alongside split builtins');
    assert.ok(names.has('my-tool'), 'non-conflicting user server still included');
  });

  // AC-E3: whitelist external > user project for same name
  it('whitelist external server takes priority over same-name user project server', async () => {
    const projectRoot = makeTempRoot({
      capabilities: toCapabilities({
        pencil: { command: 'node', args: ['/correct/pencil'] },
      }),
    });
    const userRoot = makeTempRoot({
      mcpJson: {
        mcpServers: {
          pencil: { command: 'node', args: ['/wrong/pencil'] },
          'my-figma': { command: 'figma-mcp' },
        },
      },
    });

    const result = await resolveAcpMcpServers(projectRoot, ['cat-cafe-collab', 'pencil'], userRoot);
    const pencil = result.find((s) => s.name === 'pencil');
    assert.deepStrictEqual(pencil.args, ['/correct/pencil']); // from whitelist
    assert.ok(
      result.find((s) => s.name === 'my-figma'),
      'non-conflicting user server included',
    );
  });

  // AC-E4: no user .mcp.json = graceful degrade
  it('gracefully degrades when user project has no .mcp.json', async () => {
    const projectRoot = makeTempRoot();
    const userRoot = makeTempRoot(); // no .mcp.json

    const result = await resolveAcpMcpServers(projectRoot, ['cat-cafe-collab'], userRoot);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'cat-cafe-collab');
  });

  // AC-E4: undefined userProjectRoot = same as before
  it('undefined userProjectRoot has no effect (backward-compatible)', async () => {
    const projectRoot = makeTempRoot();

    const result = await resolveAcpMcpServers(projectRoot, ['cat-cafe-collab'], undefined);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'cat-cafe-collab');
  });

  // AC-E5: different userProjectRoot = different servers
  it('different userProjectRoot yields different MCP server sets', async () => {
    const projectRoot = makeTempRoot();
    const userRootA = makeTempRoot({
      mcpJson: { mcpServers: { 'tool-a': { command: 'a' } } },
    });
    const userRootB = makeTempRoot({
      mcpJson: { mcpServers: { 'tool-b': { command: 'b' } } },
    });

    const resultA = await resolveAcpMcpServers(projectRoot, ['cat-cafe-collab'], userRootA);
    const resultB = await resolveAcpMcpServers(projectRoot, ['cat-cafe-collab'], userRootB);

    assert.ok(resultA.some((s) => s.name === 'tool-a'));
    assert.ok(!resultA.some((s) => s.name === 'tool-b'));
    assert.ok(resultB.some((s) => s.name === 'tool-b'));
    assert.ok(!resultB.some((s) => s.name === 'tool-a'));
  });

  // P1 review fix: HTTP user project server produces AcpMcpServerHttp, not broken stdio
  it('merges type:http user project server as AcpMcpServerHttp (not pseudo-stdio)', async () => {
    const projectRoot = makeTempRoot();
    const userRoot = makeTempRoot({
      mcpJson: {
        mcpServers: {
          webapi: { type: 'http', url: 'http://<local-browser-automation-endpoint>/mcp' },
          'my-stdio': { command: 'node', args: ['tool.js'] },
        },
      },
    });

    const result = await resolveAcpMcpServers(projectRoot, ['cat-cafe-collab'], userRoot);
    const webapi = result.find((s) => s.name === 'webapi');
    assert.ok(webapi, 'HTTP server should be merged');
    assert.equal(webapi.type, 'http');
    assert.equal(webapi.url, 'http://<local-browser-automation-endpoint>/mcp');
    assert.ok(!('command' in webapi), 'HTTP server must not have command');

    const stdio = result.find((s) => s.name === 'my-stdio');
    assert.ok(stdio, 'stdio server should also be merged');
    assert.equal(stdio.command, 'node');
  });

  // Edge: user project .mcp.json has no mcpServers key
  it('handles user project .mcp.json with no mcpServers key', async () => {
    const projectRoot = makeTempRoot();
    const userRoot = makeTempRoot({ mcpJson: { version: 1 } }); // valid JSON, no mcpServers

    const result = await resolveAcpMcpServers(projectRoot, ['cat-cafe-collab'], userRoot);
    assert.equal(result.length, 1); // just the builtin, no crash
  });
});

describe('resolveUserProjectMcpServers — per-invoke helper (F145 Phase E)', () => {
  const temps = [];
  function makeTempRoot(mcpJson) {
    const dir = mkdtempSync(join(tmpdir(), 'acp-mcp-'));
    temps.push(dir);
    if (mcpJson !== undefined) {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify(mcpJson));
    }
    return dir;
  }

  afterEach(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
    temps.length = 0;
  });

  it('returns user project servers not in exclude set', () => {
    const userRoot = makeTempRoot({
      mcpServers: {
        'my-db': { command: 'node', args: ['db.js'] },
        'my-docker': { command: 'docker', args: ['mcp'] },
      },
    });

    const result = resolveUserProjectMcpServers(userRoot, new Set());
    assert.equal(result.length, 2);
    assert.ok(result.find((s) => s.name === 'my-db'));
    assert.ok(result.find((s) => s.name === 'my-docker'));
  });

  it('excludes servers by name', () => {
    const userRoot = makeTempRoot({
      mcpServers: {
        'cat-cafe': { command: 'fake' },
        'my-tool': { command: 'real' },
      },
    });

    const result = resolveUserProjectMcpServers(userRoot, new Set(['cat-cafe']));
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'my-tool');
  });

  it('returns [] when .mcp.json missing', () => {
    const userRoot = makeTempRoot(); // no .mcp.json
    const result = resolveUserProjectMcpServers(userRoot, new Set());
    assert.deepStrictEqual(result, []);
  });

  it('converts env Record to name-value array', () => {
    const userRoot = makeTempRoot({
      mcpServers: {
        'my-tool': { command: 'node', args: ['t.js'], env: { API_KEY: 'secret' } },
      },
    });

    const result = resolveUserProjectMcpServers(userRoot, new Set());
    assert.deepStrictEqual(result[0].env, [{ name: 'API_KEY', value: 'secret' }]);
  });

  // P1 review fix: HTTP/SSE transport must produce correct AcpMcpServer variant
  it('resolves type:http user project server as AcpMcpServerHttp', () => {
    const userRoot = makeTempRoot({
      mcpServers: {
        webapi: { type: 'http', url: 'http://<local-browser-automation-endpoint>/mcp' },
      },
    });

    const result = resolveUserProjectMcpServers(userRoot, new Set());
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'webapi');
    assert.equal(result[0].type, 'http');
    assert.equal(result[0].url, 'http://<local-browser-automation-endpoint>/mcp');
    assert.ok(!('command' in result[0]), 'HTTP server must not have command field');
  });

  it('resolves type:streamableHttp as AcpMcpServerHttp', () => {
    const userRoot = makeTempRoot({
      mcpServers: {
        streaming: {
          type: 'streamableHttp',
          url: 'http://api.example.com/mcp',
          headers: { Authorization: 'Bearer x' },
        },
      },
    });

    const result = resolveUserProjectMcpServers(userRoot, new Set());
    assert.equal(result[0].type, 'http');
    assert.equal(result[0].url, 'http://api.example.com/mcp');
    assert.deepStrictEqual(result[0].headers, [{ name: 'Authorization', value: 'Bearer x' }]);
  });

  it('resolves type:sse as AcpMcpServerSse', () => {
    const userRoot = makeTempRoot({
      mcpServers: {
        events: { type: 'sse', url: 'http://localhost:8080/sse' },
      },
    });

    const result = resolveUserProjectMcpServers(userRoot, new Set());
    assert.equal(result[0].type, 'sse');
    assert.equal(result[0].url, 'http://localhost:8080/sse');
  });

  it('skips entries with no command and no url (invalid transport)', () => {
    const userRoot = makeTempRoot({
      mcpServers: {
        broken: { args: ['something'] },
        valid: { command: 'node', args: ['ok.js'] },
      },
    });

    const result = resolveUserProjectMcpServers(userRoot, new Set());
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'valid');
  });
});

// ─── resolveDisabledServerIds ─────────────────────────────────────

describe('resolveDisabledServerIds', () => {
  /** @type {string[]} */
  const temps = [];
  afterEach(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
    temps.length = 0;
  });

  it('includes servers with blockedCats containing the catId (F249)', () => {
    const dir = makeTempDir(temps, {
      capabilities: {
        version: 2,
        capabilities: [
          {
            id: 'blocked-tool',
            type: 'mcp',
            enabled: true,
            globalEnabled: true,
            source: 'external',
            blockedCats: ['codex'],
            mcpServer: { command: 'node', args: ['blocked.js'] },
          },
          {
            id: 'allowed-tool',
            type: 'mcp',
            enabled: true,
            globalEnabled: true,
            source: 'external',
            mcpServer: { command: 'node', args: ['allowed.js'] },
          },
        ],
      },
    });

    const disabled = resolveDisabledServerIds(dir, 'codex');
    assert.ok(disabled.has('blocked-tool'), 'blockedCats:["codex"] must disable blocked-tool for codex');
    assert.ok(!disabled.has('allowed-tool'), 'allowed-tool has no blockedCats — must remain enabled for codex');
  });

  it('does not disable for a cat NOT in blockedCats', () => {
    const dir = makeTempDir(temps, {
      capabilities: {
        version: 2,
        capabilities: [
          {
            id: 'blocked-tool',
            type: 'mcp',
            enabled: true,
            globalEnabled: true,
            source: 'external',
            blockedCats: ['codex'],
            mcpServer: { command: 'node', args: ['blocked.js'] },
          },
        ],
      },
    });

    const disabled = resolveDisabledServerIds(dir, 'opus');
    assert.ok(!disabled.has('blocked-tool'), 'opus is not in blockedCats — must remain enabled');
  });

  it('includes globally disabled servers', () => {
    const dir = makeTempDir(temps, {
      capabilities: {
        version: 2,
        capabilities: [
          {
            id: 'disabled-tool',
            type: 'mcp',
            enabled: false,
            globalEnabled: false,
            source: 'external',
            mcpServer: { command: 'echo', args: [] },
          },
        ],
      },
    });

    const disabled = resolveDisabledServerIds(dir, 'codex');
    assert.ok(disabled.has('disabled-tool'), 'globalEnabled=false must be disabled');
  });
});
