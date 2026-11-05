import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRIVATE_OBSERVER_SHA256 } from './wait-private-observer.mjs';

test('Windows-style Git checkout preserves the reviewed observer bytes while ordinary text still converts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f330-observer-checkout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const relative = '.github/desktop-acceptance';
  const target = path.join(root, relative);
  fs.mkdirSync(target, { recursive: true });
  const runtimeNames = ['collective-windows-private-observer.cjs', 'collective-windows-private-observer-baseline.cjs'];
  for (const name of runtimeNames) fs.copyFileSync(path.join(directory, name), path.join(target, name));
  const attributes = path.join(directory, '.gitattributes');
  if (fs.existsSync(attributes)) fs.copyFileSync(attributes, path.join(target, '.gitattributes'));
  fs.writeFileSync(path.join(target, 'ordinary.txt'), 'ordinary text\n');
  const globalConfig = path.join(root, 'empty-global-config');
  fs.writeFileSync(globalConfig, '');
  const hooks = path.join(root, 'empty-hooks');
  fs.mkdirSync(hooks);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_COUNT: '0',
    NODE_OPTIONS: '',
  };
  for (const key of [
    'GIT_DIR',
    'GIT_COMMON_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'CAT_CAFE_WINDOWS_PRIVATE_OBSERVER_OUTPUT',
  ])
    delete env[key];
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git('init', '--quiet');
  git('config', 'core.hooksPath', hooks);
  git('config', 'user.name', 'F330 fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('add', relative);
  git('commit', '--quiet', '-m', 'checkout fixture');
  git('config', 'core.autocrlf', 'true');
  for (const name of [...runtimeNames, 'ordinary.txt']) fs.rmSync(path.join(target, name));
  git('checkout', '--', relative);
  assert.ok(fs.readFileSync(path.join(target, 'ordinary.txt')).includes(Buffer.from('\r\n')));
  const digest = spawnSync(process.execPath, [path.join(target, runtimeNames[0]), '--sha256'], {
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(digest.status, 0, digest.stderr);
  assert.equal(digest.stdout.trim(), PRIVATE_OBSERVER_SHA256);
});
