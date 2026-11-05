import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse, stringify } from 'smol-toml';
import {
  migrateStartupCodexMcpConfig,
  regenerateStartupCliConfigs,
} from '../src/config/capabilities/startup-cli-config.js';

for (const preview of [false, true])
  test(`only the persistent owner migrates self static MCP; preview=${preview}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f333-codex-project-migration-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.git'));
    await mkdir(join(root, '.codex'));
    await mkdir(join(root, '.cat-cafe'));
    await mkdir(join(root, 'packages/mcp-server/dist'), { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeFile(join(root, '.cat-cafe/capabilities.json'), '{"version":2,"capabilities":[]}');
    const servers: Record<string, unknown> = {};
    for (const family of ['collab', 'memory', 'signals', 'limb', 'audio', 'finance']) {
      const entry = join(root, 'packages/mcp-server/dist', `${family}.js`);
      await writeFile(entry, '// isolated owned entrypoint\n');
      servers[`cat-cafe-${family}`] = {
        command: process.execPath,
        args: [entry],
        env: {
          ...(family === 'limb' ? { CAT_CAFE_AGENT_KEY_FILE: join(root, 'owned-agent-key') } : {}),
          KEEP_SETTING: 'preserved',
        },
      };
    }
    const external = { command: 'owned-third-party', args: ['--native'], env: { EXPLICIT_SETTING: 'preserved' } };
    servers.external = external;
    servers['cat-cafe-foreign'] = external;
    // Exact reserved name still needs genuine installation ownership.
    servers['cat-cafe'] = external;
    const original = stringify({ model: 'preserved-model', extra_user_field: { value: 'keep' }, mcp_servers: servers });
    const path = join(root, '.codex/config.toml');
    await writeFile(path, original);
    await regenerateStartupCliConfigs(root, {
      ...process.env,
      CAT_CAFE_DEPLOYMENT_ID: preview ? 'alpha-f333-test' : 'runtime',
      CAT_CAFE_RUNTIME_ROOT: root,
      CAT_CAFE_CONFIG_ROOT: root,
      CAT_CAFE_WORKSPACE_ROOT: root,
    });
    const after = await readFile(path, 'utf8');
    const files = await readdir(join(root, '.codex'));
    if (preview) {
      assert.equal(after, original);
      assert.deepEqual(files, ['config.toml']);
      return;
    }
    const parsed = parse(after);
    assert.deepEqual(parsed.mcp_servers, { external, 'cat-cafe-foreign': external, 'cat-cafe': external });
    assert.equal(parsed.model, 'preserved-model');
    assert.deepEqual(parsed.extra_user_field, { value: 'keep' });
    const backup = files.find((p) => p.startsWith('config.before-f333-'));
    const profile = files.find((p) => p.startsWith('cat-cafe-stdio-'));
    assert.ok(backup);
    assert.ok(profile);
    assert.equal(await readFile(join(root, '.codex', backup), 'utf8'), original);
    const stdio = parse(await readFile(join(root, '.codex', profile), 'utf8')).mcp_servers as Record<string, unknown>;
    for (const family of ['collab', 'memory', 'signals', 'limb', 'audio', 'finance'])
      assert.deepEqual(stdio[`cat-cafe-${family}`], servers[`cat-cafe-${family}`]);
    await regenerateStartupCliConfigs(root, {
      ...process.env,
      CAT_CAFE_DEPLOYMENT_ID: 'runtime',
      CAT_CAFE_RUNTIME_ROOT: root,
      CAT_CAFE_CONFIG_ROOT: root,
      CAT_CAFE_WORKSPACE_ROOT: root,
    });
    assert.equal(await readFile(path, 'utf8'), after, 'migration is idempotent');
  });

for (const kind of ['syntax', 'large-integer', 'symlink'])
  test(`auxiliary Codex migration failure cannot abort Host startup: ${kind}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f333-codex-startup-failure-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.git'));
    await mkdir(join(root, '.codex'));
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    const original = kind === 'syntax' ? '[broken\n' : 'user_integer = 9007199254740993\n';
    const path = join(root, '.codex/config.toml');
    if (kind === 'symlink') {
      const target = join(root, 'user-config.toml');
      await writeFile(target, original);
      await symlink(target, path);
    } else await writeFile(path, original);
    await assert.doesNotReject(async () => {
      assert.deepEqual(
        await migrateStartupCodexMcpConfig(root, {
          CAT_CAFE_DEPLOYMENT_ID: 'runtime',
          CAT_CAFE_RUNTIME_ROOT: root,
          CAT_CAFE_CONFIG_ROOT: root,
          CAT_CAFE_WORKSPACE_ROOT: root,
        }),
        [],
      );
    });
    assert.equal(await readFile(path, 'utf8'), original, 'failed migration never changes the user file');
    assert.deepEqual(await readdir(join(root, '.codex')), ['config.toml']);
  });
