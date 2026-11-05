import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareAgyNativeKeychain } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-keychain.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-private-keychain-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileHome = join(root, 'profile');
  mkdirSync(profileHome);
  const keychain = join(profileHome, 'Library/Keychains/cat-cafe.keychain-db');
  const plist = join(profileHome, 'Library/Preferences/com.apple.security.plist');
  const calls = [];
  let currentDefault = [];
  let search = [];
  const execute = async (home, args) => {
    assert.equal(home, profileHome);
    calls.push(args);
    const operation = args[0];
    if (operation === 'create-keychain') writeFileSync(args.at(-1), 'synthetic keychain fixture');
    if (operation === 'default-keychain' && args.includes('-s')) currentDefault = [args.at(-1)];
    if (operation === 'list-keychains' && args.includes('-s')) search = [args.at(-1)];
    if (args.includes('-s')) writeFileSync(plist, 'synthetic preferences');
    if (operation === 'default-keychain') return currentDefault.map(JSON.stringify).join('\n');
    if (operation === 'list-keychains') return search.map(JSON.stringify).join('\n');
    return '';
  };
  return { root, profileHome, keychain, plist, calls, execute, platform: 'darwin' };
}

test('creates only profile-owned keychain and preferences, preserving OAuth fallback data', async (t) => {
  const f = fixture(t);
  const oauth = join(f.profileHome, '.gemini/antigravity-cli/antigravity-oauth-token');
  mkdirSync(join(oauth, '..'), { recursive: true });
  writeFileSync(oauth, 'existing synthetic OAuth fixture');
  await prepareAgyNativeKeychain(f);
  assert.equal(statSync(f.keychain).mode & 0o777, 0o600);
  assert.equal(statSync(f.plist).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.profileHome, 'Library/Keychains')).mode & 0o777, 0o700);
  assert.equal(readFileSync(oauth, 'utf8'), 'existing synthetic OAuth fixture');
  assert.equal(f.calls.filter(([op]) => op === 'create-keychain').length, 1);
  await prepareAgyNativeKeychain(f);
  assert.equal(f.calls.filter(([op]) => op === 'create-keychain').length, 1, 'Never recreate an existing store');
  assert.equal(readFileSync(f.keychain, 'utf8'), 'synthetic keychain fixture');
  assert.equal(readFileSync(oauth, 'utf8'), 'existing synthetic OAuth fixture');
});

for (const relative of [
  'Library',
  'Library/Keychains',
  'Library/Preferences',
  'Library/Keychains/cat-cafe.keychain-db',
  'Library/Preferences/com.apple.security.plist',
]) {
  test(`refuses redirected profile storage at ${relative} before invoking security`, async (t) => {
    const f = fixture(t);
    const foreign = join(f.root, 'foreign');
    mkdirSync(foreign);
    const target = join(f.profileHome, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    symlinkSync(foreign, target);
    await assert.rejects(prepareAgyNativeKeychain(f), /must not redirect or share/);
    assert.equal(f.calls.length, 0);
  });
}

test('refuses a shared keychain inode before unlocking or changing it', async (t) => {
  const f = fixture(t);
  const foreign = join(f.root, 'foreign.keychain-db');
  writeFileSync(foreign, 'other profile');
  mkdirSync(join(f.keychain, '..'), { recursive: true });
  linkSync(foreign, f.keychain);
  await assert.rejects(prepareAgyNativeKeychain(f), /must not redirect or share/);
  assert.equal(f.calls.length, 0);
  assert.equal(readFileSync(foreign, 'utf8'), 'other profile');
});

for (const operation of ['default-keychain', 'list-keychains']) {
  test(`does not replace an operator-provided ${operation}`, async (t) => {
    const f = fixture(t);
    await assert.rejects(
      prepareAgyNativeKeychain({
        ...f,
        execute: async (home, args) =>
          args[0] === operation ? JSON.stringify('/operator/login.keychain-db') : f.execute(home, args),
      }),
      /not private; refusing/,
    );
    assert.equal(existsSync(f.keychain), false);
    assert.equal(
      f.calls.some(([op]) => op === 'create-keychain'),
      false,
    );
  });
}

test('a private store unlock failure stops before redirecting keychain preferences', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    prepareAgyNativeKeychain({
      ...f,
      execute: async (home, args) => {
        if (args[0] === 'unlock-keychain') throw new Error('private store password does not match');
        return f.execute(home, args);
      },
    }),
    /password does not match/,
  );
  assert.equal(
    f.calls.some((args) => args.includes('-s')),
    false,
  );
});

test('never provisions the operator HOME and does nothing on other platforms', async (t) => {
  const f = fixture(t);
  await assert.rejects(prepareAgyNativeKeychain({ ...f, profileHome: homedir() }), /operator HOME/);
  for (const platform of ['linux', 'win32']) await prepareAgyNativeKeychain({ ...f, platform });
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(join(f.profileHome, 'Library')), false);
});
