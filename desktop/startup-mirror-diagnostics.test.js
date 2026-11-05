const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { waitForProjectMirrors } = require('./project-mirror-readiness');
const { createStartupFailureHandler } = require('./startup-failure-handler');
const { createStartupReporter } = require('./startup-state');
const { createDesktopLogger } = require('./runtime-config');

test('real failed consumer reads reach both desktop logs and the supervisor before the failure dialog', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-mirror-diagnostic-'));
  const desktop = [];
  const logDir = path.join(root, 'data', 'logs');
  const order = [];
  try {
    let failure;
    try {
      await waitForProjectMirrors({
        installRoot: path.join(root, 'installed'),
        projectDir: path.join(root, 'project'),
        nodeExe: process.execPath,
        timeoutMs: 1500,
        log: (line) => desktop.push(line),
      });
      assert.fail('missing installed resources must still reject startup');
    } catch (error) {
      failure = error;
    }
    const attempts = failure.projectMirrorDiagnostics.consumerAttempts;
    assert.ok(attempts.length > 0, 'at least one real Node consumer was attempted');
    assert.ok(attempts.some((event) => event.status === 'read_failed'));
    for (const attempt of attempts) {
      const events = desktop
        .filter((line) => line.startsWith('Project mirror consumer diagnostic '))
        .map((line) => JSON.parse(line.slice('Project mirror consumer diagnostic '.length)))
        .filter((event) => event.attempt === attempt.attempt);
      assert.deepEqual(
        events.map((event) => event.phase),
        ['started', 'settled'],
      );
    }
    await createStartupFailureHandler({
      isQuitting: () => false,
      setPhase: () => {},
      dbg: createDesktopLogger(root),
      reportStartup: createStartupReporter(logDir),
      sendSplashStatus: () => {},
      stopServices: async () => order.push('stop'),
      showFailure: async (message) => {
        const state = JSON.parse(fs.readFileSync(path.join(logDir, 'startup-state.json')));
        assert.equal(state.phase, 'failed');
        assert.deepEqual(state.diagnostics.consumerAttempts, attempts);
        assert.ok(message.length <= 300);
        order.push('show');
      },
      quitApp: async () => order.push('quit'),
    })(failure);
    const main = fs.readFileSync(path.join(logDir, 'main.log'), 'utf8').split('\n');
    const tail = attempts.at(-1);
    assert.ok(
      main.some((line) => line.includes(`"attempt":${tail.attempt},`) && line.includes(`"status":"${tail.status}"`)),
    );
    assert.deepEqual(order, ['stop', 'show', 'quit']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
