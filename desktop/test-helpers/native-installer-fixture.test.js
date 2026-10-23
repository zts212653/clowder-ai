const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const { runNativeCommand, withTempRoot } = require('./native-installer-fixture.cjs');

test('native fixture retains the original assertion when removal also fails', async () => {
  const primary = new Error('setup assertion: unexpected exit');
  const cleanup = Object.assign(new Error('fixture is locked'), { code: 'EPERM' });
  let fixture;
  try {
    await assert.rejects(
      withTempRoot(
        'installer-double-failure-',
        (root) => {
          fixture = root;
          throw primary;
        },
        {
          remove: () => {
            throw cleanup;
          },
        },
      ),
      (error) => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup,
    );
  } finally {
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('native fixture fails a timed-out process, retaining its stderr and setup log', async () => {
  await withTempRoot('installer-process-timeout-', async (root) => {
    fs.writeFileSync(require('node:path').join(root, 'setup.log'), 'INSTALLER_BEFORE_TIMEOUT');
    await assert.rejects(
      runNativeCommand(
        root,
        'setup',
        process.execPath,
        ['-e', "process.stderr.write('HELPER_BEFORE_TIMEOUT'); setInterval(() => {}, 1000)"],
        { timeoutMs: 2000 },
      ),
      (error) => {
        assert.match(error.message, /timed out/);
        assert.match(error.message, /HELPER_BEFORE_TIMEOUT/);
        assert.match(error.message, /INSTALLER_BEFORE_TIMEOUT/);
        assert.equal(error.cleanupError, undefined);
        assert.throws(() => process.kill(error.pid, 0), { code: 'ESRCH' });
        return true;
      },
    );
  });
});

test('native fixture preserves a real nonzero exit for product assertions', async () => {
  await withTempRoot('installer-process-exit-', async (root) => {
    const result = await runNativeCommand(root, 'setup', process.execPath, [
      '-e',
      "process.stderr.write('EXPECTED_HELPER_FAILURE'); process.exit(7)",
    ]);
    assert.equal(result.status, 7);
    assert.equal(result.stderr, 'EXPECTED_HELPER_FAILURE');
  });
});
