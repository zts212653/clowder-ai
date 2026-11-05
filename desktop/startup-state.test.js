const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createStartupReporter, showStartupFailure } = require('./startup-state');
const { createStartupFailureHandler } = require('./startup-failure-handler');
const { consentPath, consumeMemoryFallbackConsent } = require('./memory-fallback-consent');

test('a supervisor can read terminal failure before any UI action, without stale process identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-state-'));
  try {
    const report = createStartupReporter(root);
    report('starting');
    report('failed', 'API exited before ready');
    const state = JSON.parse(fs.readFileSync(path.join(root, 'startup-state.json')));
    assert.equal(state.phase, 'failed');
    assert.equal(state.pid, process.pid);
    assert.equal(state.message, 'API exited before ready');
    assert.ok(state.updatedAt >= state.startedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup failure handler reports the sanitized failure before showing it and stopping services', async () => {
  const events = [];
  let phase;
  let shownMessage;
  const handler = createStartupFailureHandler({
    isQuitting: () => false,
    setPhase: (value) => {
      phase = value;
    },
    dbg: () => {},
    reportStartup: (value, message) => events.push(`report:${value}:${message}`),
    sendSplashStatus: (message) => events.push(`splash:${message}`),
    stopServices: async () => events.push('stop'),
    showFailure: async (message) => {
      shownMessage = message;
      events.push('show');
    },
    quitApp: async () => events.push('quit'),
  });

  await handler(new Error('connect ECONNREFUSED https://secret.example/token\nretry'));

  assert.equal(phase, 'failed');
  assert.equal(shownMessage, 'connect ECONNREFUSED [url] retry', 'the dialog gets the safe message, not the raw error');
  assert.deepEqual(events, [
    'report:failed:connect ECONNREFUSED [url] retry',
    'splash:Startup failed: 请查看启动错误与日志',
    'stop',
    'show',
    'quit',
  ]);
  assert.ok(events.indexOf('show') > events.indexOf('stop'), 'services stop before the dialog opens');
});

test('startup failure handler stops services once through a shared promise and honours an in-progress quit', async () => {
  const events = [];
  let isQuitting = false;
  let resolveStop;
  const handler = createStartupFailureHandler({
    isQuitting: () => isQuitting,
    setPhase: () => {},
    dbg: () => {},
    reportStartup: () => {},
    sendSplashStatus: () => {},
    stopServices: () => {
      events.push('stop');
      return new Promise((resolve) => {
        resolveStop = resolve;
      });
    },
    showFailure: async () => events.push('show'),
    quitApp: async () => {
      events.push('quit');
      isQuitting = true;
    },
  });

  const first = handler(new Error('first failure'));
  const second = handler(new Error('second failure'));
  assert.equal(first, second, 'concurrent failures share one shutdown promise');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['stop'], 'the failure dialog waits for the services to stop');
  resolveStop();
  await first;
  assert.deepEqual(events, ['stop', 'show', 'quit']);

  await handler(new Error('a later failure'));
  assert.deepEqual(events, ['stop', 'show', 'quit'], 'a failure after quit begins cannot rerun the shutdown');
});

test('startup failure handler awaits failing cleanup and still shows the dialog and quits', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const events = [];
    const logged = [];
    const handler = createStartupFailureHandler({
      isQuitting: () => false,
      setPhase: () => {},
      dbg: (line) => logged.push(line),
      reportStartup: () => {},
      sendSplashStatus: () => {},
      stopServices: async () => {
        throw new Error('stop failed');
      },
      showFailure: async () => {
        throw new Error('dialog failed');
      },
      quitApp: async () => events.push('quit'),
    });

    await handler(new Error('startup failed'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, [], 'the rejected cleanup promises are awaited, not orphaned');
    assert.deepEqual(events, ['quit'], 'a cleanup failure still reaches the final quit');
    assert.ok(logged.includes('Desktop startup failure: could not stop services: stop failed'));
    assert.ok(logged.includes('Desktop startup failure: could not show the failure dialog: dialog failed'));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the asynchronous startup prompt opens the actual logs directory only when selected', async () => {
  const opened = [];
  let supplied;
  await showStartupFailure({
    dialog: {
      showMessageBox: async (options) => {
        supplied = options;
        return { response: 0 };
      },
    },
    shell: { openPath: async (dir) => opened.push(dir) },
    message: 'API exited',
    logDir: 'private/logs',
  });
  assert.match(supplied.detail, /API exited.*\n\n.*private\/logs/);
  assert.deepEqual(opened, ['private/logs']);
});

