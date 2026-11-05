const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createShutdownController } = require('./shutdown-controller');

function createFixture() {
  let services = null;
  let tray = { destroy() {} };
  let updatePrompt = { dispose() {} };
  let resolveStop;
  let stopCalls = 0;
  let quitCalls = 0;
  const stopPromise = new Promise((resolve) => {
    resolveStop = resolve;
  });
  services = {
    stopAll() {
      stopCalls += 1;
      return stopPromise;
    },
  };
  const controller = createShutdownController({
    app: { quit: () => (quitCalls += 1) },
    startupController: { abort() {} },
    getServices: () => services,
    setServices: (value) => (services = value),
    getTray: () => tray,
    setTray: (value) => (tray = value),
    getUpdater: () => ({ stopSchedule() {} }),
    getUpdatePrompt: () => updatePrompt,
    setUpdatePrompt: (value) => (updatePrompt = value),
    setQuitting: () => {},
    setPhase: () => {},
    dbg: () => {},
  });
  const event = () => {
    let prevented = 0;
    return {
      preventDefault() {
        prevented += 1;
      },
      get prevented() {
        return prevented;
      },
    };
  };
  return {
    controller,
    event,
    resolveStop,
    setServices: (value) => (services = value),
    get stopCalls() {
      return stopCalls;
    },
    get quitCalls() {
      return quitCalls;
    },
  };
}

test('before-quit re-entry blocks every event and shares the pending cleanup', async () => {
  const fixture = createFixture();
  const first = fixture.event();
  const second = fixture.event();

  const firstQuit = fixture.controller.handleBeforeQuit(first);
  const secondQuit = fixture.controller.handleBeforeQuit(second);

  assert.equal(first.prevented, 1);
  assert.equal(second.prevented, 1);
  assert.strictEqual(secondQuit, firstQuit);
  assert.equal(fixture.stopCalls, 1);

  fixture.resolveStop();
  await firstQuit;
  assert.equal(fixture.quitCalls, 1);
});

test('native before-quit arriving during quitApp cleanup is also blocked', async () => {
  const fixture = createFixture();
  const event = fixture.event();

  const quitPromise = fixture.controller.quitApp();
  const reentrantQuit = fixture.controller.handleBeforeQuit(event);

  assert.equal(event.prevented, 1);
  assert.strictEqual(reentrantQuit, quitPromise);
  assert.equal(fixture.stopCalls, 1);

  fixture.resolveStop();
  await quitPromise;
  assert.equal(fixture.quitCalls, 1);
});

test('before-quit with no services remains the native fast path', () => {
  const fixture = createFixture();
  fixture.setServices(null);
  const event = fixture.event();
  fixture.controller.handleBeforeQuit(event);
  assert.equal(event.prevented, 0);
});
