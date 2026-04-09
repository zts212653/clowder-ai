/**
 * acp-mcp-resolver — unit tests for MCP whitelist → AcpMcpServerStdio resolution.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const { resolveAcpMcpServers } = await import(
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
