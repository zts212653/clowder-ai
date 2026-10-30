import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'smol-toml';
import { migrateStartupCodexMcpConfig } from '../src/config/capabilities/startup-cli-config.js';

for (const preview of [false, true])
  test(`startup retires only fingerprinted F193 probes with byte-exact backups; preview=${preview}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f333-retired-probes-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const directory of ['.git', '.cat-cafe', '.codex']) await mkdir(join(root, directory));
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    const code = await readFile(new URL('./fixtures/f193-retired-probe-source.txt', import.meta.url), 'utf8');
    const known = { command: 'node', args: ['--input-type=module', '--eval', code] };
    const off = { command: 'echo', args: ['ok'] };
    const custom = { command: 'node', args: ['user-owned-probe.js'], env: { KEEP_USER_FIELD: 'original' } };
    const customizedInline = { ...known, cwd: '/user-owned', env: { CUSTOM: 'keep' } };
    const disabledOff = { ...off, enabled: false };
    const servers = {
      'probe-connected': known,
      'probe-env': known,
      'probe-off': off,
      'secret-mcp': custom,
      other: custom,
    };
    const capability = (id: string, mcpServer: typeof known) => ({
      id,
      type: 'mcp',
      source: 'external',
      enabled: true,
      mcpServer,
    });
    const original = {
      '.cat-cafe/capabilities.json': JSON.stringify({
        version: 2,
        customField: 'preserve',
        capabilities: [
          ...Object.entries(servers).map(([id, server]) => capability(id, server)),
          { ...capability('probe-connected', known), source: 'plugin', pluginId: 'dev.user-probe' },
          { ...capability('probe-off', off), blockedCats: ['custom-cat'] },
        ],
      }),
      '.mcp.json': JSON.stringify({
        mcpServers: { ...servers, 'probe-env': customizedInline },
        custom: { retained: true },
      }),
      '.codex/config.toml': stringify({
        model: 'preserve-model',
        mcp_servers: { ...servers, 'probe-off': disabledOff },
      }),
    };
    for (const [file, bytes] of Object.entries(original)) await writeFile(join(root, file), bytes);
    const env = {
      CAT_CAFE_DEPLOYMENT_ID: preview ? 'alpha-fixture' : 'runtime',
      CAT_CAFE_RUNTIME_ROOT: root,
      CAT_CAFE_CONFIG_ROOT: root,
      CAT_CAFE_WORKSPACE_ROOT: root,
    };
    const removed = await migrateStartupCodexMcpConfig(root, env);
    if (preview) {
      assert.deepEqual(removed, []);
      for (const [file, bytes] of Object.entries(original))
        assert.equal(await readFile(join(root, file), 'utf8'), bytes);
      return;
    }
    assert.deepEqual(new Set(removed), new Set(['probe-connected', 'probe-env', 'probe-off']));
    const caps = JSON.parse(await readFile(join(root, '.cat-cafe/capabilities.json'), 'utf8'));
    assert.equal(caps.customField, 'preserve');
    assert.deepEqual(
      caps.capabilities.map((entry: { id: string }) => entry.id),
      ['secret-mcp', 'other', 'probe-connected', 'probe-off'],
    );
    assert.equal(
      caps.capabilities[2].pluginId,
      'dev.user-probe',
      'a matching name never retires a plugin-owned capability',
    );
    const claude = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(claude.mcpServers, { 'probe-env': customizedInline, 'secret-mcp': custom, other: custom });
    assert.deepEqual(claude.custom, { retained: true });
    const codex = parse(await readFile(join(root, '.codex/config.toml'), 'utf8'));
    assert.equal(codex.model, 'preserve-model');
    assert.deepEqual(codex.mcp_servers, { 'probe-off': disabledOff, 'secret-mcp': custom, other: custom });
    for (const [file, bytes] of Object.entries(original)) {
      const path = join(root, file);
      const directory = file.includes('/') ? join(root, file.split('/')[0]) : root;
      const name = file.split('/').at(-1);
      const backup = (await readdir(directory)).find((entry) => entry.startsWith(`${name}.before-f333-probes-`));
      assert.ok(backup);
      assert.equal(await readFile(join(directory, backup), 'utf8'), bytes);
      assert.equal((await stat(join(directory, backup))).mode & 0o777, 0o600);
      const after = await readFile(path, 'utf8');
      await migrateStartupCodexMcpConfig(root, env);
      assert.equal(await readFile(path, 'utf8'), after, 'repeat migration preserves canonical bytes');
    }
  });

test('startup preserves customized capabilities even when their F193 command and payload match', async (t) => {
  const code = await readFile(new URL('./fixtures/f193-retired-probe-source.txt', import.meta.url), 'utf8');
  const probes = {
    'probe-connected': { command: 'node', args: ['--input-type=module', '--eval', code] },
    'probe-env': { command: 'node', args: ['--input-type=module', '--eval', code] },
    'probe-off': { command: 'echo', args: ['ok'] },
  };
  for (const change of [{ blockedCats: ['custom-cat'] }, { enabled: false }, { userOwned: true }]) {
    const root = await mkdtemp(join(tmpdir(), 'f333-custom-probe-capability-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.cat-cafe'));
    const original = JSON.stringify({
      version: 2,
      capabilities: Object.entries(probes).map(([id, mcpServer]) => ({
        id,
        type: 'mcp',
        source: 'external',
        enabled: true,
        mcpServer,
        ...change,
      })),
    });
    await writeFile(join(root, '.cat-cafe/capabilities.json'), original);
    assert.deepEqual(await migrateFixture(root), [], `preserve capability customization ${JSON.stringify(change)}`);
    assert.equal(await readFile(join(root, '.cat-cafe/capabilities.json'), 'utf8'), original);
    assert.deepEqual(await readdir(join(root, '.cat-cafe')), ['capabilities.json'], 'no rewrite or backup');
  }
});

test('startup preserves customized F193 launches in capability, Claude JSON and Codex TOML', async (t) => {
  const code = await readFile(new URL('./fixtures/f193-retired-probe-source.txt', import.meta.url), 'utf8');
  for (const change of [{ cwd: '/user-owned' }, { env: { CUSTOM: 'keep' } }, { enabled: false }, { future: true }]) {
    const root = await mkdtemp(join(tmpdir(), 'f333-custom-probe-launch-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const directory of ['.cat-cafe', '.codex']) await mkdir(join(root, directory));
    const servers = {
      'probe-connected': { command: 'node', args: ['--input-type=module', '--eval', code], ...change },
      'probe-env': { command: 'node', args: ['--input-type=module', '--eval', code], ...change },
      'probe-off': { command: 'echo', args: ['ok'], ...change },
    };
    const original = {
      '.cat-cafe/capabilities.json': JSON.stringify({
        version: 2,
        capabilities: Object.entries(servers).map(([id, mcpServer]) => ({
          id,
          type: 'mcp',
          source: 'external',
          enabled: true,
          mcpServer,
        })),
      }),
      '.mcp.json': JSON.stringify({ mcpServers: servers }),
      '.codex/config.toml': stringify({ mcp_servers: servers }),
    };
    for (const [file, bytes] of Object.entries(original)) await writeFile(join(root, file), bytes);
    assert.deepEqual(await migrateFixture(root), [], `preserve launch customization ${JSON.stringify(change)}`);
    for (const [file, bytes] of Object.entries(original)) assert.equal(await readFile(join(root, file), 'utf8'), bytes);
  }
});

async function migrateFixture(root: string): Promise<string[]> {
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  return migrateStartupCodexMcpConfig(root, {
    CAT_CAFE_DEPLOYMENT_ID: 'runtime',
    CAT_CAFE_RUNTIME_ROOT: root,
    CAT_CAFE_CONFIG_ROOT: root,
    CAT_CAFE_WORKSPACE_ROOT: root,
  });
}
