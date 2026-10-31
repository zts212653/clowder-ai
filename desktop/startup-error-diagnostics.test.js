const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStartupFailureHandler } = require('./startup-failure-handler');
const { createStartupReporter } = require('./startup-state');
const { getStartupErrorDiagnostics } = require('./startup-error-diagnostics');

function mirrorError() {
  const failure = {
    reader: 'mirror',
    kind: 'docs',
    mirror: 'junction',
    path: 'C:\\project\\docs\\last-resource.yaml',
    code: 'UNKNOWN',
    errno: -4094,
    syscall: 'open',
    message: 'secret file contents',
  };
  return Object.assign(new Error(`${'long startup summary '.repeat(30)}https://secret.example/token`), {
    projectMirrorDiagnostics: {
      schemaVersion: 1,
      sourceFailures: [],
      mirrorFailures: [failure],
      consumerAttempts: Array.from({ length: 8 }, (_, index) => ({
        schemaVersion: 1,
        component: 'project-mirror-consumer',
        phase: 'settled',
        attempt: index + 1,
        pid: 120 + index,
        budgetMs: 1000,
        elapsedMs: 42,
        executable: 'C:\\app\\node.exe',
        status: 'read_failed',
        exitCode: 0,
        signal: null,
        stdoutBytes: 400,
        stderrBytes: 0,
        failures: [failure],
        stderr: 'Authorization: Bearer do-not-log',
        environment: { API_KEY: 'do-not-log' },
      })),
    },
    stack: 'secret stack with https://secret.example/token',
  });
}

function handlerFor(overrides = {}) {
  return createStartupFailureHandler({
    isQuitting: () => false,
    setPhase: () => {},
    dbg: () => {},
    reportStartup: () => {},
    sendSplashStatus: () => {},
    stopServices: async () => {},
    showFailure: async () => {},
    quitApp: async () => {},
    ...overrides,
  });
}

test('full mirror diagnostics survive the short UI summary in the log and supervisor state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-diagnostic-'));
  const lines = [];
  const events = [];
  let shown;
  try {
    const handler = handlerFor({
      dbg: (line) => lines.push(line),
      reportStartup: createStartupReporter(root),
      stopServices: async () => events.push('stop'),
      showFailure: async (message) => {
        shown = message;
        const state = JSON.parse(fs.readFileSync(path.join(root, 'startup-state.json')));
        assert.equal(state.diagnostics.consumerAttempts.at(-1).attempt, 8);
        events.push('show');
      },
      quitApp: async () => events.push('quit'),
    });
    await handler(mirrorError());
    const diagnosticLines = lines.filter((line) => line.startsWith('Desktop startup diagnostic '));
    assert.ok(diagnosticLines.length > 0, 'persist structured details separately from the 300 character UI summary');
    const records = diagnosticLines.map((line) => JSON.parse(line.slice('Desktop startup diagnostic '.length)));
    assert.equal(records.filter((record) => record.component === 'project-mirror-consumer').length, 8);
    assert.equal(records.at(-1).attempt, 8, 'the final consumer result must not be truncated');
    const state = JSON.parse(fs.readFileSync(path.join(root, 'startup-state.json')));
    assert.equal(state.diagnostics.mirrorFailures[0].errno, -4094);
    assert.equal(state.diagnostics.mirrorFailures[0].path, 'C:\\project\\docs\\last-resource.yaml');
    assert.equal(shown.length, 300, 'the dialog retains the existing short summary');
    assert.equal(state.message, shown);
    assert.deepEqual(events, ['stop', 'show', 'quit']);
    assert.doesNotMatch(JSON.stringify({ lines, state }), /secret|do-not-log|API_KEY|Authorization/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed optional diagnostics cannot prevent the original shutdown', async () => {
  const events = [];
  const error = new Error('original failure');
  Object.defineProperty(error, 'projectMirrorDiagnostics', {
    get() {
      throw new Error('broken metadata');
    },
  });
  await handlerFor({
    stopServices: async () => events.push('stop'),
    showFailure: async () => events.push('show'),
    quitApp: async () => events.push('quit'),
  })(error);
  assert.deepEqual(events, ['stop', 'show', 'quit']);
});

test('a diagnostic log failure still permits reporting, service shutdown, the dialog and quit', async () => {
  const events = [];
  await handlerFor({
    dbg: (line) => {
      if (line.startsWith('Desktop startup diagnostic ')) throw new Error('log unavailable');
    },
    reportStartup: () => events.push('report'),
    stopServices: async () => events.push('stop'),
    showFailure: async () => events.push('show'),
    quitApp: async () => events.push('quit'),
  })(mirrorError());
  assert.deepEqual(events, ['report', 'stop', 'show', 'quit']);
});

test('oversized structured diagnostics explicitly record omissions, and unknown errors stay summarized', () => {
  const error = mirrorError();
  const attempt = error.projectMirrorDiagnostics.consumerAttempts[0];
  error.projectMirrorDiagnostics.consumerAttempts = Array(70).fill(attempt);
  error.projectMirrorDiagnostics.mirrorFailures[0].path = 'p'.repeat(32769);
  const details = getStartupErrorDiagnostics(error);
  assert.equal(details.consumerAttempts.length, 64);
  assert.deepEqual(details.omitted, { consumerAttempts: 6 });
  assert.deepEqual(details.mirrorFailures[0].truncatedFields, ['path']);
  assert.equal(details.mirrorFailures[0].path.length, 32768);
  assert.equal(getStartupErrorDiagnostics(new Error('generic failure with secret data')), undefined);
});
