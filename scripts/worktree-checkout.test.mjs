import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fixture, git } from './lib/worktree-finish-fixture.mjs';
import { createWorktree } from './worktree-new.mjs';

function setup(t) {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const put = (name, content) => {
    mkdirSync(dirname(join(f.repo, name)), { recursive: true });
    writeFileSync(join(f.repo, name), content);
  };
  const commit = () => {
    git(f.repo, 'add', '-f', '.');
    git(f.repo, 'commit', '-qm', 'checkout inputs');
    git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  };
  const copied = [];
  const checkoutOptions = {
    supportsClone: () => true,
    cloneBatch(files) {
      for (const file of files) {
        copyFileSync(file.source, file.destination);
        copied.push(file.name);
      }
    },
  };
  const path = join(f.root, 'cat-cafe-copy');
  const create = (options = {}) =>
    createWorktree({ repo: f.repo, path, branch: 'test/copy', owner: 'codex61-sol', checkoutOptions, ...options });
  return { ...f, put, commit, copied, checkoutOptions, path, create };
}

// Uses real Git/index/attributes; the copy seam only substitutes the filesystem clone syscall.
test('clone checkout includes historical media, preserves verified copies and keeps an independent clean index', (t) => {
  const f = setup(t);
  const media = 'docs/evidence/old/small and large\nimage.png';
  f.put(media, Buffer.alloc(1024 * 1024, 7));
  f.commit();
  git(f.repo, 'update-index', '--assume-unchanged', 'README.md');
  f.create();
  assert.equal(existsSync(join(f.path, media)), true, 'clone creation must not defer historical media');
  assert.ok(f.copied.includes(media));
  assert.equal(git(f.path, 'status', '--porcelain'), '');
  assert.equal(
    git(f.path, 'ls-files', '-v')
      .split('\n')
      .some((line) => /^[a-zS] /.test(line)),
    false,
  );
  writeFileSync(join(f.path, media), 'branch change');
  assert.equal(readFileSync(join(f.repo, media)).length, 1024 * 1024);
  assert.match(git(f.path, 'status', '--porcelain'), /image\.png/);
});

test('dirty, raced, missing and different blobs come from Git; attribute conversions and symlinks stay Git-owned', (t) => {
  const f = setup(t);
  for (const name of [
    'dirty.txt',
    'raced.txt',
    'missing.txt',
    'changed.txt',
    'crlf.txt',
    'encoded.txt',
    'filtered.txt',
  ])
    f.put(name, `committed ${name}\n`);
  f.put(
    '.gitattributes',
    'crlf.txt text eol=crlf\nencoded.txt working-tree-encoding=UTF-16LE\nfiltered.txt filter=stamp\n',
  );
  symlinkSync('README.md', join(f.repo, 'link'));
  // Encoding inputs are raw Git blobs; checkout alone must apply the target attributes.
  git(f.repo, 'add', '-f', '.gitattributes', 'README.md', 'link');
  for (const name of [
    'dirty.txt',
    'raced.txt',
    'missing.txt',
    'changed.txt',
    'crlf.txt',
    'encoded.txt',
    'filtered.txt',
  ]) {
    const oid = git(f.repo, 'hash-object', '-w', '--no-filters', name).trim();
    git(f.repo, 'update-index', '--add', '--cacheinfo', `100644,${oid},${name}`);
  }
  git(f.repo, 'commit', '-qm', 'raw inputs');
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  f.put('changed.txt', 'new main blob\n');
  git(f.repo, 'add', 'changed.txt');
  git(f.repo, 'commit', '-qm', 'different main');
  f.put('dirty.txt', 'uncommitted main\n');
  rmSync(join(f.repo, 'missing.txt'));
  git(f.repo, 'config', 'filter.stamp.smudge', 'sed s/committed/smudged/');
  git(f.repo, 'config', 'filter.stamp.clean', 'sed s/smudged/committed/');
  const original = f.checkoutOptions.cloneBatch;
  f.checkoutOptions.cloneBatch = (files) => {
    if (files.some((file) => file.name === 'raced.txt')) f.put('raced.txt', 'changed during clone\n');
    original(files);
  };
  f.create();
  for (const name of ['dirty.txt', 'raced.txt'])
    assert.ok(f.copied.includes(name), `${name} exercised clone verification`);
  for (const name of ['dirty.txt', 'raced.txt', 'missing.txt', 'changed.txt'])
    assert.equal(readFileSync(join(f.path, name), 'utf8'), `committed ${name}\n`);
  for (const name of ['crlf.txt', 'encoded.txt', 'filtered.txt', 'link', 'missing.txt', 'changed.txt'])
    assert.equal(f.copied.includes(name), false, `${name} must be checked out by Git`);
  assert.equal(readFileSync(join(f.path, 'crlf.txt'), 'utf8'), 'committed crlf.txt\r\n');
  assert.equal(readFileSync(join(f.path, 'encoded.txt')).toString('utf16le'), 'committed encoded.txt\n');
  assert.equal(readFileSync(join(f.path, 'filtered.txt'), 'utf8'), 'smudged filtered.txt\n');
  assert.equal(readFileSync(join(f.repo, 'dirty.txt'), 'utf8'), 'uncommitted main\n');
  assert.equal(git(f.path, 'status', '--porcelain'), '');
});

