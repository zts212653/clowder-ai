import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { redisDevRegistryDir, redisTestRegistryDir } from '../../../scripts/lib/redis-test-leases.mjs';
import { testTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import { terminateChild } from '../scripts/with-test-home.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = resolve(here, '../scripts/with-test-home.mjs');
const shellWrapper = resolve(here, '../scripts/with-test-home.sh');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

test(
  'Windows test roots require a drive or UNC before filesystem access',
  { skip: process.platform !== 'win32' },
  () => {
    for (const value of ['/tmp', '\\tmp', 'C:tmp', 'relative-temp']) {
      assert.throws(() => testTempRoot(value), /Windows drive or UNC/);
    }
    for (const value of ['C:\\Temp', 'D:/Temp', '\\\\server\\share\\Temp']) assert.equal(testTempRoot(value), value);
  },
);

test('direct template imports use native temp even with TMPDIR=/tmp', { skip: process.platform !== 'win32' }, (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'direct-template-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const template = join(outer, 'source.json');
  writeFileSync(template, '{}');
  const env = { ...process.env, TMPDIR: '/tmp' };
  delete env.CAT_CAFE_TEST_TEMPLATE_ROOT;
  const probe = `
    const {createIsolatedTemplateRoot} = await import(process.argv[1]);
    const isolated = createIsolatedTemplateRoot(process.argv[2]);
    console.log(JSON.stringify({root:isolated.root}));
    isolated.cleanup();
  `;
  for (const cwd of [tmpdir(), resolve(here, '..')]) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        probe,
        new URL('./helpers/isolated-template-root.js', import.meta.url).href,
        template,
      ],
      { cwd, env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const { root } = JSON.parse(result.stdout);
    assert.equal(dirname(root), tmpdir());
    assert.equal(existsSync(root), false);
  }
});

