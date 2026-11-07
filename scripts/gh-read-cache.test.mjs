import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const shim = resolve(process.env.CAT_CAFE_TEST_GH_SHIM_PATH ?? 'scripts/guarded-bin/gh');
const roots = [];
const rows = [{ number: 332, title: 'all fields survive', body: '\u5b8c\u6574\u6b63\u6587'.repeat(18000) }];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gh-read-cache-test-'));
  roots.push(root);
  const cacheHome = join(root, 'shared-cache');
  mkdirSync(join(cacheHome, 'gh'), { recursive: true });
  const entry = join(cacheHome, 'gh', 'response.json');
  const poison = '{{"data":{"SearchType":{"enumValues":[{"name":"DISCUSSION}}]}}}';
  writeFileSync(entry, poison);
  const delegate = join(root, 'gh');
  writeFileSync(
    delegate,
    `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.GH_TEST_ROOT;
const id = process.env.GH_TEST_ID;
const home = process.env.XDG_CACHE_HOME;
const dir = join(home, 'gh');
mkdirSync(dir, { recursive: true });
writeFileSync(join(root, id + '.receipt'), JSON.stringify({ home, args: process.argv.slice(2) }));
const mode = process.env.GH_TEST_MODE;
if (mode === 'inspect') process.exit(0);
const entry = join(dir, 'response.json');
if (mode === 'parallel') {
  writeFileSync(entry, JSON.stringify([{ writer: id }]));
  writeFileSync(join(root, id + '.ready'), 'ready');
  const deadline = Date.now() + 5000;
  while (!['a', 'b', 'c'].every(name => existsSync(join(root, name + '.ready')))) {
    if (Date.now() > deadline) throw new Error('parallel writers did not rendezvous');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
} else if (!existsSync(entry)) {
  writeFileSync(entry, process.env.GH_TEST_ROWS);
}
const rows = JSON.parse(readFileSync(entry, 'utf8'));
if (mode === 'secret') rows[0].title = process.env.GH_TOKEN;
process.stdout.write(JSON.stringify(rows) + '\\n');
process.stderr.write('delegate stderr\\n');
process.exitCode = mode === 'fail' ? 7 : 0;
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    // Synthetic credential probes must never notify the launching runtime.
    CAT_CAFE_API_URL: '',
    CAT_CAFE_CREDENTIAL_FILE: '',
    CAT_CAFE_INVOCATION_ID: '',
    CAT_CAFE_CALLBACK_TOKEN: '',
    CAT_CAFE_REAL_GH_PATH: delegate,
    XDG_CACHE_HOME: cacheHome,
    GH_TEST_ROOT: root,
    GH_TEST_ROWS: JSON.stringify(rows),
    GH_TEST_ID: 'single',
    GH_TEST_MODE: 'normal',
  };
  return { root, cacheHome, entry, poison, env };
}

function run(f, args, extra = {}) {
  return spawnSync(shim, args, { env: { ...f.env, ...extra }, encoding: 'utf8', maxBuffer: 2 ** 22, timeout: 10000 });
}

function receipt(f, id = 'single') {
  return JSON.parse(readFileSync(join(f.root, `${id}.receipt`), 'utf8'));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('native lists ignore poisoned shared cache, preserve arguments/full output and clean private cache', () => {
  const f = fixture();
  for (const args of [
    ['pr', 'list', '--search', 'F332', '--limit', '100', '--json', 'number,title,body'],
    ['pr', '-Rowner/repo', 'list', '--state', 'all'],
    ['--repo=owner/repo', 'pr', 'list'],
    ['issue', '--repo', 'owner/repo', 'list', '--search', 'clowder-ai 1859'],
    ['--hostname', 'github.com', 'issue', 'list'],
    ['pr', 'status'],
    ['issue', 'status'],
    ['pr', 'checks', '332', '--json', 'name,state'],
  ]) {
    const result = run(f, args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), rows);
    assert.equal(result.stderr, 'delegate stderr\n');
    const seen = receipt(f);
    assert.deepEqual(seen.args, args);
    assert.notEqual(seen.home, f.cacheHome);
    assert.equal(existsSync(seen.home), false, 'private cache must be removed after the delegate exits');
    assert.equal(readFileSync(f.entry, 'utf8'), f.poison, 'the caller cache must remain untouched');
  }
});

test('parallel list writers cannot read or overwrite another command cache', async () => {
  const f = fixture();
  const results = await Promise.all(
    ['a', 'b', 'c'].map(
      (id) =>
        new Promise((done, reject) => {
          const child = spawn(shim, ['issue', 'list'], {
            env: { ...f.env, GH_TEST_MODE: 'parallel', GH_TEST_ID: id },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10000,
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (data) => {
            stdout += data;
          });
          child.stderr.on('data', (data) => {
            stderr += data;
          });
          child.once('error', reject);
          child.once('close', (code) => done({ id, code, stdout, stderr }));
        }),
    ),
  );
  const homes = [];
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [{ writer: result.id }]);
    const { home } = receipt(f, result.id);
    homes.push(home);
    assert.equal(existsSync(home), false);
  }
  assert.equal(new Set(homes).size, results.length);
  assert.equal(readFileSync(f.entry, 'utf8'), f.poison);
});

test('delegate failure retains its status/output and still releases its private cache', () => {
  const f = fixture();
  const result = run(f, ['issue', 'list'], { GH_TEST_MODE: 'fail' });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), rows);
  assert.equal(result.stderr, 'delegate stderr\n');
  assert.equal(existsSync(receipt(f).home), false);
});

test('merging retains the guarded send path and isolates its implicit feature cache', () => {
  const f = fixture();
  const result = run(f, ['pr', 'merge', '332', '--squash', '--subject', 'Fixture merge', '--body', 'Fixture body']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), rows);
  assert.notEqual(receipt(f).home, f.cacheHome);
  assert.equal(existsSync(receipt(f).home), false);
  assert.equal(readFileSync(f.entry, 'utf8'), f.poison);
});

test('read output continues through credential redaction', () => {
  const f = fixture();
  const credential = ['ghp', '_', 'K'.repeat(36)].join('');
  const result = run(f, ['pr', 'list'], { GH_TEST_MODE: 'secret', GH_TOKEN: credential });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(credential));
  assert.match(result.stderr, /notice-pending/);
  assert.equal(JSON.parse(result.stdout)[0].body, rows[0].body);
  assert.equal(existsSync(receipt(f).home), false);
});

test('other commands retain their caller cache, including explicit API cache requests', () => {
  const f = fixture();
  for (const args of [
    ['api', '--cache', '1h', 'repos/owner/repo'],
    ['pr', 'view', '332'],
    ['search', 'issues', 'F332'],
  ]) {
    const result = run(f, args, { GH_TEST_MODE: 'inspect' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(receipt(f), { home: f.cacheHome, args });
    assert.equal(readFileSync(f.entry, 'utf8'), f.poison);
  }
});
