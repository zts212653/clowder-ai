/**
 * F136 Phase 2: Connector reload subscriber tests
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { configEventBus, createChangeSetId } from '../dist/config/config-event-bus.js';
import { createConnectorReloadSubscriber } from '../dist/infrastructure/connectors/connector-reload-subscriber.js';

function makeEvent(changedKeys, source = 'secrets', scope = 'key') {
  return { source, scope, changedKeys, changeSetId: createChangeSetId(), timestamp: Date.now() };
}

const silentLog = { info() {}, warn() {}, error() {} };

describe('createConnectorReloadSubscriber', () => {
  let unsub;

  afterEach(() => {
    unsub?.unsubscribe();
    unsub = undefined;
  });

  it('calls onRestart when a connector key changes', async () => {
    let called = 0;
    unsub = createConnectorReloadSubscriber({
      onRestart: async () => {
        called++;
      },
      debounceMs: 0,
      log: silentLog,
    });
    configEventBus.emitChange(makeEvent(['TELEGRAM_BOT_TOKEN']));
    // debounceMs=0 still uses setTimeout(0), so yield
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, 1);
  });

  it('does NOT call onRestart for non-connector keys', async () => {
    let called = 0;
    unsub = createConnectorReloadSubscriber({
      onRestart: async () => {
        called++;
      },
      debounceMs: 0,
      log: silentLog,
    });
    configEventBus.emitChange(makeEvent(['OPENAI_API_KEY']));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, 0);
  });

  it('debounces: two rapid events produce one restart', async () => {
    let called = 0;
    unsub = createConnectorReloadSubscriber({
      onRestart: async () => {
        called++;
      },
      debounceMs: 50,
      log: silentLog,
    });
    configEventBus.emitChange(makeEvent(['FEISHU_APP_ID']));
    configEventBus.emitChange(makeEvent(['FEISHU_APP_SECRET']));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(called, 1);
  });

  it('triggers restart on file-scope event (conservative)', async () => {
    let called = 0;
    unsub = createConnectorReloadSubscriber({
      onRestart: async () => {
        called++;
      },
      debounceMs: 0,
      log: silentLog,
    });
    configEventBus.emitChange(makeEvent([], 'env', 'file'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, 1);
  });

  it('unsubscribe stops listening', async () => {
    let called = 0;
    unsub = createConnectorReloadSubscriber({
      onRestart: async () => {
        called++;
      },
      debounceMs: 0,
      log: silentLog,
    });
    unsub.unsubscribe();
    configEventBus.emitChange(makeEvent(['TELEGRAM_BOT_TOKEN']));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, 0);
  });

  it('logs error from onRestart without propagating', async () => {
    const warnings = [];
    unsub = createConnectorReloadSubscriber({
      onRestart: async () => {
        throw new Error('restart boom');
      },
      debounceMs: 0,
      log: {
        info() {},
        warn(...args) {
          warnings.push(args);
        },
        error() {},
      },
    });
    configEventBus.emitChange(makeEvent(['DINGTALK_APP_KEY']));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(warnings.length > 0, 'warning was logged');
  });
});
