import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, git, idle, NOW, SOURCE } from './lib/worktree-finish-fixture.mjs';
import { quarantineRoot } from './lib/worktree-quarantine.mjs';
import { classifyEntry, classifyQuarantined } from './lib/worktree-reaper-core.mjs';
import { lifecycleConfig } from './lib/worktree-reaper-probes.mjs';
import { parseFinishArgs } from './worktree-finish.mjs';
import { capacityHolders, checkCapacity } from './worktree-reaper.mjs';

describe('explicit worktree disposition with real Git', () => {
  let fx;
  beforeEach(() => {
    fx = fixture();
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  it('removes a recently merged tree immediately, preserving archived originals and its branch', () => {
    const path = fx.make();
    const ignored = join(path, '.cat-cafe/private-proof.txt');
    mkdirSync(join(path, '.cat-cafe'));
    writeFileSync(ignored, 'keep exactly\n');
    const head = git(path, 'rev-parse', 'HEAD').trim();
    const result = fx.finish(path);
    assert.equal(result.state, 'released');
    assert.equal(existsSync(path), false);
    assert.equal(readFileSync(join(result.archivePath, 'files/.cat-cafe/private-proof.txt'), 'utf8'), 'keep exactly\n');
    assert.equal(git(fx.repo, 'rev-parse', 'test/cat-cafe-finish').trim(), head);
    assert.equal(checkCapacity({ repo: fx.repo }).count, 0);
    assert.equal(fx.finish(path, { mode: 'check' }).state, 'released');
  });

  it('discards reproducible browser test outputs without treating them as authored dirty files', () => {
    const path = fx.make();
    const dir = join(path, 'packages/web/.next-test-f322-settings-return');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cache.json'), '{"privateFixture":true}\n');
    writeFileSync(join(path, 'packages/web/tsconfig.next-test-f322-settings-return.json'), '{}\n');
    const result = fx.finish(path);
    assert.equal(result.state, 'released');
    assert.equal(
      existsSync(join(result.archivePath, 'files/packages/web/.next-test-f322-settings-return/cache.json')),
      false,
    );
    assert.equal(
      existsSync(join(result.archivePath, 'files/packages/web/tsconfig.next-test-f322-settings-return.json')),
      false,
    );
  });

  it('does not let unrelated dirt in main block the target disposition', () => {
    const path = fx.make();
    writeFileSync(join(fx.repo, 'README.md'), 'another owner WIP\n');
    assert.equal(fx.finish(path).state, 'released');
    assert.equal(readFileSync(join(fx.repo, 'README.md'), 'utf8'), 'another owner WIP\n');
  });

  for (const untracked of [false, true]) {
    it(`refuses ${untracked ? 'untracked authored' : 'tracked'} work without moving or deleting it`, () => {
      const path = fx.make();
      const file = join(path, untracked ? 'authored-test.mjs' : 'README.md');
      writeFileSync(file, 'my work\n');
      assert.throws(() => fx.finish(path), /dirty/);
      assert.equal(readFileSync(file, 'utf8'), 'my work\n');
    });
  }

  it('refuses new commits not contained in main, including after a squash', () => {
    const path = fx.make();
    writeFileSync(join(path, 'a.txt'), 'merged\n');
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'merged part');
    git(fx.repo, 'merge', '--squash', 'test/cat-cafe-finish');
    git(fx.repo, 'commit', '-qm', 'squash');
    git(fx.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(path, 'b.txt'), 'new work\n');
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'later');
    assert.throws(() => fx.finish(path), /not-merged/);
    assert.equal(existsSync(path), true);
  });

  it('recognizes squash-contained content without demanding identical ancestry', () => {
    const path = fx.make();
    writeFileSync(join(path, 'a.txt'), 'merged\n');
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'author');
    git(fx.repo, 'merge', '--squash', 'test/cat-cafe-finish');
    git(fx.repo, 'commit', '-qm', 'squash');
    git(fx.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(fx.finish(path).state, 'released');
  });

  for (const [name, change] of [
    ['owner', () => ({ owner: 'another-cat' })],
    ['busy', (path) => ({ cwdProbe: () => ({ cwds: [path], argv: [] }) })],
    ['unknown process state', () => ({ cwdProbe: () => null })],
    [
      'locked',
      (path, fx) => {
        git(fx.repo, 'worktree', 'lock', path);
        return {};
      },
    ],
  ]) {
    it(`refuses ${name}`, () => {
      const path = fx.make();
      assert.throws(() => fx.finish(path, change(path, fx)), /owner|busy|process|locked/);
      assert.equal(existsSync(path), true);
    });
  }

  it('refuses protected and undeclared trees and explicit never policy', () => {
    assert.throws(() => fx.finish(fx.repo), /protected|main/);
    const runtime = fx.make('cat-cafe-runtime');
    assert.throws(() => fx.finish(runtime), /protected/);
    const never = fx.make('cat-cafe-never', 'never');
    assert.throws(() => fx.finish(never), /never/);
    const legacy = join(fx.root, 'cat-cafe-legacy');
    git(fx.repo, 'worktree', 'add', '--detach', legacy, 'HEAD');
    assert.throws(() => fx.finish(legacy), /declaration/);
  });

  it('retains a dirty or occupied tree with one atomic owner/source/reason/deadline fact', () => {
    const path = fx.make();
    writeFileSync(join(path, 'README.md'), 'pending acceptance\n');
    const until = new Date(NOW + 3_600_000).toISOString();
    assert.equal(
      fx.finish(path, { mode: 'retain', reason: 'await existing Alpha acceptance', until }).state,
      'retained',
    );
    const decl = lifecycleConfig(path, '--worktree');
    assert.equal(decl.retention.sourceRef, SOURCE);
    assert.equal(decl.retention.reason, 'await existing Alpha acceptance');
    assert.equal(decl.retention.until, until);
    assert.equal(decl.policy, 'merged');
    assert.equal(capacityHolders({ repo: fx.repo }).active[0].retentionStatus, 'retained-until');
    assert.equal(fx.finish(path, { mode: 'check' }).state, 'retained');
    assert.throws(() => fx.finish(path, { mode: 'check', now: NOW + 3_600_001 }), /expired/);
    assert.throws(() => fx.finish(path, { mode: 'check', sourceRef: 'task:work:other' }), /source/);
  });

  it('rejects an invalid retention before mutating the declaration', () => {
    const path = fx.make();
    for (const override of [
      { reason: '', until: new Date(NOW + 1000).toISOString() },
      { reason: 'needed', until: new Date(NOW - 1).toISOString() },
      { reason: 'needed', until: 'next week' },
      { reason: 'needed', until: new Date(NOW + 86_400_000).toISOString().slice(0, -1) },
      { reason: 'needed', until: new Date(NOW + 31 * 86_400_000).toISOString() },
    ]) {
      assert.throws(() => fx.finish(path, { mode: 'retain', ...override }), /reason|until/);
      assert.equal(lifecycleConfig(path, '--worktree').retention, undefined);
    }
  });

  it('explicitly finishes a nested review sandbox before its birth TTL expires', () => {
    const path = fx.make('cat-cafe-review/pr-5216/sonnet', 'ttl');
    assert.equal(fx.finish(path).state, 'released');
    assert.equal(fx.finish(path, { mode: 'check' }).state, 'released');
    assert.equal(checkCapacity({ repo: fx.repo }).count, 0);
  });

  it('bounds retention at thirty days and rejects an over-horizon persisted fact when checking', () => {
    const path = fx.make();
    fx.finish(path, {
      mode: 'retain',
      reason: 'pending acceptance',
      until: new Date(NOW + 30 * 86_400_000).toISOString(),
    });
    assert.equal(fx.finish(path, { mode: 'check' }).state, 'retained');
    const { retention } = lifecycleConfig(path, '--worktree');
    retention.until = '2999-01-01T00:00:00Z';
    git(path, 'config', '--worktree', 'catcafe.lifecycle.retention', JSON.stringify(retention));
    assert.throws(() => fx.finish(path, { mode: 'check' }), /invalid/);
    assert.equal(capacityHolders({ repo: fx.repo }).active[0].retentionStatus, 'retention-invalid');
  });

  it('does not accept stale retention after HEAD changes or an unrelated release receipt', () => {
    const path = fx.make();
    fx.finish(path, { mode: 'retain', reason: 'wait', until: new Date(NOW + 1000).toISOString() });
    writeFileSync(join(path, 'a.txt'), 'next task\n');
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'new work');
    assert.throws(() => fx.finish(path, { mode: 'check' }), /head/);
    assert.throws(() => fx.finish(join(fx.root, 'cat-cafe-never-created'), { mode: 'check' }), /receipt|registered/);
  });

  it('refuses release if the target changes after its initial probe', () => {
    const path = fx.make();
    let probes = 0;
    assert.throws(
      () =>
        fx.finish(path, {
          cwdProbe: () => {
            if (++probes === 2) writeFileSync(join(path, 'README.md'), 'late WIP\n');
            return idle();
          },
        }),
      /dirty|changed/,
    );
    assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'late WIP\n');
  });

  it('does not move a tree when its write-ahead receipt cannot be recorded', () => {
    const path = fx.make();
    const ledger = quarantineRoot(fx.root);
    mkdirSync(ledger);
    mkdirSync(join(ledger, 'ledger.jsonl'));
    assert.throws(() => fx.finish(path), /EISDIR|directory/);
    assert.equal(existsSync(path), true);
  });

  it('runs the real CLI against an absolute target without confusing itself with a live consumer', () => {
    const path = fx.make();
    const script = fileURLToPath(new URL('./worktree-finish.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [script, path, '--owner', 'codex61-sol', '--source-ref', SOURCE], {
      cwd: fx.repo,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_CAT_ID: 'codex61-sol' },
    });
    assert.equal(JSON.parse(output).state, 'released');
  });

  it('never counts a restored worktree or a foreign source as a released receipt', () => {
    const path = fx.make();
    const result = fx.finish(path);
    assert.throws(() => fx.finish(path, { mode: 'check', sourceRef: 'task:work:other' }), /receipt/);
    execFileSync('/bin/sh', ['-c', result.restore], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.throws(() => fx.finish(path, { mode: 'check' }), /no retained/);
  });

  it('produces a restore command that preserves literal shell metacharacters', () => {
    const path = fx.make('cat-cafe-$(printf)');
    const result = fx.finish(path);
    execFileSync('/bin/sh', ['-c', result.restore], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'original\n');
  });
});

