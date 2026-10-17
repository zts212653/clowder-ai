import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureLaunchdIdentity } from './preview-process-launchers.mjs';

const pid = 4242,
  label = 'com.catcafe.preview.fixture';
const expectedCommand =
  '/node /repo/preview-process-lease-runner.mjs --completion-path /fixture/result.json -- /node server.js';
const proxy = { processStartedAt: 'Mon Oct 12 22:59:55 2026', processCommand: `xpcproxy ${label}` };
const runner = { ...proxy, processCommand: expectedCommand };
const proof = { expectedCommand, readJobPid: () => pid };
test('records the owned supervisor after xpcproxy exec without changing birth', async () => {
  let reads = 0;
  assert.deepEqual(await captureLaunchdIdentity(pid, label, () => (++reads === 1 ? proxy : runner), proof), runner);
  assert.equal(reads, 2);
});
test('rejects a different final executable, not merely any non-xpcproxy command', async () => {
  assert.equal(
    await captureLaunchdIdentity(pid, label, () => ({ ...proxy, processCommand: 'sleep 100' }), proof),
    null,
  );
});
test('rejects reuse of the PID across the exec observation', async () => {
  let reads = 0;
  assert.equal(
    await captureLaunchdIdentity(
      pid,
      label,
      () => (++reads === 1 ? proxy : { ...runner, processStartedAt: 'Mon Oct 12 23:00:01 2026' }),
      proof,
    ),
    null,
  );
});
test('rejects a job whose published PID no longer matches the captured process', async () => {
  assert.equal(await captureLaunchdIdentity(pid, label, () => runner, { ...proof, readJobPid: () => pid + 1 }), null);
});
test('does not publish a proxy that never reaches the supervisor', async () => {
  assert.equal(await captureLaunchdIdentity(pid, label, () => proxy, proof), null);
});
