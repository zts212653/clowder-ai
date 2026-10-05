import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { moveToQuarantine, purgeQuarantined, quarantineRoot, quarantineStamp } from './lib/worktree-quarantine.mjs';
import { createWorktree, declareLifecycle } from './worktree-new.mjs';
import { applyReap, checkCapacity, collectEntries, parsePolicyArgs, planReap, purgeReap } from './worktree-reaper.mjs';

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const DAY = 86_400_000;
const T0 = Date.now();

function buildFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reaper-')));
  const parent = join(root, 'relay');
  const bare = join(root, 'origin.git');
  mkdirSync(parent);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const repo = join(parent, 'cat-cafe');
  execFileSync('git', ['clone', '-q', bare, repo], { stdio: 'ignore' });
  git(repo, 'config', 'extensions.worktreeConfig', 'true');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  writeFileSync(join(repo, '.gitignore'), 'dist/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
  git(repo, 'fetch', '-q', 'origin');
  // A declaration in the SHARED config must never make every worktree look declared.
  git(repo, 'config', 'catcafe.lifecycle.policy', 'merged');

  const wt = (name, decl) => {
    const path = join(parent, name);
    if (decl) createWorktree({ repo, path, branch: `feat/${name}`, owner: 'opus5', now: T0, ...decl });
    else git(repo, 'worktree', 'add', '-q', path, '-b', `feat/${name}`, 'origin/main');
    return path;
  };

  wt('cat-cafe-undeclared'); // merged, clean, idle — but nobody declared it
  // Declared + eligible, carrying state no probe proves: hidden index edit and an ignored user file.
  const declared = wt('cat-cafe-declared', { policy: 'merged' });
  writeFileSync(join(declared, 'README.md'), 'hidden edit\n');
  git(declared, 'update-index', '--assume-unchanged', 'README.md');
  mkdirSync(join(declared, 'dist'));
  writeFileSync(join(declared, 'dist/keep.txt'), 'mine\n');

  writeFileSync(join(wt('cat-cafe-dirty', { policy: 'merged' }), 'README.md'), 'changed\n');
  const unmerged = wt('cat-cafe-unmerged', { policy: 'merged' });
  writeFileSync(join(unmerged, 'new.txt'), 'x\n');
  git(unmerged, 'add', '.');
  git(unmerged, 'commit', '-qm', 'wip');
  wt('cat-cafe-never', { policy: 'never' });
  wt('cat-cafe-ttl-expired', { policy: 'ttl', ttlDays: 1 });
  wt('cat-cafe-ttl-active', { policy: 'ttl', ttlDays: 30 });
  git(repo, 'worktree', 'lock', wt('cat-cafe-locked', { policy: 'merged' }));
  wt('cat-cafe-runtime', { policy: 'merged' });

  const clone = (name, decl) => {
    const path = join(parent, name);
    execFileSync('git', ['clone', '-q', bare, path], { stdio: 'ignore' });
    if (decl) declareLifecycle(path, { owner: 'codex', now: T0, ...decl });
    return path;
  };
  git(clone('cat-cafe-eval-a2a-current', { policy: 'merged' }), 'update-ref', 'refs/keep/user', 'HEAD');
  clone('cat-cafe-eval-a2a-20260101-current-abcdef');
  clone('cat-cafe-tutorials', { policy: 'merged' });

  // Review round 4 P1-2: a hand-written policy key alone is not a birth declaration.
  git(wt('cat-cafe-partial'), 'config', '--worktree', 'catcafe.lifecycle.policy', 'merged');

  mkdirSync(join(parent, 'cat-cafe-hollow/packages/api/data/logs'), { recursive: true });
  mkdirSync(join(parent, 'cat-cafe-leftover'));
  writeFileSync(join(parent, 'cat-cafe-leftover/data.log'), 'x\n');
  mkdirSync(join(parent, 'GPT-SoVITS'));
  return { root, parent, repo };
}

