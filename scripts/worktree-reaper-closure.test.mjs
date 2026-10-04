/**
 * Real-git-fixture regressions for reviewer counterexamples against the reaper: work added in quarantine,
 * squash merges, capacity accounting, half-created worktrees, and owner intent changed after quarantine.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { quarantineRoot } from './lib/worktree-quarantine.mjs';
import { isContainedIn } from './lib/worktree-reaper-probes.mjs';
import { createWorktree, declareLifecycle } from './worktree-new.mjs';
import { applyReap, checkCapacity, collectEntries, planReap, purgeReap } from './worktree-reaper.mjs';

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const DAY = 86_400_000;
const T0 = Date.now();
const idleProbe = () => ({ cwds: [], argv: [] });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reaper-closure-')));
  const parent = join(root, 'relay');
  const bare = join(root, 'origin.git');
  mkdirSync(parent);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const repo = join(parent, 'cat-cafe');
  execFileSync('git', ['clone', '-q', bare, repo], { stdio: 'ignore' });
  git(repo, 'config', 'extensions.worktreeConfig', 'true');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  git(repo, 'fetch', '-q', 'origin');
  const opts = (o = {}) => ({
    repo,
    parentDir: parent,
    sandboxRoots: [],
    now: T0 + 20 * DAY,
    cwdProbe: idleProbe,
    ...o,
  });
  const make = (name, decl = { policy: 'merged' }, extra = {}) => {
    const path = join(parent, name);
    createWorktree({ repo, path, branch: `feat/${name}`, owner: 'opus5', now: T0, ...decl, ...extra });
    return path;
  };
  const plan = (o) => planReap(collectEntries(opts(o)), undefined, opts(o).now);
  const verdictOf = (name, o) => {
    const e = plan(o).find((x) => x.name === name);
    return e && `${e.verdict}:${e.reason}`;
  };
  return { root, parent, repo, opts, make, plan, verdictOf };
}

const commitFile = (dir, file, text) => {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', `add ${file}`);
};

/** Squash the branch's content into origin/main the way a GitHub squash merge does (new commit, same tree). */
function squashIntoMain(fx, branch) {
  git(fx.repo, 'merge', '-q', '--squash', branch);
  git(fx.repo, 'commit', '-qm', `squash ${branch}`);
  git(fx.repo, 'push', '-q', 'origin', 'HEAD:main');
  git(fx.repo, 'fetch', '-q', 'origin');
}

describe('counterexample 1: quarantine never authorises deleting work added afterwards', () => {
  let fx;
  beforeEach(() => {
    fx = fixture();
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  const quarantineOne = (name) => {
    fx.make(name);
    const at = T0 + 20 * DAY;
    const results = applyReap(fx.plan(), fx.opts({ clock: () => at }));
    assert.deepEqual(
      results.map((r) => `${r.name}:${r.outcome}`),
      [`${name}:quarantined`],
    );
    return { at, dir: fx.plan().find((e) => e.name === name).path };
  };
  const purgeAfterWindow = (at) => {
    const late = fx.opts({ now: at + 15 * DAY });
    return purgeReap(planReap(collectEntries(late), undefined, late.now), late);
  };

  it('keeps an untracked file written inside quarantine', () => {
    const { at, dir } = quarantineOne('cat-cafe-q-untracked');
    writeFileSync(join(dir, 'new-work-after-quarantine.txt'), 'mine\n');
    assert.equal(fx.verdictOf('cat-cafe-q-untracked', { now: at + 15 * DAY }), 'review:changed-in-quarantine');
    assert.deepEqual(purgeAfterWindow(at), []);
    assert.equal(readFileSync(join(dir, 'new-work-after-quarantine.txt'), 'utf8'), 'mine\n');
  });

  it('keeps a commit made inside quarantine', () => {
    const { at, dir } = quarantineOne('cat-cafe-q-commit');
    writeFileSync(join(dir, 'late.txt'), 'late\n');
    git(dir, 'add', 'late.txt');
    // Committed (and reflogged) one day after the move; the working tree is clean again afterwards.
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'late'], {
      env: { ...process.env, GIT_COMMITTER_DATE: new Date(at + DAY).toISOString() },
    });
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.equal(fx.verdictOf('cat-cafe-q-commit', { now: at + 15 * DAY }), 'review:changed-in-quarantine');
    assert.deepEqual(purgeAfterWindow(at), []);
    assert.equal(existsSync(join(dir, 'late.txt')), true);
  });

  it('still purges an untouched quarantine entry after the window (control)', () => {
    const { at, dir } = quarantineOne('cat-cafe-q-clean');
    assert.deepEqual(
      purgeAfterWindow(at).map((r) => `${r.name}:${r.outcome}`),
      ['cat-cafe-q-clean:purged'],
    );
    assert.equal(existsSync(dir), false);
  });
});

