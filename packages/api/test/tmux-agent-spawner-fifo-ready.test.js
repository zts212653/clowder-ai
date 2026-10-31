import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('deadline rescue fixtures drain and exit even when FIFO reader open is delayed', async () => {
  // Execute the test module directly: a timeout kills this sole child, not a
  // parent test runner that could leave a blocked FIFO worker behind.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--test-reporter=tap',
      '--import',
      fileURLToPath(new URL('./helpers/delay-fifo-reader-open.mjs', import.meta.url)),
      fileURLToPath(new URL('./tmux-agent-spawner-deadline-recheck.test.js', import.meta.url)),
    ],
    { timeout: 5000, killSignal: 'SIGKILL', env },
  );
  assert.match(stdout, /# pass 4/);
  assert.match(stdout, /# fail 0/);
});