it('validates CLI mode and the runtime owner identity before any worktree action', () => {
  assert.throws(() => parseFinishArgs(['x', '--owner', 'other'], { CAT_CAFE_CAT_ID: 'codex61-sol' }), /identity/);
  assert.throws(() => parseFinishArgs(['x', '--retain', '--check']), /one disposition/);
  assert.throws(() => parseFinishArgs(['x', '--force']), /flag/);
});

describe('reaper respects bounded retained owner intent', () => {
  const entry = (retention) => ({
    name: 'cat-cafe-kept',
    kind: 'worktree',
    busy: false,
    trackedChanges: 0,
    untrackedPreserved: 0,
    inMain: true,
    idleDays: 20,
    lifecycle: {
      owner: 'codex61-sol',
      policy: 'merged',
      createdAt: new Date(NOW - 20 * 86_400_000).toISOString(),
      retention,
    },
  });
  const retain = {
    owner: 'codex61-sol',
    reason: 'live preview',
    sourceRef: SOURCE,
    head: 'abc',
    until: new Date(NOW + 1000).toISOString(),
    recordedAt: new Date(NOW).toISOString(),
  };
  it('keeps a live retention even when the branch is merged and idle', () => {
    assert.deepEqual(classifyEntry(entry(retain), undefined, NOW), { verdict: 'keep', reason: 'retained-until' });
  });
  it('requires disposition when retention expires instead of forgetting the deadline', () => {
    assert.deepEqual(classifyEntry(entry({ ...retain, until: new Date(NOW - 1).toISOString() }), undefined, NOW), {
      verdict: 'review',
      reason: 'retention-expired',
    });
  });
  it('fails closed on corrupt retention and protects quarantine changed owner intent', () => {
    assert.equal(classifyEntry(entry('broken'), undefined, NOW).verdict, 'review');
    assert.equal(
      classifyQuarantined(
        { ...entry(retain), quarantinedAt: NOW - 30 * 86_400_000, lastActivityMs: NOW - 40 * 86_400_000 },
        undefined,
        NOW,
      ).verdict,
      'review',
    );
  });
});
