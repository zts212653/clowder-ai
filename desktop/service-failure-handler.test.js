const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServiceFailureHandler } = require('./service-failure-handler');
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('native failure notice remains actionable without a renderer or HTTP service', async () => {
  const shown = [];
  let quits = 0;
  const handler = createServiceFailureHandler({
    dialog: {
      showMessageBox: async (options) => {
        shown.push(options);
        return { response: 0 };
      },
    },
    getState: () => ({ isQuitting: false }),
    requestQuit: async (source) => {
      assert.equal(source, 'service-failure');
      quits += 1;
    },
    dbg: () => {},
  });
  handler({ name: 'web', code: 1, signal: null });
  await settle();
  assert.equal(shown.length, 1);
  assert.match(shown[0].detail, /web.*完全退出/);
  assert.match(shown[0].detail, /托盘/);
  assert.equal(shown[0].cancelId, 1);
  assert.equal(quits, 1);
});

test('dismissing the dialog does not force quit or restart services', async () => {
  let quits = 0;
  createServiceFailureHandler({
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    getState: () => ({ isQuitting: false }),
    requestQuit: () => {
      quits += 1;
    },
    dbg: () => {},
  })({ name: 'redis', code: 0, signal: null });
  await settle();
  assert.equal(quits, 0);
});

test('quit or update in progress suppresses the runtime prompt', () => {
  createServiceFailureHandler({
    dialog: { showMessageBox: () => assert.fail('must not prompt while quitting') },
    getState: () => ({ isQuitting: true }),
    requestQuit: () => assert.fail('must not request another quit'),
    dbg: () => {},
  })({ name: 'api', code: 1, signal: null });
});

test('dialog rejection is observed without an unhandled rejection', async () => {
  const logs = [];
  createServiceFailureHandler({
    dialog: {
      showMessageBox: async () => {
        throw new Error('dialog unavailable');
      },
    },
    getState: () => ({ isQuitting: false }),
    requestQuit: () => assert.fail('failed dialog is not consent to quit'),
    dbg: (message) => logs.push(message),
  })({ name: 'api', code: 1, signal: null });
  await settle();
  assert.match(logs[1], /dialog unavailable/);
});