test(
  'wrapper rejects a drive-relative Windows TEMP without running the child',
  { skip: process.platform !== 'win32' },
  () => {
    for (const value of ['/tmp', 'relative-temp']) {
      const result = spawnSync(process.execPath, [wrapper, process.execPath, '-e', "console.log('unexpected-child')"], {
        env: { ...process.env, TEMP: value, TMP: value },
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Windows drive or UNC/);
    }
  },
);

test('Redis registries use the native temporary root and retain explicit registry overrides', () => {
  assert.equal(redisTestRegistryDir({}), join(tmpdir(), 'cat-cafe-redis-tests'));
  assert.equal(redisDevRegistryDir({}), join(tmpdir(), 'cat-cafe-redis-dev'));
  const custom = join(tmpdir(), 'owned-registry');
  assert.equal(redisTestRegistryDir({ CAT_CAFE_REDIS_TEST_REGISTRY_DIR: custom }), custom);
  assert.equal(redisDevRegistryDir({ CAT_CAFE_REDIS_DEV_REGISTRY_DIR: custom }), custom);
});

for (const terminate of [false, true]) {
  test(`parent reclaims template copies after child ${terminate ? 'termination' : 'success'}`, (t) => {
    const outer = mkdtempSync(join(tmpdir(), 'template-parent-'));
    t.after(() => rmSync(outer, { recursive: true, force: true }));
    const inherited = join(outer, 'inherited');
    mkdirSync(inherited);
    writeFileSync(join(inherited, 'keep'), 'outer-owned');
    const template = join(outer, 'source.json');
    writeFileSync(template, '{}');
    const probe = `
      const fs = await import('node:fs');
      const {createIsolatedTemplateRoot} = await import(process.argv[1]);
      const {root} = createIsolatedTemplateRoot(process.argv[2]);
      fs.writeSync(1, JSON.stringify({home:process.env.HOME, root}));
      ${terminate ? "process.kill(process.pid, 'SIGKILL');" : ''}
    `;
    const result = spawnSync(
      process.execPath,
      [
        wrapper,
        process.execPath,
        '--input-type=module',
        '-e',
        probe,
        new URL('./helpers/isolated-template-root.js', import.meta.url).href,
        template,
      ],
      {
        env: { ...process.env, CAT_CAFE_TEST_TEMPLATE_ROOT: inherited },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status === 0, !terminate, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(existsSync(observed.home), false, 'the run HOME is reclaimed');
    assert.equal(existsSync(observed.root), false, 'copies survive child termination only until parent cleanup');
    assert.ok(!relative(observed.home, observed.root).startsWith('..'), 'templates belong to this run');
    assert.equal(readFileSync(join(inherited, 'keep'), 'utf8'), 'outer-owned');
  });
}

for (const status of [0, 7]) {
  test(`Bash wrapper preserves cwd and exit ${status}, then removes its HOME`, (t) => {
    const outer = mkdtempSync(join(tmpdir(), 'shell-home-'));
    t.after(() => rmSync(outer, { recursive: true, force: true }));
    const cwd = join(outer, 'caller cwd');
    mkdirSync(cwd);
    const probe = join(outer, 'probe.mjs');
    writeFileSync(
      probe,
      `console.log(JSON.stringify({home:process.env.HOME,cwd:process.cwd()}));process.exitCode=${status};`,
    );
    const result = spawnSync(bash, [shellWrapper, process.execPath, probe], {
      cwd,
      env: { ...process.env, TMPDIR: outer.replaceAll('\\', '/') },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, status, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.cwd, realpathSync(cwd));
    assert.equal(existsSync(observed.home), false, 'normal child exit must execute wrapper cleanup');
  });
}

test('nested wrappers own separate lazy template roots', () => {
  const inner = `console.log(JSON.stringify({home:process.env.HOME,root:process.env.CAT_CAFE_TEST_TEMPLATE_ROOT,
    entries:require('node:fs').readdirSync(process.env.HOME)}));`;
  const outer = `
    const {spawnSync}=require('node:child_process');
    const result=spawnSync(process.execPath,[process.argv[1],process.execPath,'-e',process.argv[2]],{encoding:'utf8'});
    if(result.status!==0) throw new Error(result.stderr);
    console.log(JSON.stringify({home:process.env.HOME,root:process.env.CAT_CAFE_TEST_TEMPLATE_ROOT,
      inner:JSON.parse(result.stdout)}));
  `;
  const result = spawnSync(process.execPath, [wrapper, process.execPath, '-e', outer, wrapper, inner], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.notEqual(observed.inner.root, observed.root);
  assert.equal(dirname(observed.root), observed.home);
  assert.equal(dirname(observed.inner.root), observed.inner.home);
  assert.deepEqual(observed.inner.entries, [], 'template directories are created only when imported');
  assert.equal(existsSync(observed.inner.home), false);
  assert.equal(existsSync(observed.home), false);
});

test('Bash wrapper forwards TERM and waits before cleaning HOME', { timeout: 15_000 }, async (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'shell-term-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const ready = join(outer, 'ready');
  const home = join(outer, 'home');
  const script = join(outer, 'child.sh');
  writeFileSync(
    script,
    `#!/usr/bin/env bash
trap 'test -d "$HOME" || exit 99; exit 23' TERM
printf '%s' "$HOME" > "$TERM_HOME_FILE"
printf ready > "$TERM_READY_FILE"
while true; do sleep 0.05; done
`,
  );
  const driver = `
    bash "$1" bash "$2" & child=$!
    for i in {1..100}; do test -f "$TERM_READY_FILE" && break; sleep 0.05; done
    kill -TERM "$child"
    wait "$child"
    exit $?
  `;
  const child = spawn(bash, ['-c', driver, '_', shellWrapper, script], {
    env: { ...process.env, TMPDIR: outer.replaceAll('\\', '/'), TERM_HOME_FILE: home, TERM_READY_FILE: ready },
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) terminateChild(child, 'SIGTERM');
  });
  const exited = once(child, 'close');
  const [status] = await exited;
  assert.equal(status, 23, 'forward TERM and preserve the handled child exit code');
  const observedHome = readFileSync(home, 'utf8');
  const nativeHome = process.platform === 'win32' ? observedHome.replace(/^\/([a-z])\//i, '$1:/') : observedHome;
  assert.equal(existsSync(nativeHome), false);
});
