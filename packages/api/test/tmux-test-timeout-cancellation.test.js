import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';

const fixturePath = fileURLToPath(new URL('./fixtures/tmux-test-timeout-cancellation.fixture.js', import.meta.url));

test('a timed-out tmux test releases its generator and exits without an outer kill', { timeout: 30_000 }, async () => {
  const worktreeId = `test-tmux-timeout-cancel-${process.pid}-${Date.now()}`;
  const childEnv = { ...process.env, CAT_CAFE_TMUX_TEST_WORKTREE_ID: worktreeId };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [fixturePath], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  let requiredOuterKill = false;
  const watchdog = setTimeout(() => {
    requiredOuterKill = true;
    child.kill('SIGKILL');
  }, 20_000);

  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(requiredOuterKill, false, `timed-out child retained live tmux/FIFO work:\n${output}`);
    assert.equal(signal, null, `child should exit normally, got signal ${signal}:\n${output}`);
    assert.equal(code, 1, `the intentionally timed-out inner test must stay red:\n${output}`);
    assert.match(output, /test timed out after 200ms/);
  } finally {
    clearTimeout(watchdog);
    await new TmuxGateway().destroyServer(worktreeId);
  }
});
