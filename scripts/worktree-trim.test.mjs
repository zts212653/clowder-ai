import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, git, idle, SOURCE } from './lib/worktree-finish-fixture.mjs';
import { trimWorktree } from './worktree-trim.mjs';

function context(t) {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const path = f.make();
  const write = (name, content = name) => {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), content);
  };
  const trim = (overrides = {}) =>
    trimWorktree({
      repo: f.repo,
      path,
      owner: 'codex61-sol',
      sourceRef: SOURCE,
      dataRoot: join(f.root, 'data'),
      cwdProbe: idle,
      ...overrides,
    });
  return { ...f, path, write, trim };
}

test('trim drops compilation caches and preserves dependencies, production outputs, runtime cache and originals', (t) => {
  const f = context(t);
  const generated = ['webpack', 'swc', 'next-minifier'].map((name) => `packages/web/.next/cache/${name}/cache.pack`);
  const preserved = [
    'README.md',
    'WIP.txt',
    '.env.local',
    '.cat-cafe/evidence/proof.json',
    'node_modules/keep.txt',
    'packages/shared/dist/index.js',
    'packages/api/dist/index.js',
    'packages/web/.next/BUILD_ID',
    'packages/web/.next/static/bundle.js',
    'packages/web/.next/cache/images/image.png',
    'packages/web/.next/cache/fetch-cache/response.json',
    'packages/web/test-results/proof.png',
  ];
  for (const name of [...generated, ...preserved]) f.write(name);
  const receipt = f.trim();
  assert.equal(receipt.state, 'trimmed');
  for (const name of generated) assert.equal(existsSync(join(f.path, name)), false, name);
  for (const name of preserved) assert.equal(readFileSync(join(f.path, name), 'utf8'), name);
  assert.equal(f.trim().state, 'unchanged');
});

test('queued and newly observed consumers refuse trim without removing the cache', (t) => {
  const f = context(t);
  const cache = 'packages/web/.next/cache/webpack/cache.pack';
  f.write(cache);
  let probes = 0;
  assert.throws(
    () =>
      f.trim({
        cwdProbe() {
          return ++probes === 2 ? { cwds: [f.path], argv: [] } : idle();
        },
      }),
    /busy/,
  );
  assert.equal(readFileSync(join(f.path, cache), 'utf8'), cache);
  const dir = join(f.root, 'data', 'managed-jobs');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'supervisor.sqlite'));
  db.exec('CREATE TABLE managed_jobs(job_id TEXT, state TEXT, record_json TEXT)');
  db.prepare('INSERT INTO managed_jobs VALUES(?,?,?)').run(
    'queued-trim',
    'queued',
    JSON.stringify({ descriptor: { definition: { cwd: f.path } } }),
  );
  db.close();
  assert.throws(() => f.trim(), /queued-trim/);
  assert.equal(existsSync(join(f.path, cache)), true);
});

test('owner, lock, protected Alpha, tracked cache and symlink boundaries remain intact', (t) => {
  const f = context(t);
  const cache = 'packages/web/.next/cache/webpack/cache.pack';
  f.write(cache);
  assert.throws(() => f.trim({ owner: 'other-cat' }), /owner/);
  git(f.repo, 'worktree', 'lock', f.path);
  assert.throws(() => f.trim(), /locked/);
  git(f.repo, 'worktree', 'unlock', f.path);
  git(f.path, 'config', '--worktree', 'catcafe.lifecycle.policy', 'never');
  assert.throws(() => f.trim(), /never-policy/);
  git(f.path, 'config', '--worktree', 'catcafe.lifecycle.policy', 'merged');
  const alpha = f.make('cat-cafe-alpha-trim');
  assert.throws(() => f.trim({ path: alpha }), /Alpha/);
  git(f.path, 'add', '-f', cache);
  assert.throws(() => f.trim(), /tracked source/);
  git(f.path, 'reset', '--', cache);
  const external = join(f.root, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'original'), 'original');
  rmSync(join(f.path, 'packages/web/.next/cache/webpack'), { recursive: true });
  symlinkSync(external, join(f.path, 'packages/web/.next/cache/webpack'));
  assert.throws(() => f.trim(), /not local/);
  assert.equal(readFileSync(join(external, 'original'), 'utf8'), 'original');
});

test('rename failure never falls back to deleting the original directory', (t) => {
  const f = context(t);
  const cache = 'packages/web/.next/cache/webpack/cache.pack';
  f.write(cache);
  try {
    mock.method(fs, 'renameSync', () => {
      throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
    });
    syncBuiltinESMExports();
    assert.throws(() => f.trim(), /EXDEV/);
    assert.equal(readFileSync(join(f.path, cache), 'utf8'), cache);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(f.trim().state, 'trimmed');
});

test('a recreated cache survives while interrupted detached cache deletion is resumable', (t) => {
  const f = context(t);
  const cache = 'packages/web/.next/cache/webpack/cache.pack';
  f.write(cache, 'old cache');
  const rename = fs.renameSync;
  try {
    mock.method(fs, 'renameSync', (from, to) => {
      rename(from, to);
      f.write(cache, 'new cache');
    });
    mock.method(fs, 'rmSync', () => {
      throw new Error('injected delete interruption');
    });
    syncBuiltinESMExports();
    assert.throws(() => f.trim(), /interruption/);
    assert.equal(readFileSync(join(f.path, cache), 'utf8'), 'new cache');
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  const staging = join(f.path, 'packages/web/.next/cache/.cat-cafe-trim');
  assert.equal(fs.readdirSync(staging).length, 1);
  try {
    mock.method(fs, 'renameSync', (from, to) => {
      rename(from, to);
      f.write(cache, 'concurrent rebuild');
    });
    syncBuiltinESMExports();
    assert.equal(f.trim().state, 'trimmed');
    assert.equal(readFileSync(join(f.path, cache), 'utf8'), 'concurrent rebuild');
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(fs.readdirSync(staging).length, 0);
});

test('the real CLI trims an absolute target through a shell wrapper', (t) => {
  const f = context(t);
  f.write('packages/web/.next/cache/webpack/cache.pack');
  const script = fileURLToPath(new URL('./worktree-trim.mjs', import.meta.url));
  const result = execFileSync(
    '/bin/sh',
    ['-c', '"$@" && :', 'wrapper', process.execPath, script, f.path, '--source-ref', SOURCE],
    {
      cwd: f.repo,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_CAT_ID: 'codex61-sol', CAT_CAFE_DATA_DIR: join(f.root, 'data') },
    },
  );
  assert.equal(JSON.parse(result).state, 'trimmed');
  assert.equal(existsSync(join(f.path, 'README.md')), true);
});
