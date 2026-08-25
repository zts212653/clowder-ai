import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const startDev = readFileSync(resolve(ROOT, 'scripts/start-dev.sh'), 'utf8');
const runtimeWorktree = readFileSync(resolve(ROOT, 'scripts/runtime-worktree.sh'), 'utf8');
const alphaWorktree = readFileSync(resolve(ROOT, 'scripts/alpha-worktree.sh'), 'utf8');
const startEntry = readFileSync(resolve(ROOT, 'scripts/start-entry.mjs'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

test('start-dev daemon lifecycle uses namespaced, identity-checked state', () => {
  assert.match(startDev, /DAEMON_DEPLOYMENT_ID="\$\{CAT_CAFE_DEPLOYMENT_ID:-worktree\}"/);
  assert.match(startDev, /DAEMON_STATE_HELPER="\$SCRIPT_DIR\/daemon-state\.mjs"/);
  assert.match(startDev, /daemon_state stop/);
  assert.match(startDev, /daemon_state write[\s\S]*--launch-token "\$DAEMON_LAUNCH_TOKEN"/);
  assert.match(startDev, /--cat-cafe-daemon-token="\$DAEMON_LAUNCH_TOKEN"/);
  assert.doesNotMatch(startDev, /kill -TERM "\$DAEMON_PID"/);
  assert.doesNotMatch(startDev, /DAEMON_PID_FILE="\$\{DAEMON_STATE_DIR\}\/daemon\.pid"/);
});

test('official runtime and alpha wrappers declare deployment identity before start or stop', () => {
  assert.match(runtimeWorktree, /export CAT_CAFE_DEPLOYMENT_ID=runtime/);
  assert.match(runtimeWorktree, /stop\)\s+stop_runtime_daemon/);
  assert.match(runtimeWorktree, /daemon-status\)\s+status_runtime_daemon/);
  assert.match(alphaWorktree, /export CAT_CAFE_DEPLOYMENT_ID=alpha/);
  assert.match(alphaWorktree, /stop\)\s+stop_alpha_daemon/);
});

test('package scripts expose unambiguous stop commands', () => {
  assert.equal(pkg.scripts['dev:stop'], './scripts/start-dev.sh --stop');
  assert.equal(pkg.scripts['runtime:stop'], './scripts/runtime-worktree.sh stop');
  assert.equal(pkg.scripts['alpha:stop'], './scripts/alpha-worktree.sh stop');
});

test('start:status reads the official runtime namespace', () => {
  assert.match(startEntry, /args = \['daemon-status'\]/);
  assert.match(startEntry, /cmd = resolve\(__dirname, 'runtime-worktree\.sh'\)/);
});
