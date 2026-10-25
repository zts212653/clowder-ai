import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { capabilityFile, fixture, managed, memberIds, providers, putConfig } from './helpers/invoke-mcp-workspace.js';
import { secretMcpContract } from './helpers/secret-mcp-contract.js';

function transport(provider, server, name) {
  // Codex's fixture already checks the relay in upstreamMcpServersFromArgs.
  if (provider === 'codex') return server;
  const { proxyEnv, upstream } = secretMcpContract(server);
  assert.equal(upstream.source, name);
  assert.equal(proxyEnv.ALLOWED_WORKSPACE_DIRS, undefined, 'workspace scope belongs to the upstream reader');
  return upstream;
}

for (const [provider, invoke] of Object.entries(providers)) {
  test(`${provider}: default Alpha capabilities come from workspace; binaries remain in Alpha`, async (t) => {
    const f = fixture(t);
    const before = f.sentinelPaths.map((p) => readFileSync(p));
    const mcp = await invoke(f);
    assert.deepEqual(Object.keys(mcp), ['cat-cafe-collab']);
    const collab = transport(provider, mcp['cat-cafe-collab'], 'cat-cafe-collab');
    assert.equal(collab.command, process.execPath);
    assert.deepEqual(collab.args, [join(f.dist, 'collab.js')]);
    const workspace = provider === 'opencode' ? f.main : process.env.ALLOWED_WORKSPACE_DIRS?.trim() || f.main;
    assert.equal(collab.env.ALLOWED_WORKSPACE_DIRS, workspace);
    assert.deepEqual(
      f.sentinelPaths.map((p, i) => readFileSync(p).equals(before[i])),
      [true, true, true, true],
    );
  });

  test(`${provider}: global master disable remains authoritative even with an empty member block list`, async (t) => {
    const f = fixture(t);
    putConfig(f.main, [managed({ globalEnabled: false, blockedCats: [] })]);
    assert.deepEqual(Object.keys(await invoke(f)), []);
    assert.deepEqual(Object.keys(await invoke(f, f.main)), []);
  });

  test(`${provider}: aliases of the default workspace cannot change global authorization into project authorization`, async (t) => {
    const f = fixture(t);
    const alias = join(f.dir, 'workspace-alias');
    symlinkSync(f.main, alias, 'dir');
    putConfig(f.main, [managed({ globalEnabled: false, blockedCats: [] })]);
    assert.deepEqual(Object.keys(await invoke(f, alias)), []);
    assert.deepEqual(Object.keys(await invoke(f, `${f.main}/.`)), []);
  });

  test(`${provider}: explicit project policy is distinct; member blocks and empty configs stay authoritative`, async (t) => {
    const f = fixture(t);
    putConfig(f.main, [managed({ globalEnabled: false, blockedCats: [] })]);
    putConfig(f.project, [managed({ globalEnabled: false, blockedCats: [] })]);
    assert.deepEqual(Object.keys(await invoke(f, f.project)), ['cat-cafe-collab']);
    putConfig(f.project, [managed({ blockedCats: memberIds })]);
    assert.deepEqual(Object.keys(await invoke(f, f.project)), []);
    putConfig(f.project, []);
    assert.deepEqual(Object.keys(await invoke(f, f.project)), []);
    putConfig(f.main, []);
    assert.deepEqual(Object.keys(await invoke(f)), []);
  });

  test(`${provider}: absent project uses global policy and observes configuration changes at invocation`, async (t) => {
    const f = fixture(t);
    assert.deepEqual(Object.keys(await invoke(f, f.project)), ['cat-cafe-collab']);
    putConfig(f.main, [managed({ blockedCats: memberIds })]);
    assert.deepEqual(Object.keys(await invoke(f, f.project)), []);
  });

  test(`${provider}: missing or unreadable mapped global source cannot enable fallback servers`, async (t) => {
    const f = fixture(t);
    rmSync(capabilityFile(f.main));
    await assert.rejects(() => invoke(f), /capabilit/i);
    writeFileSync(capabilityFile(f.main), 'not json');
    await assert.rejects(() => invoke(f), /capabilit/i);
    putConfig(f.project, [managed()]);
    assert.deepEqual(Object.keys(await invoke(f, f.project)), ['cat-cafe-collab']);
  });

  test(`${provider}: external MCP file arguments resolve relative to the actual configuration source`, async (t) => {
    const f = fixture(t);
    writeFileSync(join(f.main, 'external-server.js'), '// never executed');
    putConfig(f.main, [
      {
        id: 'fixture-external',
        type: 'mcp',
        source: 'external',
        globalEnabled: true,
        mcpServer: { command: 'node', args: ['external-server.js'] },
      },
    ]);
    const mcp = await invoke(f);
    assert.deepEqual(Object.keys(mcp), ['fixture-external']);
    const external = transport(provider, mcp['fixture-external'], 'fixture-external');
    assert.equal(external.command, 'node');
    assert.deepEqual(external.args, [join(f.main, 'external-server.js')]);
    assert.deepEqual(external.env ?? {}, {}, 'external source resolution must not grant host callback authority');
  });
}
