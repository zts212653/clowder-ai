import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureTerminalInteraction } from '../dist/utils/capture-terminal-interaction.js';

test('Host captures output from a real isolated PTY after writing a single command', async () => {
  const script = `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    console.log('ready');
    rl.once('line', (line) => {
      console.log('first: ' + line);
      setTimeout(() => console.log('second: ' + process.env.PTY_FIXTURE_MARKER), 30);
    });
  `;
  const result = await captureTerminalInteraction({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      PTY_FIXTURE_MARKER: 'isolated-only',
    },
    submit: '/usage',
    startAfterMs: 1_100,
    settleAfterMs: 500,
    signal: AbortSignal.timeout(7_000),
  });
  assert.match(result.output, /first: \/usage/);
  assert.match(result.output, /second: isolated-only/);
  assert.ok(result.observedAt > 0);
});

test('a terminal interaction rejects cancellation before submitting input', async () => {
  await assert.rejects(
    captureTerminalInteraction({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
      submit: '/usage',
      startAfterMs: 5_000,
      settleAfterMs: 500,
      signal: AbortSignal.timeout(300),
    }),
    { name: 'TimeoutError' },
  );
});
