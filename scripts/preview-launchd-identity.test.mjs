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
test('missing expected executable or job identity cannot certify a supervisor', async () => {
  for (const incomplete of [{}, { expectedCommand }, { readJobPid: () => pid }]) {
    assert.equal(await captureLaunchdIdentity(pid, label, () => runner, incomplete), null);
  }
});
for (const processCommand of [`xpcproxy ${label}`, '(xpcproxy)']) {
  test(`records the owned supervisor after ${processCommand} exec without changing birth`, async () => {
    let reads = 0;
    assert.deepEqual(
      await captureLaunchdIdentity(pid, label, () => (++reads === 1 ? { ...proxy, processCommand } : runner), proof),
      runner,
    );
    assert.equal(reads, 2);
  });
}
test('rejects a different final executable, not merely any non-xpcproxy command', async () => {
  for (const processCommand of ['sleep 100', '(node)', `xpcproxy ${label}-foreign`]) {
    assert.equal(await captureLaunchdIdentity(pid, label, () => ({ ...proxy, processCommand }), proof), null);
    let reads = 0;
    assert.equal(
      await captureLaunchdIdentity(
        pid,
        label,
        () => ({ ...proxy, processCommand: ++reads === 1 ? '(xpcproxy)' : processCommand }),
        proof,
      ),
      null,
    );
    assert.equal(reads, 2, 'a real proxy transition cannot authorize an unexpected final command');
  }
});
for (const processCommand of [`xpcproxy ${label}`, '(xpcproxy)']) {
  test(`rejects reuse of the PID across the ${processCommand} exec observation`, async () => {
    let reads = 0;
    assert.equal(
      await captureLaunchdIdentity(
        pid,
        label,
        () =>
          ++reads === 1 ? { ...proxy, processCommand } : { ...runner, processStartedAt: 'Mon Oct 12 23:00:01 2026' },
        proof,
      ),
      null,
    );
  });
}
test('rejects a job whose published PID no longer matches the captured process', async () => {
  assert.equal(await captureLaunchdIdentity(pid, label, () => runner, { ...proof, readJobPid: () => pid + 1 }), null);
});
test('rejects a job PID change while a parenthesized proxy is execing', async () => {
  let jobReads = 0,
    identityReads = 0;
  assert.equal(
    await captureLaunchdIdentity(
      pid,
      label,
      () => {
        identityReads += 1;
        return { ...proxy, processCommand: '(xpcproxy)' };
      },
      { ...proof, readJobPid: () => (++jobReads === 1 ? pid : pid + 1) },
    ),
    null,
  );
  assert.equal(identityReads, 1, 'a replaced job must not read or publish another final identity');
});
for (const processCommand of [`xpcproxy ${label}`, '(xpcproxy)']) {
  test(`does not publish ${processCommand} when it never reaches the supervisor`, async () => {
    assert.equal(await captureLaunchdIdentity(pid, label, () => ({ ...proxy, processCommand }), proof), null);
  });
}
