import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCloneJobs } from './lib/worktree-clone-worker.mjs';
import { fixture, git } from './lib/worktree-finish-fixture.mjs';
import { createWorktree } from './worktree-new.mjs';

const posixShim = { skip: process.platform === 'win32' };

function setup(t, reject) {
  const f = fixture();
  const bin = join(f.root, 'bin');
  const trace = join(f.root, 'git-calls.jsonl');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
if (${reject}) { process.stderr.write('simulated unsupported Git command / ENOSPC\\n'); process.exit(129); }
const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(f.root, { recursive: true, force: true });
  });
  const create = (name, options = {}) =>
    createWorktree({
      repo: f.repo,
      path: join(f.root, name),
      branch: `test/${name}`,
      owner: 'codex61-sol',
      ...options,
    });
  return {
    ...f,
    create,
    calls: () =>
      readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  };
}

test('portable light/full fallbacks work without Git 2.36 hook and worktree-list -z commands', posixShim, (t) => {
  const f = setup(
    t,
    "args.includes('hook') || (args.includes('worktree') && args.includes('list') && args.includes('-z'))",
  );
  for (const full of [false, true]) {
    const name = full ? 'cat-cafe-full' : 'cat-cafe-light';
    const result = f.create(name, { full, checkoutOptions: { supportsClone: () => false } });
    assert.equal(result.strategy, 'git');
    assert.equal(readFileSync(join(f.root, name, 'README.md'), 'utf8'), 'original\n');
    assert.equal(git(join(f.root, name), 'status', '--porcelain'), '');
  }
  assert.equal(
    f
      .calls()
      .some(
        (args) => args.includes('hook') || (args.includes('worktree') && args.includes('list') && args.includes('-z')),
      ),
    false,
  );
  const adds = f.calls().filter((args) => args.includes('worktree') && args.includes('add'));
  assert.equal(adds[0].includes('--no-checkout'), true);
  assert.equal(adds[1].includes('--no-checkout'), false, 'full fallback uses the original Git checkout and hooks');
});

test('a failure before index population removes only this freshly created checkout and branch', posixShim, (t) => {
  const f = setup(t, "args.includes('read-tree') && !args.includes('-mu')");
  assert.throws(() => f.create('cat-cafe-empty', { checkoutOptions: { supportsClone: () => true } }), /rolled back/);
  assert.equal(existsSync(join(f.root, 'cat-cafe-empty')), false);
  assert.equal(git(f.repo, 'worktree', 'list', '--porcelain').includes('cat-cafe-empty'), false);
  assert.throws(() => git(f.repo, 'show-ref', '--verify', 'refs/heads/test/cat-cafe-empty'));
  assert.equal(readFileSync(join(f.repo, 'README.md'), 'utf8'), 'original\n');
});

test('a declaration failure after materialization still preserves unexpected work', posixShim, (t) => {
  const f = setup(t, 'false');
  const name = 'cat-cafe-valuable';
  assert.throws(
    () =>
      f.create(name, {
        checkoutOptions: { supportsClone: () => false },
        declare(path) {
          writeFileSync(join(path, 'valuable.txt'), 'keep\n');
          throw new Error('declare failed');
        },
      }),
    /rollback failed/,
  );
  assert.equal(readFileSync(join(f.root, name, 'valuable.txt'), 'utf8'), 'keep\n');
});

test('clone jobs overlap at most four cp processes and drain before returning', async () => {
  let active = 0,
    peak = 0;
  const completed = [];
  await runCloneJobs(
    Array.from({ length: 11 }, (_, n) => n),
    async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      completed.push(n);
      active--;
    },
  );
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(
    completed.sort((a, b) => a - b),
    Array.from({ length: 11 }, (_, n) => n),
  );
});
