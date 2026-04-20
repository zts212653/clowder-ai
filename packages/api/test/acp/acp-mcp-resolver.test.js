/**
 * acp-mcp-resolver — unit tests for MCP whitelist → AcpMcpServerStdio resolution.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const { resolveAcpMcpServers, resolveUserProjectMcpServers } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js'
);

describe('resolveAcpMcpServers', () => {
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

  it('returns [] for empty whitelist', () => {
    const result = resolveAcpMcpServers('/nonexistent', []);
    assert.deepStrictEqual(result, []);
  });

  it('resolves external whitelist entries from .mcp.json', () => {
    const root = makeTempRoot({
      mcpServers: {
        pencil: { command: 'node', args: ['pencil.js'] },
        playwright: { command: 'npx', args: ['@playwright/mcp'], env: { FOO: 'bar' } },
      },
    });

    const result = resolveAcpMcpServers(root, ['pencil', 'playwright']);
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

  it('skips missing external entries but returns the rest (builtins + found externals)', () => {
    const root = makeTempRoot({
      mcpServers: {
        pencil: { command: 'node', args: ['pencil.js'] },
      },
    });

    const result = resolveAcpMcpServers(root, ['cat-cafe-collab', 'pencil', 'nonexistent']);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'cat-cafe-collab');
    assert.equal(result[1].name, 'pencil');
  });

  it('throws when ALL external whitelist entries are missing (zero resolved)', () => {
    const root = makeTempRoot({ mcpServers: { unrelated: { command: 'x' } } });

    assert.throws(() => resolveAcpMcpServers(root, ['missing-a', 'missing-b']), /All 2 MCP whitelist entries.*missing/);
  });

  it('throws when .mcp.json is missing and external servers requested', () => {
    const root = makeTempRoot(); // no .mcp.json written

    assert.throws(() => resolveAcpMcpServers(root, ['pencil']), /MCP whitelist entries.*missing/);
  });

  it('throws when .mcp.json has no mcpServers key and external servers requested', () => {
    const root = makeTempRoot({ version: 1 });

    assert.throws(() => resolveAcpMcpServers(root, ['pencil']), /MCP whitelist entries.*missing/);
  });
});

describe('resolveAcpMcpServers — builtin auto-provision (F145 Phase C)', () => {
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

  it('auto-generates cat-cafe main server from projectRoot (no .mcp.json needed)', () => {
    const root = makeTempRoot(); // no .mcp.json
    const result = resolveAcpMcpServers(root, ['cat-cafe']);

    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'cat-cafe');
    assert.equal(result[0].command, 'node');
    assert.ok(result[0].args[0].endsWith('packages/mcp-server/dist/index.js'));
  });

  it('auto-generates cat-cafe-collab from projectRoot', () => {
    const root = makeTempRoot(); // no .mcp.json
    const result = resolveAcpMcpServers(root, ['cat-cafe-collab']);

    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'cat-cafe-collab');
    assert.equal(result[0].command, 'node');
    assert.ok(result[0].args[0].endsWith('packages/mcp-server/dist/collab.js'));
  });

  it('auto-generates all four builtin cat-cafe servers', () => {
    const root = makeTempRoot(); // no .mcp.json
    const result = resolveAcpMcpServers(root, ['cat-cafe', 'cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals']);

    assert.equal(result.length, 4);
    const names = result.map((s) => s.name);
    assert.deepStrictEqual(names, ['cat-cafe', 'cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals']);

    const entrypoints = result.map((s) => s.args[0].split('/').pop());
    assert.deepStrictEqual(entrypoints, ['index.js', 'collab.js', 'memory.js', 'signals.js']);
  });

  it('falls back to .mcp.json for non-builtin servers', () => {
    const root = makeTempRoot({
      mcpServers: {
        pencil: { command: 'node', args: ['/path/to/pencil'] },
      },
    });

    const result = resolveAcpMcpServers(root, ['cat-cafe-collab', 'pencil']);
    assert.equal(result.length, 2);

    const collab = result.find((s) => s.name === 'cat-cafe-collab');
    assert.ok(collab.args[0].endsWith('packages/mcp-server/dist/collab.js'), 'builtin auto-generated');

    const pencil = result.find((s) => s.name === 'pencil');
    assert.deepStrictEqual(pencil.args, ['/path/to/pencil'], 'external from .mcp.json');
  });

  it('does not throw when .mcp.json missing and only builtins requested', () => {
    const root = makeTempRoot(); // no .mcp.json
    // Should NOT throw — builtins don't need .mcp.json
    const result = resolveAcpMcpServers(root, ['cat-cafe', 'cat-cafe-memory']);
    assert.equal(result.length, 2);
  });

  it('builtin servers have empty env (callbackEnv injected later by acp-session-env)', () => {
    const root = makeTempRoot();
    const result = resolveAcpMcpServers(root, ['cat-cafe-collab']);
    assert.deepStrictEqual(result[0].env, []);
  });

  it('does not treat typo cat-cafe-collabb as builtin (P1 fail-fast)', () => {
    const root = makeTempRoot(); // no .mcp.json
    // Typo should NOT be treated as builtin — should throw because no servers resolved
    assert.throws(() => resolveAcpMcpServers(root, ['cat-cafe-collabb']), /MCP whitelist entries.*missing/);
  });

  it('does not treat cat-cafeteria as builtin', () => {
    const root = makeTempRoot({
      mcpServers: {
        'cat-cafeteria': { command: 'node', args: ['cafeteria.js'] },
      },
    });

    const result = resolveAcpMcpServers(root, ['cat-cafeteria']);
    // Should come from .mcp.json, not auto-generated
    assert.equal(result[0].name, 'cat-cafeteria');
    assert.deepStrictEqual(result[0].args, ['cafeteria.js']);
  });
});

describe('resolveAcpMcpServers — per-project MCP (F145 Phase E)', () => {
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

  // AC-E1: accepts userProjectRoot, reads user project .mcp.json
  it('merges user project .mcp.json servers when userProjectRoot provided', () => {
    const projectRoot = makeTempRoot(); // monorepo root, no .mcp.json
    const userRoot = makeTempRoot({
      mcpServers: {
        'my-database': { command: 'node', args: ['db-mcp.js'] },
        'my-docker': { command: 'docker', args: ['mcp'], env: { DOCKER_HOST: 'unix:///var/run/docker.sock' } },
      },
    });

    const result = resolveAcpMcpServers(projectRoot, ['cat-cafe'], userRoot);
    assert.equal(result.length, 3); // 1 builtin + 2 user project
    assert.equal(result[0].name, 'cat-cafe'); // builtin first

    const db = result.find((s) => s.name === 'my-database');
    assert.ok(db, 'user project server my-database should be included');
    assert.equal(db.command, 'node');
    assert.deepStrictEqual(db.args, ['db-mcp.js']);

    const docker = result.find((s) => s.name === 'my-docker');
    assert.ok(docker, 'user project server my-docker should be included');
    assert.deepStrictEqual(docker.env, [{ name: 'DOCKER_HOST', value: 'unix:///var/run/docker.sock' }]);
  });

  // AC-E3: builtin cat-cafe-* takes priority over same-name user project server
  it('builtin cat-cafe-* takes priority over same-name user project server', () => {
    const projectRoot = makeTempRoot();
    const userRoot = makeTempRoot({
      mcpServers: {
        'cat-cafe': { command: 'python', args: ['fake.py'] },
        'my-tool': { command: 'node', args: ['tool.js'] },
      },
    });

    const result = resolveAcpMcpServers(projectRoot, ['cat-cafe'], userRoot);
    const catCafe = result.find((s) => s.name === 'cat-cafe');
    assert.equal(catCafe.command, 'node'); // builtin, not python
    assert.ok(catCafe.args[0].endsWith('packages/mcp-server/dist/index.js'));
    assert.ok(
      result.find((s) => s.name === 'my-tool'),
      'non-conflicting user server still included',
    );
  });

  // AC-E3: whitelist external > user project for same name
  it('whitelist external server takes priority over same-name user project server', () => {
    const projectRoot = makeTempRoot({
      mcpServers: {
        pencil: { command: 'node', args: ['/correct/pencil'] },
      },
    });
    const userRoot = makeTempRoot({
      mcpServers: {
        pencil: { command: 'node', args: ['/wrong/pencil'] },
        'my-figma': { command: 'figma-mcp' },
      },
    });

    const result = resolveAcpMcpServers(projectRoot, ['cat-cafe', 'pencil'], userRoot);
    const pencil = result.find((s) => s.name === 'pencil');
    assert.deepStrictEqual(pencil.args, ['/correct/pencil']); // from whitelist
    assert.ok(
      result.find((s) => s.name === 'my-figma'),
      'non-conflicting user server included',
    );
  });

  // AC-E4: no user .mcp.json = graceful degrade
  it('gracefully degrades when user project has no .mcp.json', () => {
    const projectRoot = makeTempRoot();
    const userRoot = makeTempRoot(); // no .mcp.json

    const result = resolveAcpMcpServers(projectRoot, ['cat-cafe'], userRoot);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'cat-cafe');
  });

  // AC-E4: undefined userProjectRoot = same as before
  it('undefined userProjectRoot has no effect (backward-compatible)', () => {
    const projectRoot = makeTempRoot();

    const result = resolveAcpMcpServers(projectRoot, ['cat-cafe'], undefined);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'cat-cafe');
  });

  // AC-E5: different userProjectRoot = different servers
  it('different userProjectRoot yields different MCP server sets', () => {
    const projectRoot = makeTempRoot();
    const userRootA = makeTempRoot({
      mcpServers: { 'tool-a': { command: 'a' } },
    });
    const userRootB = makeTempRoot({
      mcpServers: { 'tool-b': { command: 'b' } },
    });

    const resultA = resolveAcpMcpServers(projectRoot, ['cat-cafe'], userRootA);
    const resultB = resolveAcpMcpServers(projectRoot, ['cat-cafe'], userRootB);

    assert.ok(resultA.some((s) => s.name === 'tool-a'));
    assert.ok(!resultA.some((s) => s.name === 'tool-b'));
    assert.ok(resultB.some((s) => s.name === 'tool-b'));
    assert.ok(!resultB.some((s) => s.name === 'tool-a'));
  });

  // P1 review fix: HTTP user project server produces AcpMcpServerHttp, not broken stdio
  it('merges type:http user project server as AcpMcpServerHttp (not pseudo-stdio)', () => {
    const projectRoot = makeTempRoot();
    const userRoot = makeTempRoot({
      mcpServers: {
        webapi: { type: 'http', url: 'http://<local-browser-automation-endpoint>/mcp' },
        'my-stdio': { command: 'node', args: ['tool.js'] },
      },
    });

    const result = resolveAcpMcpServers(projectRoot, ['cat-cafe'], userRoot);
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
  it('handles user project .mcp.json with no mcpServers key', () => {
    const projectRoot = makeTempRoot();
    const userRoot = makeTempRoot({ version: 1 }); // valid JSON, no mcpServers

    const result = resolveAcpMcpServers(projectRoot, ['cat-cafe'], userRoot);
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
