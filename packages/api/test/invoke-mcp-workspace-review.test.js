import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveInvokeCapabilityRoot } from '../dist/config/capabilities/invoke-capability-root.js';
import {
  callbackFixture,
  capabilityFile,
  fixture,
  managed,
  providers,
  putConfig,
} from './helpers/invoke-mcp-workspace.js';
import { secretMcpContract } from './helpers/secret-mcp-contract.js';

function transport(provider, server) {
  return provider === 'codex' ? server : secretMcpContract(server).upstream;
}

for (const [provider, invoke] of Object.entries(providers)) {
  test(`${provider}: same-repo external limb uses runtime binary and managed environment`, async (t) => {
    const f = fixture(t);
    putConfig(f.main, [
      managed(),
      {
        id: 'cat-cafe-limb',
        type: 'mcp',
        source: 'external',
        globalEnabled: true,
        mcpServer: { command: 'node', args: [join(f.main, 'packages/mcp-server/dist/limb.js')] },
      },
    ]);
    const before = f.sentinelPaths.map((p) => readFileSync(p));
    const mcp = await invoke(f);
    const limb = transport(provider, mcp['cat-cafe-limb']);
    assert.deepEqual(limb.args, [join(f.dist, 'limb.js')]);
    const env = limb.env;
    assert.equal(env.ALLOWED_WORKSPACE_DIRS, transport(provider, mcp['cat-cafe-collab']).env.ALLOWED_WORKSPACE_DIRS);
    // OpenCode inherits callback credentials through its CLI process environment;
    // the runtime config carries only its existing managed workspace environment.
    if (provider !== 'opencode') {
      for (const [key, value] of Object.entries(callbackFixture)) assert.equal(env[key], value);
    }
    assert.deepEqual(
      f.sentinelPaths.map((p, i) => readFileSync(p).equals(before[i])),
      [true, true, true, true],
    );
  });

  test(`${provider}: unrelated external limb stays external without managed callback injection`, async (t) => {
    const f = fixture(t);
    const external = join(f.project, 'other-limb.js');
    writeFileSync(external, '// never executed');
    putConfig(f.main, [
      {
        id: 'cat-cafe-limb',
        type: 'mcp',
        source: 'external',
        globalEnabled: true,
        mcpServer: { command: 'node', args: [external] },
      },
    ]);
    const mcp = await invoke(f);
    const limb = transport(provider, mcp['cat-cafe-limb']);
    assert.deepEqual(limb.args, [external]);
    for (const key of Object.keys(callbackFixture)) assert.equal(limb.env?.[key], undefined);
    assert.equal(limb.env?.ALLOWED_WORKSPACE_DIRS, undefined);
  });

  test(`${provider}: project source resolves workingDir, command and args without rewriting flags`, async (t) => {
    const f = fixture(t);
    const cwd = join(f.project, 'tools');
    mkdirSync(cwd);
    // Competing files make a wrong source or precedence observable.
    for (const root of [f.main, f.project, cwd]) {
      writeFileSync(join(root, 'server.js'), '// never executed');
      writeFileSync(join(root, 'runner'), '// never executed');
      writeFileSync(join(root, '--literal'), '// a flag is not a filename');
    }
    putConfig(f.project, [
      {
        id: 'project-external',
        type: 'mcp',
        source: 'external',
        globalEnabled: false,
        blockedCats: [],
        mcpServer: { command: './runner', workingDir: 'tools', args: ['server.js', '--literal', 'literal-value'] },
      },
    ]);
    const mcp = await invoke(f, f.project);
    assert.deepEqual(Object.keys(mcp), ['project-external']);
    const external = transport(provider, mcp['project-external']);
    assert.equal(external.command, join(cwd, 'runner'));
    assert.deepEqual(external.args, [join(cwd, 'server.js'), '--literal', 'literal-value']);
    if (provider === 'claude' || provider === 'kimi') assert.equal(external.cwd, cwd);
  });
}

test('Alpha without a workspace mapping refuses invocation capability resolution', async (t) => {
  const f = fixture(t);
  delete process.env.CAT_CAFE_WORKSPACE_ROOT;
  await assert.rejects(resolveInvokeCapabilityRoot(f.runtime), /persistent global capabilities root/);
});

test('an invalid declared workspace cannot silently fall back to runtime capabilities', async (t) => {
  const f = fixture(t);
  process.env.CAT_CAFE_WORKSPACE_ROOT = join(f.dir, 'missing');
  await assert.rejects(resolveInvokeCapabilityRoot(f.runtime), /persistent global capabilities root/);
});

test('OpenCode creates no invocation directory when capability resolution is refused', async (t) => {
  const f = fixture(t);
  rmSync(capabilityFile(f.main));
  await assert.rejects(() => providers.opencode(f), /capabilit/i);
  assert.equal(existsSync(join(f.runtime, '.cat-cafe/oc-config-glm52-fixture')), false);
});
