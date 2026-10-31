import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { directReleaseReceipt, removeFinishedWorktree } from './lib/worktree-direct-release.mjs';
import { fixture, git, idle, SOURCE } from './lib/worktree-finish-fixture.mjs';
import { moveToQuarantine, quarantineRoot } from './lib/worktree-quarantine.mjs';
import { lifecycleConfig } from './lib/worktree-reaper-probes.mjs';
import { ignoredOriginals } from './lib/worktree-release-archive.mjs';

describe('finished worktrees reclaim working copies and preserve originals', () => {
  let fx;
  beforeEach(() => {
    fx = fixture();
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  it('discards vendor WASM copies rebuilt by sync-vendor-assets while preserving neighboring originals', () => {
    writeFileSync(
      join(fx.repo, '.gitignore'),
      `${readFileSync(join(fx.repo, '.gitignore'), 'utf8')}\n/packages/web/public/vendor/\n`,
    );
    git(fx.repo, 'add', '.gitignore');
    git(fx.repo, 'commit', '-qm', 'declare generated vendor output');
    const path = fx.make();
    const generated = [
      'onnxruntime/ort-wasm-simd-threaded.wasm',
      'onnxruntime/ort-wasm-simd-threaded.mjs',
      'esbuild/esbuild.wasm',
    ];
    const originals = ['onnxruntime/custom-model.onnx', 'onnxruntime/ort-wasm-notes.txt', 'esbuild/custom.plugin.wasm'];
    for (const name of [...generated, ...originals]) {
      const file = join(path, 'packages/web/public/vendor', name);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, name);
    }
    const result = fx.finish(path);
    for (const name of generated)
      assert.equal(existsSync(join(result.archivePath, 'files/packages/web/public/vendor', name)), false);
    for (const name of originals)
      assert.equal(readFileSync(join(result.archivePath, 'files/packages/web/public/vendor', name), 'utf8'), name);
  });

  it('discards rebuildable collective package output instead of accumulating it as unique originals', () => {
    const path = fx.make();
    writeFileSync(
      join(path, '.gitignore'),
      `${readFileSync(join(path, '.gitignore'), 'utf8')}\n/packages/collective-service/dist/\n`,
    );
    mkdirSync(join(path, 'packages/collective-service/dist'), { recursive: true });
    writeFileSync(join(path, 'packages/collective-service/dist/index.js'), 'rebuildable output');
    const originals = ignoredOriginals(path);
    assert.equal(originals.includes('packages/collective-service/dist/index.js'), false);
  });

  it('removes source copies and generated caches, archiving only original ignored files and Git metadata', () => {
    const path = fx.make();
    for (const [name, text] of [
      ['node_modules/pkg/index.js', 'reinstall this'],
      ['packages/web/.next/cache/webpack.bin', 'rebuild this'],
      ['.cat-cafe/evidence/proof.txt', 'unique original'],
      ['.env.local', 'CONFIG=keep'],
    ]) {
      mkdirSync(join(path, name, '..'), { recursive: true });
      writeFileSync(join(path, name), text);
    }
    const result = fx.finish(path);
    assert.equal(result.storageDisposition, 'removed');
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(join(result.archivePath, 'files/node_modules')), false);
    assert.equal(existsSync(join(result.archivePath, 'files/packages/web/.next')), false);
    assert.equal(existsSync(join(result.archivePath, 'files/README.md')), false);
    assert.equal(
      readFileSync(join(result.archivePath, 'files/.cat-cafe/evidence/proof.txt'), 'utf8'),
      'unique original',
    );
    assert.equal(readFileSync(join(result.archivePath, 'files/.env.local'), 'utf8'), 'CONFIG=keep');
    assert.equal(existsSync(join(result.archivePath, 'git-metadata/HEAD')), true);
    assert.equal(fx.finish(path, { mode: 'check' }).storageDisposition, 'removed');
    assert.equal(readFileSync(join(fx.repo, 'README.md'), 'utf8'), 'original\n');
  });

  it('restores literal paths, original data and the source without rebuilding discarded dependencies', () => {
    const path = fx.make('cat-cafe-$(printf)');
    mkdirSync(join(path, '.cat-cafe'));
    writeFileSync(join(path, '.cat-cafe/data.txt'), 'restore me');
    const result = fx.finish(path);
    execFileSync('/bin/sh', ['-c', result.restore], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'original\n');
    assert.equal(readFileSync(join(path, '.cat-cafe/data.txt'), 'utf8'), 'restore me');
    assert.throws(() => fx.finish(path, { mode: 'check' }), /retained|receipt/);
  });

  it('keeps worktree-private reflog commits reachable after removal and Git pruning', () => {
    const path = fx.make();
    writeFileSync(join(path, 'abandoned.mjs'), 'historical work');
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'abandoned local history');
    const abandoned = git(path, 'rev-parse', 'HEAD').trim();
    git(path, 'reset', '--hard', 'HEAD~');
    fx.finish(path);
    git(fx.repo, 'reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all');
    git(fx.repo, 'gc', '--prune=now');
    assert.equal(git(fx.repo, 'show', `${abandoned}:abandoned.mjs`).trim(), 'historical work');
  });

  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    it(`refuses tracked originals hidden by ${flag} instead of trusting clean status`, () => {
      const path = fx.make();
      git(path, 'update-index', `--${flag}`, 'README.md');
      writeFileSync(join(path, 'README.md'), 'hidden unique source');
      assert.equal(git(path, 'status', '--porcelain').trim(), '');
      assert.throws(() => fx.finish(path), /hidden index flags/);
      assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'hidden unique source');
    });
  }

  it('keeps objects reachable only through a worktree-private ref after Git pruning', () => {
    const path = fx.make();
    const objectFile = join(fx.root, 'private-object.bin');
    writeFileSync(objectFile, 'private original object');
    const object = git(path, 'hash-object', '-w', objectFile).trim();
    git(path, 'update-ref', 'refs/worktree/private-original', object);
    fx.finish(path);
    git(fx.repo, 'reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all');
    git(fx.repo, 'gc', '--prune=now');
    assert.equal(git(fx.repo, 'cat-file', '-p', object).trim(), 'private original object');
  });

  it('does not certify missing or corrupted archived originals', () => {
    const path = fx.make();
    mkdirSync(join(path, '.cat-cafe'));
    writeFileSync(join(path, '.cat-cafe/proof.txt'), 'original');
    const result = fx.finish(path);
    writeFileSync(join(result.archivePath, 'files/.cat-cafe/proof.txt'), 'corrupted');
    assert.throws(() => fx.finish(path, { mode: 'check' }), /archive|original/);
  });

  it('refuses an original changed after archiving and leaves the checkout intact', () => {
    const path = fx.make();
    mkdirSync(join(path, '.cat-cafe'));
    writeFileSync(join(path, '.cat-cafe/proof.txt'), 'original');
    let probes = 0;
    assert.throws(
      () =>
        fx.finish(path, {
          cwdProbe: () => {
            if (++probes === 3) writeFileSync(join(path, '.cat-cafe/proof.txt'), 'new original');
            return idle();
          },
        }),
      /changed|original/,
    );
    assert.equal(readFileSync(join(path, '.cat-cafe/proof.txt'), 'utf8'), 'new original');
  });

  it('preserves ignored symlinks without following or deleting their external originals', () => {
    const path = fx.make();
    const external = join(fx.root, 'external-original');
    writeFileSync(external, 'outside data');
    mkdirSync(join(path, '.cat-cafe'));
    symlinkSync(external, join(path, '.cat-cafe/link'));
    const result = fx.finish(path);
    assert.equal(readFileSync(external, 'utf8'), 'outside data');
    assert.equal(existsSync(join(result.archivePath, 'files/.cat-cafe/link')), true);
  });

  it('refuses a symlinked recovery archive root before removing the checkout', () => {
    const path = fx.make();
    const outside = join(fx.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(fx.root, '.worktree-release-archives'));
    assert.throws(() => fx.finish(path), /archive|symlink/);
    assert.equal(existsSync(path), true);
  });

  it('requires a completed write-ahead release receipt, not an absent path alone', () => {
    const path = fx.make();
    const result = fx.finish(path);
    const ledger = join(quarantineRoot(fx.root), 'ledger.jsonl');
    writeFileSync(ledger, '');
    assert.throws(() => fx.finish(path, { mode: 'check' }), /receipt/);
    assert.equal(existsSync(result.archivePath), true);
  });

  it('preserves unknown ignored originals even when their directory name resembles build output', () => {
    writeFileSync(
      join(fx.repo, '.gitignore'),
      `${readFileSync(join(fx.repo, '.gitignore'), 'utf8')}\n/packages/custom/dist/\n/packages/web/.next-original/\n`,
    );
    git(fx.repo, 'add', '.gitignore');
    git(fx.repo, 'commit', '-qm', 'original artifact ignore rules');
    git(fx.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const path = fx.make();
    for (const name of ['packages/custom/dist/unique.bin', 'packages/web/.next-original/unique.bin']) {
      mkdirSync(join(path, name, '..'), { recursive: true });
      writeFileSync(join(path, name), 'original artifact');
    }
    const result = fx.finish(path);
    for (const name of ['packages/custom/dist/unique.bin', 'packages/web/.next-original/unique.bin'])
      assert.equal(readFileSync(join(result.archivePath, 'files', name), 'utf8'), 'original artifact');
  });

  it('does not let an old direct receipt hide a later full quarantine', () => {
    const path = fx.make();
    const released = fx.finish(path);
    execFileSync('/bin/sh', ['-c', released.restore]);
    const head = git(path, 'rev-parse', 'HEAD').trim();
    const quarantinePath = moveToQuarantine({
      repo: fx.repo,
      root: quarantineRoot(fx.root),
      entry: {
        path,
        name: 'cat-cafe-finish',
        registered: true,
        kind: 'worktree',
        head,
        lifecycle: lifecycleConfig(path, '--worktree'),
        finishSourceRef: SOURCE,
      },
    });
    const checked = fx.finish(path, { mode: 'check' });
    assert.equal(checked.storageDisposition, 'quarantined');
    assert.equal(checked.quarantinePath, quarantinePath);
  });

  it('reclaims an authorized historical quarantine while retaining its original source coordinates', () => {
    const path = fx.make();
    mkdirSync(join(path, '.cat-cafe'));
    writeFileSync(join(path, '.cat-cafe/data.bin'), 'original bytes');
    const root = quarantineRoot(fx.root);
    const head = git(path, 'rev-parse', 'HEAD').trim();
    const quarantined = moveToQuarantine({
      repo: fx.repo,
      root,
      entry: {
        path,
        name: 'cat-cafe-finish',
        registered: true,
        kind: 'worktree',
        head,
        lifecycle: lifecycleConfig(path, '--worktree'),
        finishSourceRef: SOURCE,
      },
    });
    removeFinishedWorktree({
      repo: fx.repo,
      actor: 'codex61-sol',
      authorizationRef: SOURCE,
      root,
      validate: () => {},
      entry: {
        path: quarantined,
        originalPath: path,
        head,
        lifecycle: lifecycleConfig(quarantined, '--worktree'),
        finishSourceRef: SOURCE,
      },
    });
    const checked = directReleaseReceipt({ repo: fx.repo, root, path, owner: 'codex61-sol', sourceRef: SOURCE });
    assert.equal(checked.storageDisposition, 'removed');
    assert.equal(existsSync(quarantined), false);
    execFileSync('/bin/sh', ['-c', checked.restore]);
    assert.equal(readFileSync(join(path, '.cat-cafe/data.bin'), 'utf8'), 'original bytes');
  });

  it('keeps private directory permissions in the archive and after restoration', () => {
    const path = fx.make();
    mkdirSync(join(path, '.cat-cafe/private'), { recursive: true });
    chmodSync(join(path, '.cat-cafe/private'), 0o700);
    writeFileSync(join(path, '.cat-cafe/private/original.bin'), 'private original');
    const result = fx.finish(path);
    assert.equal(statSync(join(result.archivePath, 'files/.cat-cafe/private')).mode & 0o777, 0o700);
    execFileSync('/bin/sh', ['-c', result.restore]);
    assert.equal(statSync(join(path, '.cat-cafe/private')).mode & 0o777, 0o700);
  });

  it('preserves original file attributes on macOS', { skip: process.platform !== 'darwin' }, () => {
    const path = fx.make();
    mkdirSync(join(path, '.cat-cafe'));
    const original = join(path, '.cat-cafe/tagged.bin');
    writeFileSync(original, 'original bytes');
    execFileSync('/usr/bin/xattr', ['-w', 'com.catcafe.fixture', 'original tag', original]);
    const result = fx.finish(path);
    const archived = join(result.archivePath, 'files/.cat-cafe/tagged.bin');
    assert.equal(
      execFileSync('/usr/bin/xattr', ['-p', 'com.catcafe.fixture', archived], { encoding: 'utf8' }).trim(),
      'original tag',
    );
    execFileSync('/bin/sh', ['-c', result.restore]);
    assert.equal(
      execFileSync('/usr/bin/xattr', ['-p', 'com.catcafe.fixture', original], { encoding: 'utf8' }).trim(),
      'original tag',
    );
  });
});
