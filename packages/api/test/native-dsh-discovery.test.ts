import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverDshRuntime } from '../src/routes/native-dsh-discovery.js';
import { dshLauncherProfileState, dshProfileState } from '../src/routes/native-dsh-profile.js';

test('fresh catalog can discover an existing DSH npx installation and ACP profile without creating a member', (t) => {
  // The cached-package fixture owns its Node lookup; host PATH aliases are not
  // evidence about DSH discovery or the profile initialization boundary.
  t.mock.method(childProcess, 'execSync', (command: string) => {
    assert.match(command, /^(where node\.exe|which node)$/);
    return process.execPath;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const root = mkdtempSync(join(tmpdir(), 'dsh-discovery-'));
  const dshHome = join(root, '.dsh');
  const cache = join(root, 'npm-cache');
  const pkg = join(cache, '_npx', 'cached', 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }));
  writeFileSync(join(pkg, 'lib/bin.js'), '');
  const options = { dshHome, npmCaches: [cache], resolveCommand: () => null };
  const pending = discoverDshRuntime(options);
  assert.equal(pending.installed, true);
  assert.equal(pending.discoveryStatus, 'acp_profile_missing');
  assert.deepEqual(pending.acp?.startupArgs, [join(pkg, 'lib/bin.js'), '--profile', 'acp']);
  assert.equal(existsSync(dshHome), false, 'discovery must not initialize the profile');
  mkdirSync(join(dshHome, 'profiles/acp'), { recursive: true });
  writeFileSync(
    join(dshHome, 'profiles/acp/package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-acp-app'] } } }),
  );
  const runtime = discoverDshRuntime(options);
  assert.equal(runtime.installed, true);
  assert.deepEqual(runtime.acp?.startupArgs, [join(pkg, 'lib/bin.js'), '--profile', 'acp']);
  assert.equal(runtime.command, process.execPath);
  assert.equal(runtime.discoveryStatus, 'configured');
  for (const invalid of [
    '{broken',
    '{}',
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }),
  ]) {
    const path = join(dshHome, 'profiles/acp/package.json');
    writeFileSync(path, invalid);
    const blocked = discoverDshRuntime(options);
    assert.equal(blocked.installed, true);
    assert.equal(blocked.discoveryStatus, 'acp_profile_invalid');
    assert.equal(blocked.acp, undefined);
    assert.equal(readFileSync(path, 'utf8'), invalid, 'bad existing profiles must never be repaired during discovery');
  }
});

test('an ACP profile is not an executable installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-uninstalled-'));
  mkdirSync(join(root, 'profiles/acp'), { recursive: true });
  writeFileSync(
    join(root, 'profiles/acp/package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-acp-app'] } } }),
  );
  const runtime = discoverDshRuntime({ dshHome: root, npmCaches: [], resolveCommand: () => null });
  assert.equal(runtime.installed, false);
  assert.equal(runtime.discoveryStatus, 'not_installed');
  assert.equal(runtime.acp, undefined);
});

test('only the shipped ACP profile is advertised as safely initializable; partial configuration is preserved', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-contract-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    assert.equal(dshLauncherProfileState('dsh', ['--profile', 'custom'], root), 'custom_startup');
    assert.equal(dshLauncherProfileState('dsh', ['--profile', 'acp'], root), 'acp_profile_missing');
    const directory = join(root, 'profiles/acp');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'cordis.patch.yml'), 'existing: preserve');
    assert.equal(dshProfileState(root), 'acp_profile_invalid');
    assert.equal(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'), 'existing: preserve');
    assert.equal(existsSync(join(directory, 'package.json')), false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
