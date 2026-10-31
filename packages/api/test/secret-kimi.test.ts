import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse, stringify } from 'smol-toml';
import { ensureKimiSecretHooks } from '../src/domains/cats/services/agents/providers/kimi-secret-hooks.js';

test('Kimi hooks preserve native credentials, user hooks and bytes across idempotent installs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secret-kimi-config-'));
  const native = join(root, '.kimi-code');
  const path = join(native, 'config.toml');
  const original =
    '# owner comment\n[provider]\napi_key = "fixture-private"\n[[hooks]]\nevent="PreToolUse"\ncommand="owner-check"\n';
  try {
    await mkdir(native);
    await writeFile(path, original, { mode: 0o600 });
    await ensureKimiSecretHooks({ HOME: root, KIMI_CODE_HOME: native });
    const first = await readFile(path, 'utf8');
    assert.ok(first.startsWith(original));
    const config = parse(first);
    assert.deepEqual(config.provider, { api_key: 'fixture-private' });
    assert.equal((config.hooks as unknown[]).length, 3);
    await ensureKimiSecretHooks({ HOME: root, KIMI_CODE_HOME: native });
    assert.equal(await readFile(path, 'utf8'), first);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await writeFile(path, `${first}\n[owner_settings]\nkeep = true\n`);
    await ensureKimiSecretHooks({ HOME: root, KIMI_CODE_HOME: native });
    const updated = parse(await readFile(path, 'utf8'));
    assert.deepEqual(updated.owner_settings, { keep: true });
    await writeFile(path, stringify(updated)); // Native settings saves may remove comment markers.
    await ensureKimiSecretHooks({ HOME: root, KIMI_CODE_HOME: native });
    assert.equal((parse(await readFile(path, 'utf8')).hooks as unknown[]).length, 3);
    const canonical = await readFile(path, 'utf8');
    await writeFile(join(native, '.cat-cafe-secret-hooks.lock'), 'other writer');
    await assert.rejects(ensureKimiSecretHooks({ KIMI_CODE_HOME: native }), /secret_hook_config_busy/);
    assert.equal(await readFile(path, 'utf8'), canonical);
    await rm(join(native, '.cat-cafe-secret-hooks.lock'));
    await rm(path);
    await writeFile(join(root, 'owner-config'), original);
    await symlink(join(root, 'owner-config'), path);
    await assert.rejects(ensureKimiSecretHooks({ KIMI_CODE_HOME: native }), /secret_hook_config_unsafe/);
    assert.equal(await readFile(join(root, 'owner-config'), 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Kimi adapter uses exit 2 for secret input, credential reads and corrupt hook payloads', () => {
  const script = resolve('../../scripts/secret-kimi-hook.mjs');
  for (const [payload, status] of [
    [{ tool_name: 'Shell', tool_input: { command: 'printf clean' } }, 0],
    [{ tool_name: 'WriteFile', tool_input: { content: ['ghp', '_', 'K'.repeat(36)].join('') } }, 2],
    [{ tool_name: 'ReadFile', tool_input: { path: '.env.local' } }, 2],
    [null, 2],
  ] as const) {
    const result = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: 'utf8' });
    assert.equal(result.status, status);
    assert.ok(!result.stdout.includes('K'.repeat(36)));
    assert.ok(!result.stderr.includes('K'.repeat(36)));
  }
});

test('Kimi inline hook arrays retain their existing hooks and unrelated auth settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secret-kimi-inline-'));
  try {
    for (const hooks of ['[]', '[{event="PreToolUse",command="owner-check"}]']) {
      await writeFile(join(root, 'config.toml'), `hooks = ${hooks}\n[providers.owner]\napi_key="fixture-owner"\n`);
      await ensureKimiSecretHooks({ KIMI_CODE_HOME: root });
      const config = parse(await readFile(join(root, 'config.toml'), 'utf8'));
      assert.deepEqual(config.providers, { owner: { api_key: 'fixture-owner' } });
      assert.equal((config.hooks as unknown[]).length, hooks === '[]' ? 2 : 3);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent native Kimi registrations serialize a first install without dropping either member', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secret-kimi-concurrent-'));
  try {
    const installs = await Promise.allSettled(
      Array.from({ length: 3 }, () => ensureKimiSecretHooks({ KIMI_CODE_HOME: root })),
    );
    assert.ok(installs.every((result) => result.status === 'fulfilled'));
    assert.equal((parse(await readFile(join(root, 'config.toml'), 'utf8')).hooks as unknown[]).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
