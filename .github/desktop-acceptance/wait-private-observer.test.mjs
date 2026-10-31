import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyInspectorOwner } from './attach-installed-api-observer.mjs';
import { PRIVATE_OBSERVER_SHA256, privateObserverRecords, waitForPrivateObserver } from './wait-private-observer.mjs';

const callback = { kind: 'collective_windows_private_execfile', observerSha256: PRIVATE_OBSERVER_SHA256 };
const baseline = {
  kind: 'collective_windows_private_readonly_baseline',
  observerSha256: PRIVATE_OBSERVER_SHA256,
  outcome: 'error',
};
const lines = (...rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

test('waits for the baseline without converting its failure into product success', async () => {
  let now = 0;
  const rows = await waitForPrivateObserver({
    read: () => (now === 0 ? lines(callback) : lines(callback, baseline)),
    now: () => now,
    pause: async (ms) => {
      now += ms;
    },
  });
  assert.equal(now, 250);
  assert.equal(rows[1].outcome, 'error');
});

test('missing callbacks fail at the bounded deadline', async () => {
  let now = 0;
  await assert.rejects(
    waitForPrivateObserver({
      read: () => '',
      now: () => now,
      pause: async (ms) => {
        now += ms;
      },
      timeoutMs: 1000,
    }),
  );
  assert.equal(now, 1000);
});

test('different code, duplicate records and malformed complete records are rejected', () => {
  assert.throws(() => privateObserverRecords(lines({ ...callback, observerSha256: '0'.repeat(64) }, baseline)));
  assert.throws(() => privateObserverRecords(lines(callback, callback)));
  assert.throws(() => privateObserverRecords(lines(callback, baseline, baseline)));
  assert.throws(() => privateObserverRecords('{bad}\n'));
  assert.equal(privateObserverRecords(lines(callback, baseline).slice(0, -1)), undefined);
});

test('OS listener ownership must match before any debugger command', () => {
  const output = (pid) =>
    process.platform === 'win32' ? `  TCP  127.0.0.1:35474  0.0.0.0:0  LISTENING  ${pid}\r\n` : `p${pid}\n`;
  verifyInspectorOwner(35474, 1234, () => output(1234));
  assert.throws(() => verifyInspectorOwner(35474, 1234, () => output(5678)));
  assert.throws(() => verifyInspectorOwner(35474, 1234, () => `${output(1234)}${output(5678)}`));
  assert.throws(() => verifyInspectorOwner(35474, 1234, () => ''));
});
