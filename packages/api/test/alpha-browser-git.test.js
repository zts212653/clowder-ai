import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAlphaBrowserTemplate } from '../dist/infrastructure/scheduler/templates/alpha-browser.js';
import { fixture } from './helpers/alpha-browser-template-fixture.js';

function repositories(t) {
  const root = mkdtempSync(join(tmpdir(), 'alpha-git-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote'),
    client = join(root, 'client');
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '-qb', 'main', remote);
  const commit = () => {
    git(
      remote,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'revision',
    );
    return git(remote, 'rev-parse', 'HEAD');
  };
  const baseline = commit();
  git(root, 'clone', '-q', remote, client);
  const target = commit();
  git(remote, 'tag', 'unrelated-tag');
  const f = fixture(),
    calls = [],
    failedDiscoveries = [];
  delete f.options.inspectMain;
  f.options.repoRoot = client;
  f.runtime.runAlphaBrowserRevision = async (input) => {
    if (input.targetSha !== undefined) calls.push(input.targetSha);
    else {
      assert.match(input.discoveryError, /Command failed/);
      failedDiscoveries.push(input);
    }
    return { status: 'idle' };
  };
  const execute = (repoRoot = client, signal = f.context.signal) =>
    createAlphaBrowserTemplate({ ...f.options, repoRoot })
      .createSpec('alpha-subscription', f.params)
      .run.execute('alpha', 'alpha', { ...f.context, signal });
  return { root, remote, client, baseline, target, git, calls, failedDiscoveries, execute };
}

for (const peerHoldsRefLock of [false, true]) {
  test(`Alpha pins remote main without writing shared refs or FETCH_HEAD (peer lock: ${peerHoldsRefLock})`, async (t) => {
    const f = repositories(t),
      peer = join(f.root, 'peer');
    f.git(f.client, 'worktree', 'add', '--detach', '-q', peer, f.baseline);
    const fetchHead = join(f.client, '.git', 'FETCH_HEAD');
    writeFileSync(fetchHead, 'peer-owned fetch result\n');
    const refsBefore = f.git(f.client, 'show-ref');
    const lockPath = join(f.client, '.git', 'refs', 'remotes', 'origin', 'main.lock');
    if (peerHoldsRefLock) writeFileSync(lockPath, 'peer-owned ref transaction\n');
    const results = await Promise.allSettled([f.execute(), f.execute(peer)]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    assert.deepEqual(f.calls, [f.target, f.target]);
    assert.equal(f.git(f.client, 'rev-parse', `${f.target}^{commit}`), f.target);
    assert.equal(
      f.git(f.client, 'show-ref'),
      refsBefore,
      'discovery must not advance another worktree’s remote-tracking refs or tags',
    );
    assert.equal(readFileSync(fetchHead, 'utf8'), 'peer-owned fetch result\n');
    if (peerHoldsRefLock) assert.equal(readFileSync(lockPath, 'utf8'), 'peer-owned ref transaction\n');
  });
}

test('remote failure, missing main and cancellation never execute a stale local target', async (t) => {
  const f = repositories(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.execute(f.client, controller.signal), { name: 'AbortError' });
  assert.deepEqual(f.failedDiscoveries, [], 'cancellation must not enter enrolled work');
  f.git(f.remote, 'branch', '-m', 'other');
  await assert.rejects(f.execute(), /Command failed/);
  f.git(f.client, 'remote', 'set-url', 'origin', join(f.root, 'absent'));
  await assert.rejects(f.execute(), /Command failed/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.failedDiscoveries.length, 2, 'failed discovery may inspect only the existing durable queue');
  assert.equal(f.git(f.client, 'rev-parse', 'origin/main'), f.baseline);
});
