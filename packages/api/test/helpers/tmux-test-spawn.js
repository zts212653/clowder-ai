import { spawnCliInTmux } from '../../dist/domains/terminal/tmux-agent-spawner.js';

/**
 * Bind real tmux work to the owning node:test lifecycle. A test timeout aborts
 * TestContext.signal, but it does not otherwise cancel an awaited generator.
 */
export function spawnCliInTmuxForTest(testContext, options, deps) {
  return spawnCliInTmux(
    {
      ...options,
      signal: options.signal ?? testContext.signal,
    },
    deps,
  );
}
