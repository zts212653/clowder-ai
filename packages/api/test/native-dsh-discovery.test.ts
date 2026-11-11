import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverDshRuntimes } from '../src/routes/native-dsh-discovery.js';
import { dshLauncherProfileState, dshProfileState } from '../src/routes/native-dsh-profile.js';

test('an ACP profile alone is not a Desktop installation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-uninstalled-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'profiles/acp'), { recursive: true });
  writeFileSync(
    join(root, 'profiles/acp/package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-acp-app'] } } }),
  );
  const runtime = (await discoverDshRuntimes({ desktopRoots: [] }))[0]!;
  assert.equal(runtime.installed, false);
  assert.equal(runtime.discoveryStatus, 'not_installed');
  assert.equal(runtime.acp, undefined);
});

test('legacy manual ACP launch inspection rejects invalid patches without repairing them', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-invalid-patch-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, 'profiles/acp');
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-acp-app'] } } }),
  );
  assert.equal(dshProfileState(home), 'configured', 'missing optional patches remain valid');
  [profile, home].forEach((directory) => {
    const path = join(directory, 'cordis.patch.yml');
    ['# no overrides remain\n', '', 'provider: custom\n', '- [broken\n'].forEach((patch) => {
      writeFileSync(path, patch);
      assert.equal(dshProfileState(home), 'acp_profile_invalid', `invalid patch at ${path}`);
      assert.equal(readFileSync(path, 'utf8'), patch);
    });
    writeFileSync(path, '# no overrides remain\n[]\n');
    assert.equal(dshProfileState(home), 'configured');
  });
  rmSync(profile, { recursive: true });
  assert.equal(dshProfileState(home), 'acp_profile_missing');
  writeFileSync(join(home, 'cordis.patch.yml'), '# shared patch cannot load\n');
  assert.equal(dshProfileState(home), 'acp_profile_invalid');
});

test('partial legacy profiles are preserved and custom launch flags stay explicit', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-contract-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(dshLauncherProfileState('dsh', ['--profile', 'custom'], root), 'custom_startup');
  assert.equal(dshLauncherProfileState('dsh', ['--profile', 'acp'], root), 'acp_profile_missing');
  const directory = join(root, 'profiles/acp');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'cordis.patch.yml'), 'existing: preserve');
  assert.equal(dshProfileState(root), 'acp_profile_invalid');
  assert.equal(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'), 'existing: preserve');
  assert.equal(existsSync(join(directory, 'package.json')), false);
});
