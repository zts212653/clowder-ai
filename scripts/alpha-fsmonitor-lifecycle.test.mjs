import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NAMED_ALPHA_PORTS, namedAlphaFixture } from './lib/alpha-named-fixture.mjs';
import { finishWorktree } from './worktree-finish.mjs';

const native = { skip: process.platform !== 'darwin' };
const realGit = process.platform === 'darwin' ? execFileSync('which', ['git'], { encoding: 'utf8' }).trim() : 'git';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t, instance, serviceStub = false) {
  const cleanups = [];
  let path;
  t.after(() => {
    try {
      // Only fixture teardown; never used to make its finish assertion pass.
      if (path && existsSync(path)) {
        spawnSync(realGit, ['-C', path, 'fsmonitor--daemon', 'stop'], { stdio: 'ignore', timeout: 5_000 });
      }
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  });
  const f = namedAlphaFixture({ after: (cleanup) => cleanups.push(cleanup) });
  if (serviceStub) f.captureChild();
  path = join(f.directory, `cat-cafe-alpha-${instance}`);
  const args = ['--instance', instance, '--ports', NAMED_ALPHA_PORTS];
  f.git(['config', '--worktree', 'core.fsmonitor', 'true']);
  const initial = f.run(['init', ...args]);
  assert.equal(initial.status, 0, initial.stderr);
  const socket = join(f.git(['rev-parse', '--absolute-git-dir'], path), 'fsmonitor--daemon.ipc');
  return { ...f, path, args, socket, alphaBranch: `alpha/${instance}-main-sync` };
}

function noMonitor(f, stage) {
  assert.equal(f.git(['config', '--worktree', '--get', 'core.fsmonitor'], f.path), 'true');
  assert.equal(existsSync(f.socket), false, `${stage} created a native monitor`);
  assert.equal(spawnSync(realGit, ['-C', f.path, 'fsmonitor--daemon', 'status']).status, 1);
}

function finish(f) {
  const options = { repo: f.mainRoot, path: f.path, owner: f.env.CAT_CAFE_CAT_ID, sourceRef: 'task:alpha-fsmonitor' };
  assert.equal(finishWorktree(options).storageDisposition, 'removed');
  assert.equal(finishWorktree({ ...options, mode: 'check' }).state, 'released');
  assert.equal(existsSync(f.path), false);
}

test('named Alpha inspection does not start fsmonitor before its first owner finish', native, (t) => {
  const f = fixture(t, 'fsmonitor-inspection');
  noMonitor(f, 'official initialization inspection');
  const repeated = f.run(['init', ...f.args]);
  assert.equal(repeated.status, 0, repeated.stderr);
  noMonitor(f, 'repeat inspection');
  finish(f);
});

test('named Alpha init to actual start sync does not create a monitor', native, (t) => {
  const f = fixture(t, 'fsmonitor-start', true);
  noMonitor(f, 'initialization');
  const started = f.run(['start', ...f.args]);
  assert.equal(started.status, 0, started.stderr);
  noMonitor(f, 'official named start sync');
  finish(f);
});

test('ordinary Alpha sync and post-install diff do not create a monitor', native, (t) => {
  const f = fixture(t, 'fsmonitor-sync');
  noMonitor(f, 'initialization');
  const synced = f.run(['sync', '--dir', f.path, '--branch', f.alphaBranch]);
  assert.equal(synced.status, 0, synced.stderr);
  assert.match(f.readCalls(), /pnpm .* install/u, 'the actual post-install lock-drift path was reached');
  noMonitor(f, 'official ordinary sync');
  finish(f);
});

test('ordinary Alpha lock-drift diff stays monitor-free when merge is independently suppressed', native, (t) => {
  const f = fixture(t, 'fsmonitor-diff');
  noMonitor(f, 'initialization');
  const trace = join(f.directory, 'diff-observed');
  writeFileSync(
    join(f.directory, 'bin/git'),
    `#!/bin/bash
case " $* " in
  *" merge "*) exec ${quote(realGit)} -c core.fsmonitor=false "$@" ;;
  *" diff "*) printf 'diff\\n' >> ${quote(trace)} ;;
esac
exec ${quote(realGit)} "$@"
`,
    { mode: 0o755 },
  );
  const synced = f.run(['sync', '--dir', f.path, '--branch', f.alphaBranch]);
  assert.equal(synced.status, 0, synced.stderr);
  assert.match(readFileSync(trace, 'utf8'), /diff/u);
  noMonitor(f, 'actual post-install diff');
  finish(f);
});