test('unsupported clone uses the existing light/full Git checkouts and a failed batch falls back per file', (t) => {
  const f = setup(t);
  const media = 'docs/history/image.png';
  f.put(media, Buffer.alloc(1024 * 1024, 9));
  f.commit();
  f.checkoutOptions.supportsClone = () => false;
  f.create();
  assert.equal(existsSync(join(f.path, media)), false);
  assert.equal(git(f.path, 'status', '--porcelain'), '');
  const full = join(f.root, 'cat-cafe-full');
  f.create({ path: full, branch: 'test/full', full: true });
  assert.equal(existsSync(join(full, media)), true);
  assert.equal(git(full, 'status', '--porcelain'), '');
  f.checkoutOptions.supportsClone = () => true;
  f.checkoutOptions.cloneBatch = () => {
    throw new Error('clone failed');
  };
  const failed = join(f.root, 'cat-cafe-failed');
  f.create({ path: failed, branch: 'test/failed' });
  assert.equal(readFileSync(join(failed, media)).length, 1024 * 1024);
  assert.equal(git(failed, 'status', '--porcelain'), '');
});

test('inherited sparse exclusions become visible only in the new checkout; executable modes match its target', (t) => {
  const f = setup(t);
  f.put('bin/tool.sh', '#!/bin/sh\nexit 0\n');
  f.put('docs/hidden.txt', 'visible in the new checkout\n');
  f.commit();
  git(f.repo, 'update-index', '--chmod=+x', 'bin/tool.sh');
  git(f.repo, 'commit', '-qm', 'executable');
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(f.repo, 'sparse-checkout', 'set', '--no-cone', '/README.md', '/bin/');
  assert.equal(existsSync(join(f.repo, 'docs/hidden.txt')), false);
  f.create();
  assert.equal(readFileSync(join(f.path, 'docs/hidden.txt'), 'utf8'), 'visible in the new checkout\n');
  assert.equal(git(f.path, 'status', '--porcelain'), '');
  assert.equal(
    git(f.path, 'ls-files', '-v')
      .split('\n')
      .some((line) => line.startsWith('S ')),
    false,
  );
  assert.equal(git(f.repo, 'config', '--bool', 'core.sparseCheckout').trim(), 'true');
  assert.equal(existsSync(join(f.repo, 'docs/hidden.txt')), false);
  assert.ok(f.copied.includes('bin/tool.sh'));
  assert.ok(statSync(join(f.path, 'bin/tool.sh')).mode & 0o111);
});

test('core.autocrlf conversions are performed by Git even without gitattributes', (t) => {
  const f = setup(t);
  git(f.repo, 'config', 'core.autocrlf', 'true');
  f.create();
  assert.equal(f.copied.length, 0);
  assert.equal(readFileSync(join(f.path, 'README.md'), 'utf8'), 'original\r\n');
  assert.equal(git(f.path, 'status', '--porcelain'), '');
});

test('dirty source gitattributes cannot change checkout or verification rules', (t) => {
  const f = setup(t);
  f.put('.gitattributes', '# target checkout rules\n');
  f.commit();
  git(f.repo, 'config', 'filter.stamp.clean', 'sed s/original/changed/');
  git(f.repo, 'config', 'filter.stamp.smudge', 'sed s/original/changed/');
  f.put('.gitattributes', 'README.md filter=stamp\n');
  f.create();
  assert.equal(readFileSync(join(f.path, '.gitattributes'), 'utf8'), '# target checkout rules\n');
  assert.equal(readFileSync(join(f.path, 'README.md'), 'utf8'), 'original\n');
  assert.ok(f.copied.includes('README.md'));
  assert.equal(git(f.path, 'status', '--porcelain'), '');
});

test('full Alpha-compatible creation preserves the post-checkout hook without overwriting copied files', (t) => {
  const f = setup(t);
  const hooks = join(f.root, 'hooks');
  mkdirSync(hooks);
  const marker = join(f.root, 'hook-result');
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ngit status --porcelain > '${marker}'\n`, { mode: 0o755 });
  git(f.repo, 'config', 'core.hooksPath', hooks);
  f.create({ full: true });
  assert.equal(readFileSync(marker, 'utf8'), '');
  assert.ok(f.copied.includes('README.md'));
});

test('a full post-checkout hook failure preserves work committed by the hook', (t) => {
  const f = setup(t);
  const hooks = join(f.root, 'hooks');
  mkdirSync(hooks);
  writeFileSync(
    join(hooks, 'post-checkout'),
    '#!/bin/sh\ngit -c user.name=fixture -c user.email=fixture@example.invalid commit --allow-empty -qm "hook work"\nexit 1\n',
    {
      mode: 0o755,
    },
  );
  git(f.repo, 'config', 'core.hooksPath', hooks);
  assert.throws(() => f.create({ full: true }));
  assert.equal(existsSync(f.path), true);
  assert.equal(git(f.repo, 'log', '-1', '--format=%s', 'test/copy').trim(), 'hook work');
});
