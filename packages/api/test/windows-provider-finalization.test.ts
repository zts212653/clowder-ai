import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as hosts from '../src/utils/windows-provider-host.js';

test('a completed Windows turn stays occupied until its exact jobs are confirmed closed', async () => {
  const execution = {
    executionId: 'parent',
    invocationId: 'child',
    threadId: 'thread',
    userId: 'user',
    catId: 'codex',
  };
  let attempts = 0;
  let confirmExit!: () => void;
  const exit = new Promise<void>((resolve) => {
    confirmExit = resolve;
  });
  let terminalStarted!: () => void;
  const settling = new Promise<void>((resolve) => {
    terminalStarted = resolve;
  });
  let commitTerminal!: () => void;
  const terminal = new Promise<void>((resolve) => {
    commitTerminal = resolve;
  });
  const finalization = hosts.waitForWindowsProviderFinalization(
    execution,
    async () => {
      attempts++;
      if (attempts === 1) return false;
      await exit;
      terminalStarted();
      await terminal;
      return true;
    },
    { retryMs: 1 },
  );

  assert.equal(hosts.isWindowsProviderFinalizing(execution), true);
  assert.equal(hosts.isWindowsProviderFinalizing({ ...execution, executionId: 'replacement' }), false);
  assert.equal(attempts, 1);
  confirmExit();
  await settling;
  assert.equal(hosts.isWindowsProviderFinalizing(execution), true);
  commitTerminal();
  assert.equal(await finalization, true);
  assert.equal(attempts, 2);
  assert.equal(hosts.isWindowsProviderFinalizing(execution), false);
});