describe('counterexample 2: squash-merged branches count as merged, new work after the merge does not', () => {
  let fx;
  beforeEach(() => {
    fx = fixture();
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  it('recognises two commits squashed into main as merged', () => {
    const wt = fx.make('cat-cafe-squashed');
    commitFile(wt, 'a.txt', 'a\n');
    commitFile(wt, 'b.txt', 'b\n');
    squashIntoMain(fx, 'feat/cat-cafe-squashed');
    assert.equal(fx.verdictOf('cat-cafe-squashed'), 'quarantine:merged-idle');
  });

  it('keeps a squash-merged worktree that gained a commit after the merge', () => {
    const wt = fx.make('cat-cafe-squashed-then-more');
    commitFile(wt, 'a.txt', 'a\n');
    squashIntoMain(fx, 'feat/cat-cafe-squashed-then-more');
    commitFile(wt, 'after-merge.txt', 'new\n');
    assert.equal(fx.verdictOf('cat-cafe-squashed-then-more'), 'keep:not-merged-yet');
  });

  it('keeps a branch only partly contained in main', () => {
    const wt = fx.make('cat-cafe-partly');
    commitFile(wt, 'a.txt', 'a\n');
    squashIntoMain(fx, 'feat/cat-cafe-partly');
    commitFile(wt, 'b.txt', 'b\n'); // never merged
    git(fx.repo, 'reset', '-q', '--hard', 'origin/main');
    assert.equal(fx.verdictOf('cat-cafe-partly'), 'keep:not-merged-yet');
  });
});

describe('counterexample 3: capacity counts active declared worktrees and has a working exit', () => {
  let fx;
  beforeEach(() => {
    fx = fixture();
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  it('stops counting a worktree once it is quarantined', () => {
    fx.make('cat-cafe-one');
    const active = fx.make('cat-cafe-two');
    commitFile(active, 'wip.txt', 'wip\n'); // not merged: stays active
    assert.deepEqual(checkCapacity({ repo: fx.repo, max: 2 }), { count: 2, max: 2, over: true, legacy: 0 });
    applyReap(fx.plan(), fx.opts());
    assert.deepEqual(checkCapacity({ repo: fx.repo, max: 2 }), { count: 1, max: 2, over: false, legacy: 0 });
  });

  it('does not charge undeclared legacy worktrees to a new task', () => {
    git(fx.repo, 'worktree', 'add', '-q', join(fx.parent, 'cat-cafe-legacy'), '-b', 'feat/legacy', 'origin/main');
    fx.make('cat-cafe-mine');
    assert.deepEqual(checkCapacity({ repo: fx.repo, max: 2 }), { count: 1, max: 2, over: false, legacy: 1 });
  });

  it('creation never moves anything, not even entries their owners released (review round 2 P1-2)', () => {
    fx.make('cat-cafe-alice', { policy: 'never' });
    const bob = fx.make('cat-cafe-bob', { policy: 'ttl', ttlDays: 1 }); // expired by `now`: releasable
    const carol = join(fx.parent, 'cat-cafe-carol-clone'); // expired clone: holds no slot at all
    execFileSync('git', ['clone', '-q', fx.repo, carol], { stdio: 'ignore' });
    declareLifecycle(carol, { owner: 'carol', policy: 'ttl', ttlDays: 1, now: T0 });
    const attempt = (o) => () =>
      createWorktree({
        repo: fx.repo,
        path: join(fx.parent, 'cat-cafe-new'),
        branch: 'feat/new',
        owner: 'alice',
        policy: 'merged',
        now: T0 + 20 * DAY,
        ...o,
      });
    assert.throws(attempt({ max: 2 }), (err) => err.exitCode === 2 && /cat-cafe-bob/.test(err.message));
    assert.throws(attempt({ max: 5, base: 'does-not-exist' }), /base/);
    for (const kept of [bob, carol]) assert.equal(existsSync(join(kept, 'README.md')), true, kept);
    assert.equal(existsSync(quarantineRoot(fx.parent)), false, 'no quarantine happened');
    assert.equal(existsSync(join(fx.parent, 'cat-cafe-new')), false);
  });

  it('at the cap, the refusal names what holds the slots, by owner', () => {
    const active = fx.make('cat-cafe-busy-a');
    commitFile(active, 'wip.txt', 'wip\n');
    const other = fx.make('cat-cafe-busy-b', { policy: 'never' });
    assert.throws(
      () =>
        createWorktree({
          repo: fx.repo,
          path: join(fx.parent, 'cat-cafe-refused'),
          branch: 'feat/refused',
          owner: 'opus5',
          policy: 'merged',
          max: 2,
          now: T0 + 20 * DAY,
        }),
      (err) =>
        err.exitCode === 2 &&
        /2\/2/.test(err.message) &&
        /opus5: 2/.test(err.message) &&
        /cat-cafe-busy-a/.test(err.message),
    );
    assert.equal(existsSync(join(fx.parent, 'cat-cafe-refused')), false);
    assert.equal(existsSync(other), true);
  });
});

describe('counterexample 4: a rejected creation leaves nothing behind', () => {
  let fx;
  beforeEach(() => {
    fx = fixture();
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  const worktreeCount = () => git(fx.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length;
  const branchExists = (b) => git(fx.repo, 'branch', '--list', b).trim() !== '';

  for (const [label, decl] of [
    ['an invalid policy', { owner: 'opus5', policy: 'bogus' }],
    ['a missing owner', { owner: '', policy: 'merged' }],
    ['ttl without --ttl-days', { owner: 'opus5', policy: 'ttl' }],
  ]) {
    it(`validates ${label} before touching git`, () => {
      const path = join(fx.parent, 'cat-cafe-rejected');
      assert.throws(() => createWorktree({ repo: fx.repo, path, branch: 'feat/rejected', ...decl }), /invalid/);
      assert.equal(existsSync(path), false);
      assert.equal(worktreeCount(), 1);
      assert.equal(branchExists('feat/rejected'), false);
    });
  }

  it('rolls back the worktree and its new branch when the declaration write itself fails', () => {
    const path = join(fx.parent, 'cat-cafe-declare-fails');
    assert.throws(
      () =>
        createWorktree({
          repo: fx.repo,
          path,
          branch: 'feat/declare-fails',
          owner: 'opus5',
          policy: 'merged',
          declare: () => {
            throw new Error('simulated config write failure');
          },
        }),
      /simulated config write failure/,
    );
    assert.equal(existsSync(path), false);
    assert.equal(worktreeCount(), 1);
    assert.equal(branchExists('feat/declare-fails'), false);
  });
});

describe('review round 2: owner intent survives quarantine; probes never write to the inspected repo', () => {
  let fx;
  beforeEach(() => {
    fx = fixture();
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  const quarantineTtl = (name) => {
    fx.make(name, { policy: 'ttl', ttlDays: 1 });
    const at = T0 + 20 * DAY;
    applyReap(fx.plan(), fx.opts({ clock: () => at }));
    return { at, path: fx.plan().find((e) => e.quarantined).path };
  };

  it('an explicit policy=never declared after quarantine blocks purge (P1-1)', () => {
    const { at, path } = quarantineTtl('cat-cafe-retain');
    declareLifecycle(path, { owner: 'opus5', policy: 'never', now: at + DAY });
    const late = fx.opts({ now: at + 15 * DAY });
    assert.equal(fx.verdictOf('cat-cafe-retain', { now: late.now }), 'keep:policy-never');
    assert.deepEqual(purgeReap(planReap(collectEntries(late), undefined, late.now), late), []);
    assert.equal(existsSync(join(path, 'README.md')), true);
  });

  // Review round 3: the current declaration must be complete and valid, not just carry an old createdAt.
  for (const [label, edit] of [
    ['policy removed', ['--unset', 'catcafe.lifecycle.policy']],
    ['policy invalid', ['catcafe.lifecycle.policy', 'bogus']],
    ['owner removed', ['--unset', 'catcafe.lifecycle.owner']],
    ['ttl expiresAt removed', ['--unset', 'catcafe.lifecycle.expiresAt']],
  ]) {
    it(`an incomplete current declaration (${label}) blocks purge`, () => {
      const name = `cat-cafe-broken-${label.replace(/\W+/g, '-')}`;
      const { at, path } = quarantineTtl(name);
      git(path, 'config', '--worktree', ...edit);
      const late = fx.opts({ now: at + 15 * DAY });
      assert.equal(fx.verdictOf(name, { now: late.now }), 'review:declaration-incomplete');
      assert.deepEqual(purgeReap(planReap(collectEntries(late), undefined, late.now), late), []);
      assert.equal(existsSync(join(path, 'README.md')), true);
    });
  }

  it('an untouched valid ttl declaration is still purged after the window (control)', () => {
    const { at, path } = quarantineTtl('cat-cafe-ttl-control');
    const late = fx.opts({ now: at + 15 * DAY });
    assert.deepEqual(
      purgeReap(planReap(collectEntries(late), undefined, late.now), late).map((r) => r.outcome),
      ['purged'],
    );
    assert.equal(existsSync(path), false);
  });

  it('any other re-declaration after quarantine (e.g. a longer ttl) goes to review, not purge', () => {
    const { at, path } = quarantineTtl('cat-cafe-extend');
    declareLifecycle(path, { owner: 'opus5', policy: 'ttl', ttlDays: 90, now: at + DAY });
    assert.equal(fx.verdictOf('cat-cafe-extend', { now: at + 15 * DAY }), 'review:redeclared-in-quarantine');
  });

  it('the containment probe leaves the inspected object store unchanged (P2)', () => {
    const wt = fx.make('cat-cafe-unmerged');
    commitFile(wt, 'branch.txt', 'branch\n');
    commitFile(fx.repo, 'main.txt', 'main\n');
    git(fx.repo, 'push', '-q', 'origin', 'HEAD:main');
    git(fx.repo, 'fetch', '-q', 'origin');
    const before = git(fx.repo, 'count-objects', '-v');
    assert.equal(isContainedIn(fx.repo, 'feat/cat-cafe-unmerged', 'origin/main'), false);
    assert.equal(git(fx.repo, 'count-objects', '-v'), before);
    squashIntoMain(fx, 'feat/cat-cafe-unmerged');
    const afterSquash = git(fx.repo, 'count-objects', '-v');
    assert.equal(isContainedIn(fx.repo, 'feat/cat-cafe-unmerged', 'origin/main'), true);
    assert.equal(git(fx.repo, 'count-objects', '-v'), afterSquash);
  });
});