test('the startup prompt offers one-launch memory storage only for a recoverable Redis failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-memory-offer-'));
  const events = [];
  let supplied;
  const app = {
    relaunch: () => events.push('relaunch'),
    exit: (code) => events.push(`exit:${code}`),
  };
  try {
    const outcome = await showStartupFailure({
      app,
      dialog: {
        showMessageBox: async (options) => {
          supplied = options;
          return { response: 1 };
        },
      },
      shell: { openPath: async () => {} },
      message: 'Redis 不可用',
      userDataRoot: root,
      error: Object.assign(new Error('Redis 不可用'), {
        code: 'REDIS_UNAVAILABLE',
        recovery: { allowMemoryOnce: true },
      }),
    });
    assert.equal(supplied.buttons.length, 3);
    assert.match(supplied.buttons[1], /仅本次使用内存存储/);
    assert.deepEqual(events, ['relaunch', 'exit:0']);
    assert.equal(outcome, 'relaunch');
    assert.equal(fs.existsSync(consentPath(root)), true, 'the chosen degraded launch is recorded for the relaunch');
    assert.equal(consumeMemoryFallbackConsent(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unrecoverable startup failure keeps the plain dialog and never consents to memory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-memory-denied-'));
  let supplied;
  const events = [];
  try {
    const outcome = await showStartupFailure({
      app: { relaunch: () => events.push('relaunch'), exit: () => events.push('exit') },
      dialog: {
        showMessageBox: async (options) => {
          supplied = options;
          return { response: 1 };
        },
      },
      shell: { openPath: async () => {} },
      message: 'API exited',
      userDataRoot: root,
      error: new Error('API exited'),
    });
    assert.equal(supplied.buttons.length, 2);
    assert.equal(fs.existsSync(consentPath(root)), false);
    assert.equal(outcome, 'quit');
    assert.deepEqual(events, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Redis failure that cannot degrade (isolated) is not offered the memory choice', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-memory-isolated-'));
  let supplied;
  const events = [];
  try {
    const outcome = await showStartupFailure({
      app: { relaunch: () => events.push('relaunch'), exit: () => events.push('exit') },
      dialog: {
        showMessageBox: async (options) => {
          supplied = options;
          return { response: 1 };
        },
      },
      shell: { openPath: async () => {} },
      message: 'Redis 不可用',
      userDataRoot: root,
      error: Object.assign(new Error('Redis 不可用'), {
        code: 'REDIS_UNAVAILABLE',
        recovery: { allowMemoryOnce: false },
      }),
    });
    assert.equal(supplied.buttons.length, 2, 'the isolated instance can never honor the memory choice');
    assert.doesNotMatch(supplied.detail, /临时内存存储/);
    assert.equal(fs.existsSync(consentPath(root)), false);
    assert.equal(outcome, 'quit');
    assert.deepEqual(events, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a relaunching failure dialog does not also quit the app', async () => {
  const events = [];
  const handler = createStartupFailureHandler({
    isQuitting: () => false,
    setPhase: () => {},
    dbg: () => {},
    reportStartup: () => {},
    sendSplashStatus: () => {},
    stopServices: async () => events.push('stop'),
    showFailure: async () => 'relaunch',
    quitApp: async () => events.push('quit'),
  });
  await handler(new Error('Redis 不可用'));
  assert.deepEqual(events, ['stop'], 'the relaunched process owns the next attempt');
});
