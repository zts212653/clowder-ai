import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serviceWorkerPath = join(apiRoot, 'src/plugins/cloud-cat-personal-host/extension/service-worker.js');

describe('Personal Chrome Native Messaging watchdog', () => {
  it('registers before disconnect so silent service-worker loss can recover', async () => {
    const serviceWorkerSource = await readFile(serviceWorkerPath, 'utf8');
    const ports = [];
    const alarmListeners = [];
    const createdAlarms = [];
    const transientTimers = [];
    const chrome = {
      runtime: {
        connectNative() {
          const disconnectListeners = [];
          const port = {
            onMessage: { addListener() {} },
            onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
            postMessage() {},
            disconnectListeners,
          };
          ports.push(port);
          return port;
        },
        lastError: null,
        onMessage: { addListener() {} },
      },
      alarms: {
        create(name, options) {
          createdAlarms.push({ name, options });
          return Promise.resolve();
        },
        onAlarm: { addListener: (listener) => alarmListeners.push(listener) },
      },
      action: {
        onClicked: { addListener() {} },
        setBadgeText() {},
        setTitle() {},
      },
      tabs: {},
    };

    runInNewContext(serviceWorkerSource, {
      chrome,
      URL,
      TextEncoder,
      clearTimeout() {},
      console: { warn() {} },
      setTimeout(callback, delay) {
        transientTimers.push({ callback, delay });
      },
    });
    assert.equal(ports.length, 1);
    assert.equal(createdAlarms.length, 1);
    assert.equal(createdAlarms[0].name, 'f247-native-host-reconnect');
    assert.equal(createdAlarms[0].options.delayInMinutes, 0.5);
    assert.equal(createdAlarms[0].options.periodInMinutes, 0.5);

    ports[0].disconnectListeners[0]();
    await Promise.resolve();

    assert.equal(transientTimers.length, 1);
    assert.equal(createdAlarms.length, 1);
    assert.equal(createdAlarms[0].name, 'f247-native-host-reconnect');
    assert.equal(createdAlarms[0].options.delayInMinutes, 0.5);
    assert.equal(alarmListeners.length, 1);

    // The service worker may terminate before its setTimeout callback. The alarm
    // is the browser-owned event that must still recreate the Native Messaging port.
    alarmListeners[0]({ name: 'f247-native-host-reconnect' });
    assert.equal(ports.length, 2);

    // Neither callback captured by the disconnected first port may replace the
    // live alarm-created port.
    transientTimers[0].callback();
    ports[0].disconnectListeners[0]();
    assert.equal(ports.length, 2);
    assert.equal(transientTimers.length, 1);

    // A current-port disconnect still recovers exactly once when both recovery
    // mechanisms run: the fast timer reconnects and the later alarm is a no-op.
    ports[1].disconnectListeners[0]();
    assert.equal(transientTimers.length, 2);
    transientTimers[1].callback();
    alarmListeners[0]({ name: 'f247-native-host-reconnect' });
    assert.equal(ports.length, 3);
  });
});
