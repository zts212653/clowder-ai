import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { configStore } from '../dist/config/ConfigStore.js';
import { configEventBus } from '../dist/config/config-event-bus.js';
import { configRoutes } from '../dist/routes/config.js';

describe('ConfigEventBus', () => {
  beforeEach(() => {
    configEventBus.removeAllListeners();
  });

  describe('emitChange + onConfigChange', () => {
    it('delivers event to listeners', () => {
      const received = [];
      configEventBus.onConfigChange((event) => received.push(event));

      configEventBus.emitChange({
        source: 'env',
        scope: 'key',
        changedKeys: ['TELEGRAM_BOT_TOKEN'],
        changeSetId: 'test-1',
        timestamp: Date.now(),
      });

      assert.equal(received.length, 1);
      assert.deepEqual(received[0].changedKeys, ['TELEGRAM_BOT_TOKEN']);
      assert.equal(received[0].source, 'env');
      assert.equal(received[0].scope, 'key');
    });

    it('returns unsubscribe function', () => {
      const received = [];
      const unsub = configEventBus.onConfigChange((event) => received.push(event));

      configEventBus.emitChange({
        source: 'env',
        scope: 'key',
        changedKeys: ['X'],
        changeSetId: 'test-2',
        timestamp: Date.now(),
      });
      assert.equal(received.length, 1);

      unsub();

      configEventBus.emitChange({
        source: 'env',
        scope: 'key',
        changedKeys: ['Y'],
        changeSetId: 'test-3',
        timestamp: Date.now(),
      });
      assert.equal(received.length, 1, 'should not receive after unsub');
    });
  });

  describe('onKeysChange', () => {
    it('only fires when matching keys change', () => {
      const received = [];
      configEventBus.onKeysChange(['FEISHU_APP_ID', 'FEISHU_APP_SECRET'], (event) => received.push(event));

      // Non-matching key — should NOT fire
      configEventBus.emitChange({
        source: 'env',
        scope: 'key',
        changedKeys: ['TELEGRAM_BOT_TOKEN'],
        changeSetId: 'test-4',
        timestamp: Date.now(),
      });
      assert.equal(received.length, 0, 'should not fire for non-matching key');

      // Matching key — should fire
      configEventBus.emitChange({
        source: 'env',
        scope: 'key',
        changedKeys: ['FEISHU_APP_ID'],
        changeSetId: 'test-5',
        timestamp: Date.now(),
      });
      assert.equal(received.length, 1, 'should fire for matching key');
    });

    it('fires on file-scope events (degraded, cannot filter by key)', () => {
      const received = [];
      configEventBus.onKeysChange(['ANYTHING'], (event) => received.push(event));

      configEventBus.emitChange({
        source: 'env',
        scope: 'file',
        changedKeys: [],
        changeSetId: 'test-6',
        timestamp: Date.now(),
      });

      assert.equal(received.length, 1, 'file-scope should always fire (degraded)');
    });

    it('returns unsubscribe function', () => {
      const received = [];
      const unsub = configEventBus.onKeysChange(['FOO'], (event) => received.push(event));

      configEventBus.emitChange({
        source: 'env',
        scope: 'key',
        changedKeys: ['FOO'],
        changeSetId: 'test-7',
        timestamp: Date.now(),
      });
      assert.equal(received.length, 1);

      unsub();

      configEventBus.emitChange({
        source: 'env',
        scope: 'key',
        changedKeys: ['FOO'],
        changeSetId: 'test-8',
        timestamp: Date.now(),
      });
      assert.equal(received.length, 1, 'should not receive after unsub');
    });
  });

  describe('emitChange exception isolation', () => {
    it('does not throw when a listener throws', () => {
      configEventBus.onConfigChange(() => {
        throw new Error('listener boom');
      });

      // emitChange must not propagate the listener exception
      assert.doesNotThrow(() => {
        configEventBus.emitChange({
          source: 'env',
          scope: 'key',
          changedKeys: ['X'],
          changeSetId: 'test-throw-1',
          timestamp: Date.now(),
        });
      });
    });

    it('still delivers to other listeners after one throws', () => {
      const received = [];
      configEventBus.onConfigChange(() => {
        throw new Error('first listener boom');
      });
      configEventBus.onConfigChange((e) => received.push(e));

      configEventBus.emitChange({
        source: 'env',
        scope: 'key',
        changedKeys: ['Y'],
        changeSetId: 'test-throw-2',
        timestamp: Date.now(),
      });

      assert.equal(received.length, 1, 'second listener should still receive');
    });
  });

  describe('PATCH /api/config/env integration', () => {
    let app;

    afterEach(async () => {
      if (app) await app.close();
    });

    it('emits config:change with source=env after successful PATCH', async () => {
      const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-event-bus-'));
      const envFilePath = resolve(tempRoot, '.env');
      writeFileSync(envFilePath, 'PREVIEW_GATEWAY_PORT=4100\n', 'utf8');

      app = Fastify();
      await app.register(configRoutes, { projectRoot: tempRoot, envFilePath });
      await app.ready();

      const received = [];
      const unsub = configEventBus.onConfigChange((e) => received.push(e));

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'test-user' },
        payload: {
          updates: [{ name: 'PREVIEW_GATEWAY_PORT', value: '4200' }],
        },
      });

      unsub();

      assert.equal(res.statusCode, 200);
      assert.equal(received.length, 1);
      assert.equal(received[0].source, 'env');
      assert.equal(received[0].scope, 'key');
      assert.deepEqual(received[0].changedKeys, ['PREVIEW_GATEWAY_PORT']);
      assert.ok(received[0].changeSetId);
      assert.ok(received[0].timestamp);

      // Restore env
      delete process.env.PREVIEW_GATEWAY_PORT;
    });

    it('does not emit when patching the same value (no-op)', async () => {
      const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-event-bus-noop-'));
      const envFilePath = resolve(tempRoot, '.env');
      writeFileSync(envFilePath, 'PREVIEW_GATEWAY_PORT=4100\n', 'utf8');

      app = Fastify();
      await app.register(configRoutes, { projectRoot: tempRoot, envFilePath });
      await app.ready();

      // Set env to match file value
      process.env.PREVIEW_GATEWAY_PORT = '4100';

      const received = [];
      const unsub = configEventBus.onConfigChange((e) => received.push(e));

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config/env',
        headers: { 'x-cat-cafe-user': 'test-user' },
        payload: {
          updates: [{ name: 'PREVIEW_GATEWAY_PORT', value: '4100' }],
        },
      });

      unsub();

      assert.equal(res.statusCode, 200);
      assert.equal(received.length, 0, 'no-op PATCH should not emit');

      delete process.env.PREVIEW_GATEWAY_PORT;
    });
  });

  describe('ConfigStore.set() integration', () => {
    afterEach(() => {
      configStore.reset();
    });

    it('emits config:change with source=config-store', () => {
      const received = [];
      const unsub = configEventBus.onConfigChange((e) => received.push(e));

      configStore.set('cli.timeoutMs', 600000);

      unsub();

      assert.equal(received.length, 1);
      assert.equal(received[0].source, 'config-store');
      assert.equal(received[0].scope, 'key');
      assert.deepEqual(received[0].changedKeys, ['CLI_TIMEOUT_MS']);
      assert.ok(received[0].changeSetId);
    });

    it('does not emit when setting the same value (no-op)', () => {
      configStore.set('cli.timeoutMs', 300000);

      const received = [];
      const unsub = configEventBus.onConfigChange((e) => received.push(e));

      // Set same value again
      configStore.set('cli.timeoutMs', 300000);

      unsub();

      assert.equal(received.length, 0, 'no-op should not emit');
    });
  });

  describe('createChangeSetId', () => {
    it('returns a UUID string', async () => {
      const { createChangeSetId } = await import('../dist/config/config-event-bus.js');
      const id = createChangeSetId();
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('returns unique values', async () => {
      const { createChangeSetId } = await import('../dist/config/config-event-bus.js');
      const a = createChangeSetId();
      const b = createChangeSetId();
      assert.notEqual(a, b);
    });
  });
});