describe('worktree-reaper end to end', () => {
  let fx;
  const opts = (o = {}) => ({
    repo: fx.repo,
    parentDir: fx.parent,
    sandboxRoots: [],
    now: T0 + 10 * DAY,
    cwdProbe: () => ({ cwds: [], argv: [] }),
    ...o,
  });
  const plan = (o) => planReap(collectEntries(opts(o)), undefined, opts(o).now);
  const verdicts = (p) => Object.fromEntries(p.map((e) => [e.name, `${e.verdict}:${e.reason}`]));
  // A wall clock that advances an hour per reading: a slow batch, so "batch start" ≠ "this move finished".
  const BATCH_START = T0 + 10 * DAY;
  let ticks = 0;
  const slowClock = () => BATCH_START + ticks++ * 3_600_000;
  const ledgerRecords = () =>
    readFileSync(join(quarantineRoot(fx.parent), 'ledger.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  const doneRecord = (name) => ledgerRecords().find((r) => r.state === 'done' && r.to.endsWith(`/${name}`));

  before(() => {
    fx = buildFixture();
  });
  after(() => rmSync(fx.root, { recursive: true, force: true }));

  it('acts only on declared directories and reports the rest', () => {
    assert.deepEqual(verdicts(plan()), {
      'cat-cafe': 'keep:main-repo',
      'cat-cafe-undeclared': 'review:undeclared',
      'cat-cafe-declared': 'quarantine:merged-idle',
      'cat-cafe-dirty': 'review:dirty',
      'cat-cafe-unmerged': 'keep:not-merged-yet',
      'cat-cafe-never': 'keep:policy-never',
      'cat-cafe-ttl-expired': 'quarantine:ttl-expired',
      'cat-cafe-ttl-active': 'keep:ttl-active',
      'cat-cafe-locked': 'keep:locked',
      'cat-cafe-runtime': 'keep:whitelisted',
      'cat-cafe-eval-a2a-current': 'quarantine:merged-idle',
      'cat-cafe-eval-a2a-20260101-current-abcdef': 'review:undeclared',
      'cat-cafe-tutorials': 'keep:whitelisted',
      'cat-cafe-partial': 'review:declaration-incomplete',
      'cat-cafe-hollow': 'review:orphan-hollow',
      'cat-cafe-leftover': 'review:orphan-nonempty',
    });
  });

  it('keeps a declared worktree a live process sits in or runs code from', () => {
    const d = join(fx.parent, 'cat-cafe-declared');
    assert.equal(
      verdicts(plan({ cwdProbe: () => ({ cwds: [`${d}/x`], argv: [] }) }))['cat-cafe-declared'],
      'keep:in-use',
    );
    const argv = { cwds: ['/'], argv: [`node ${d}/dist/index.js`] };
    assert.equal(verdicts(plan({ cwdProbe: () => argv }))['cat-cafe-declared'], 'keep:in-use');
    assert.equal(
      verdicts(plan({ cwdProbe: () => ({ cwds: [], argv: [`ls ${d}-2`] }) }))['cat-cafe-declared'],
      'quarantine:merged-idle',
    );
    assert.equal(
      plan({ cwdProbe: () => null }).filter((e) => e.verdict !== 'keep' && e.verdict !== 'review').length,
      0,
    );
  });

  it('does not let a status probe (index rewrite) count as activity, nor rewrite the index', () => {
    const d = join(fx.parent, 'cat-cafe-undeclared');
    const indexPath = git(d, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim();
    const past = new Date(T0 - 20 * DAY);
    utimesSync(indexPath, past, past);
    writeFileSync(join(d, 'README.md'), 'hi\n'); // same content, new mtime → stat info stale
    const e = collectEntries(opts()).find((x) => x.name === 'cat-cafe-undeclared');
    assert.equal(Math.round(statSync(indexPath).mtimeMs), Math.round(past.getTime()));
    assert.ok(e.idleDays >= 0);
  });

  it('gates creation at exactly the cap and validates CLI flags', () => {
    const { count } = checkCapacity({ repo: fx.repo, max: 40 });
    assert.equal(checkCapacity({ repo: fx.repo, max: count }).over, true);
    assert.throws(
      () =>
        createWorktree({
          repo: fx.repo,
          path: join(fx.parent, 'cat-cafe-over'),
          owner: 'x',
          policy: 'merged',
          max: count,
        }),
      /capacity/,
    );
    assert.equal(existsSync(join(fx.parent, 'cat-cafe-over')), false);
    for (const bad of [['--min-idle-days', '0'], ['--quarantine-days', '1'], ['--max', '0'], ['--max']]) {
      assert.throws(() => parsePolicyArgs(bad), /invalid/, bad.join(' '));
    }
    assert.throws(() => declareLifecycle(join(fx.parent, 'cat-cafe-never'), { owner: 'x', policy: 'ttl' }), /ttl-days/);
  });

  it('quarantines instead of deleting: still listed, fully restorable, nothing undeclared touched', () => {
    const results = applyReap(plan(), opts({ clock: slowClock }));
    assert.deepEqual(results.map((r) => `${r.name}:${r.outcome}`).sort(), [
      'cat-cafe-declared:quarantined',
      'cat-cafe-eval-a2a-current:quarantined',
      'cat-cafe-ttl-expired:quarantined',
    ]);
    const rec = doneRecord('cat-cafe-declared');
    const qd = rec.to;
    assert.equal(existsSync(join(fx.parent, 'cat-cafe-declared')), false);
    assert.match(git(fx.repo, 'worktree', 'list'), new RegExp(qd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // Round 6: every destination is unique per transaction, so no historical record can ever match a reused path.
    const tos = ledgerRecords()
      .filter((r) => r.state === 'pending')
      .map((r) => r.to);
    assert.equal(new Set(tos).size, tos.length);
    for (const r of ledgerRecords().filter((x) => x.state === 'done'))
      assert.ok(r.to.includes(r.txn.slice(0, 8)), r.to);
    // State no probe could prove is intact in quarantine…
    assert.equal(readFileSync(join(qd, 'README.md'), 'utf8'), 'hidden edit\n');
    assert.equal(readFileSync(join(qd, 'dist/keep.txt'), 'utf8'), 'mine\n');
    const evalQ = doneRecord('cat-cafe-eval-a2a-current').to;
    assert.ok(git(evalQ, 'rev-parse', '--verify', 'refs/keep/user').trim());
    // …and the ledger's restore command brings the worktree back.
    assert.ok(rec.restore.includes('worktree move'));
    git(fx.repo, 'worktree', 'move', qd, join(fx.parent, 'cat-cafe-declared'));
    assert.equal(readFileSync(join(fx.parent, 'cat-cafe-declared/README.md'), 'utf8'), 'hidden edit\n');
    for (const kept of [
      'cat-cafe-undeclared',
      'cat-cafe-dirty',
      'cat-cafe-eval-a2a-20260101-current-abcdef',
      'cat-cafe-leftover',
      'cat-cafe-hollow', // undeclared: reported, never removed — even though it holds no files
      'cat-cafe-partial',
      'GPT-SoVITS',
    ]) {
      assert.equal(existsSync(join(fx.parent, kept)), true, kept);
    }
    assert.equal(readFileSync(join(fx.parent, 'cat-cafe-dirty/README.md'), 'utf8'), 'changed\n');
  });

  it('writes the ledger before moving: a failed ledger write moves nothing (review round 5)', () => {
    const badRoot = join(fx.root, 'bad-quarantine');
    mkdirSync(join(badRoot, 'ledger.jsonl'), { recursive: true }); // a directory: every append fails
    const path = join(fx.parent, 'cat-cafe-undeclared');
    assert.throws(() =>
      moveToQuarantine({
        repo: fx.repo,
        root: badRoot,
        entry: { path, name: 'cat-cafe-undeclared', registered: true, kind: 'worktree', reason: 'test' },
        clock: () => T0,
      }),
    );
    assert.equal(existsSync(join(path, 'README.md')), true);
    assert.match(git(fx.repo, 'worktree', 'list'), /cat-cafe-undeclared/);
  });

  it('refuses to purge anything outside a quarantine day directory', () => {
    const root = quarantineRoot(fx.parent);
    for (const path of [join(fx.parent, 'cat-cafe-undeclared'), root, join(root, 'ledger.jsonl'), fx.parent]) {
      assert.throws(
        () => purgeQuarantined({ repo: fx.repo, root, entry: { path, registered: false, kind: 'clone' } }),
        /outside quarantine/,
        path,
      );
      assert.equal(existsSync(path) || path.endsWith('ledger.jsonl') || path === root, true);
    }
    assert.equal(existsSync(join(fx.parent, 'cat-cafe-undeclared/README.md')), true);
  });

  it('purges only 14 days after each move actually finished (to the ms), and only inside quarantine', () => {
    const qroot = quarantineRoot(fx.parent);
    const evalDone = doneRecord('cat-cafe-eval-a2a-current');
    const ttlDone = doneRecord('cat-cafe-ttl-expired');
    const quarantined = [evalDone.to, ttlDone.to];
    const evalDoneAt = Date.parse(evalDone.at);
    // Round 7: `done.at` is sampled after the move, not taken from the batch's start clock.
    assert.ok(evalDoneAt > BATCH_START && Date.parse(ttlDone.at) > BATCH_START);
    for (const done of [evalDone, ttlDone]) {
      const pend = ledgerRecords().find((r) => r.state === 'pending' && r.txn === done.txn);
      assert.ok(Date.parse(done.at) > Date.parse(pend.at), `done must be stamped after its move: ${done.to}`);
    }
    const atBatchStartWindow = opts({ now: BATCH_START + 14 * DAY }); // what the old batch clock would allow
    assert.deepEqual(
      purgeReap(planReap(collectEntries(atBatchStartWindow), undefined, atBatchStartWindow.now), atBatchStartWindow),
      [],
    );
    const firstDoneAt = Math.min(evalDoneAt, Date.parse(ttlDone.at));
    // Round 5: directories in quarantine WITHOUT a completed ledger record — one dropped in by hand under
    // an ancient-looking stamp, one whose move was only ever recorded as pending — must never be purged.
    const stray = join(qroot, quarantineStamp(T0 - 365 * DAY), 'cat-cafe-stray');
    const pending = join(qroot, quarantineStamp(T0 - 365 * DAY), 'cat-cafe-pending');
    for (const d of [stray, pending]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'only-copy.txt'), 'mine\n');
    }
    appendFileSync(
      join(qroot, 'ledger.jsonl'),
      `${JSON.stringify({ at: new Date(T0 - 365 * DAY).toISOString(), action: 'quarantine', state: 'pending', to: pending })}\n`,
    );
    const early = opts({ now: firstDoneAt + 14 * DAY - 1 }); // one ms short of the earliest window
    assert.deepEqual(purgeReap(planReap(collectEntries(early), undefined, early.now), early), []);
    for (const q of quarantined) assert.equal(existsSync(q), true, q);

    // Round 6: the ledger is folded per destination in log order, per transaction.
    // (a) An older `done` must not authorise a newer `pending` for the same destination.
    const [evalQ, ttlQ] = quarantined;
    const ledgerLine = (rec) =>
      `${JSON.stringify({ at: new Date(firstDoneAt).toISOString(), action: 'quarantine', ...rec })}\n`;
    appendFileSync(join(qroot, 'ledger.jsonl'), ledgerLine({ state: 'pending', txn: 'newer-attempt', to: ttlQ }));
    // (b) A `done` whose transaction matches no pending (forged / corrupted) authorises nothing.
    const forged = join(qroot, quarantineStamp(T0 - 365 * DAY), 'cat-cafe-forged');
    mkdirSync(forged, { recursive: true });
    writeFileSync(join(forged, 'only-copy.txt'), 'mine\n');
    appendFileSync(join(qroot, 'ledger.jsonl'), ledgerLine({ state: 'done', txn: 'never-pending', to: forged }));

    const late = opts({ now: Math.max(evalDoneAt, Date.parse(ttlDone.at)) + 14 * DAY });
    const results = purgeReap(planReap(collectEntries(late), undefined, late.now), late);
    assert.deepEqual(
      results.map((r) => `${r.name}:${r.outcome}`),
      ['cat-cafe-eval-a2a-current:purged'],
    );
    assert.equal(existsSync(evalQ), false);
    assert.equal(existsSync(ttlQ), true, 'superseded done must not purge the newer pending entry');
    const unrecorded = planReap(collectEntries(late), undefined, late.now).filter((e) => e.quarantined);
    assert.deepEqual(unrecorded.map((e) => `${e.name}:${e.verdict}:${e.reason}`).sort(), [
      'cat-cafe-forged:review:quarantine-unrecorded',
      'cat-cafe-pending:review:quarantine-unrecorded',
      'cat-cafe-stray:review:quarantine-unrecorded',
      'cat-cafe-ttl-expired:review:quarantine-unrecorded',
    ]);
    for (const d of [stray, pending, forged]) assert.equal(readFileSync(join(d, 'only-copy.txt'), 'utf8'), 'mine\n');
    assert.match(git(fx.repo, 'worktree', 'list'), /cat-cafe-ttl-expired/);
    for (const kept of ['cat-cafe-declared', 'cat-cafe-undeclared', 'cat-cafe-dirty', 'cat-cafe-leftover']) {
      assert.equal(existsSync(join(fx.parent, kept)), true, kept);
    }
  });
});
