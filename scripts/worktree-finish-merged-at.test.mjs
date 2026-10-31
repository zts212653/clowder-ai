import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, git, SOURCE } from './lib/worktree-finish-fixture.mjs';
import { quarantineRoot } from './lib/worktree-quarantine.mjs';
import { parseFinishArgs } from './worktree-finish.mjs';

describe('owner finish with a historical squash integration point', () => {
  let fx;
  beforeEach(() => {
    fx = fixture();
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  function squash(path, publish = true) {
    writeFileSync(join(path, 'README.md'), 'authored feature\n');
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'author change');
    git(fx.repo, 'merge', '--squash', 'test/cat-cafe-finish');
    git(fx.repo, 'commit', '-qm', 'squash integration');
    const mergedAt = git(fx.repo, 'rev-parse', 'HEAD').trim();
    if (publish) git(fx.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    return mergedAt;
  }

  it('releases an evolved squash only with a verified historical integration, preserving its originals and proof', () => {
    const path = fx.make();
    const mergedAt = squash(path);
    writeFileSync(join(fx.repo, 'README.md'), 'later mainline implementation\n');
    git(fx.repo, 'commit', '-qam', 'evolve mainline');
    git(fx.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    mkdirSync(join(path, '.cat-cafe'));
    writeFileSync(join(path, '.cat-cafe/original.txt'), 'unique original\n');
    assert.throws(() => fx.finish(path), /not-merged/);
    const script = fileURLToPath(new URL('./worktree-finish.mjs', import.meta.url));
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [script, path, '--owner', 'codex61-sol', '--source-ref', SOURCE, '--merged-at', mergedAt],
        {
          cwd: fx.repo,
          encoding: 'utf8',
          env: { ...process.env, CAT_CAFE_CAT_ID: 'codex61-sol' },
        },
      ),
    );
    assert.equal(result.state, 'released');
    assert.equal(existsSync(path), false);
    assert.equal(result.mergedAt, mergedAt);
    assert.equal(fx.finish(path, { mode: 'check' }).mergedAt, mergedAt);
    const manifest = JSON.parse(readFileSync(join(result.archivePath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.mergedAt, mergedAt);
    assert.equal(readFileSync(join(result.archivePath, 'files/.cat-cafe/original.txt'), 'utf8'), 'unique original\n');
    const ledger = join(quarantineRoot(fx.root), 'ledger.jsonl');
    const originalLedger = readFileSync(ledger, 'utf8');
    const records = originalLedger.trim().split('\n').map(JSON.parse);
    const changed = git(fx.repo, 'rev-parse', 'origin/main').trim();
    records.at(-1).mergedAt = changed;
    writeFileSync(ledger, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    assert.throws(() => fx.finish(path, { mode: 'check' }), /receipt/);
    records.at(-2).mergedAt = changed;
    writeFileSync(ledger, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    assert.throws(() => fx.finish(path, { mode: 'check' }), /receipt mismatch/);
    writeFileSync(ledger, originalLedger);
    assert.equal(fx.finish(path, { mode: 'check' }).mergedAt, mergedAt);
  });

  it('refuses an integration commit absent from origin/main history', () => {
    const path = fx.make();
    const mergedAt = squash(path, false);
    assert.throws(() => fx.finish(path, { mergedAt }), /merged-at.*origin\/main/);
    assert.equal(existsSync(path), true);
  });

  it('refuses source commits added after the supplied integration point', () => {
    const path = fx.make();
    const mergedAt = squash(path);
    writeFileSync(join(path, 'unfinished.txt'), 'not integrated\n');
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'new work');
    assert.throws(() => fx.finish(path, { mergedAt }), /not-merged/);
    assert.equal(readFileSync(join(path, 'unfinished.txt'), 'utf8'), 'not integrated\n');
  });

  it('does not let a valid historical proof excuse dirty source files', () => {
    const path = fx.make();
    const mergedAt = squash(path);
    writeFileSync(join(path, 'unfinished.txt'), 'uncommitted original\n');
    assert.throws(() => fx.finish(path, { mergedAt }), /dirty/);
    assert.equal(readFileSync(join(path, 'unfinished.txt'), 'utf8'), 'uncommitted original\n');
  });

  it('accepts an exact commit argument and rejects ambiguous revisions before changing the target', () => {
    const path = fx.make();
    const mergedAt = squash(path);
    assert.equal(parseFinishArgs([path, '--source-ref', SOURCE, '--merged-at', mergedAt]).mergedAt, mergedAt);
    for (const revision of ['HEAD', 'origin/main', `${mergedAt}~1`, '--all', '0'.repeat(40)]) {
      assert.throws(() => fx.finish(path, { mergedAt: revision }), /merged-at/);
      assert.equal(existsSync(path), true);
    }
  });
});
