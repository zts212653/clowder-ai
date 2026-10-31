import { test } from 'node:test';
import { TmuxGateway } from '../../dist/domains/terminal/tmux-gateway.js';
import { spawnCliInTmuxForTest } from '../helpers/tmux-test-spawn.js';

const worktreeId = process.env.CAT_CAFE_TMUX_TEST_WORKTREE_ID;
if (!worktreeId) throw new Error('CAT_CAFE_TMUX_TEST_WORKTREE_ID is required');

test('node:test timeout cancels an active tmux generator', { timeout: 200 }, async (t) => {
  const generator = spawnCliInTmuxForTest(
    t,
    {
      command: '/bin/sh',
      // Self-bound even if the parent test process is forcibly terminated.
      args: ['-c', 'sleep 30'],
      worktreeId,
      invocationId: `test-timeout-cancellation-${process.pid}`,
      cwd: '/tmp',
      firstEventTimeoutMs: 0,
      timeoutMs: 0,
    },
    { tmuxGateway: new TmuxGateway() },
  );

  for await (const _event of generator) {
    // The test timeout is the only cancellation source in this fixture.
  }
});
