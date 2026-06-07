// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ScheduleFactoryRegistry } from '../dist/domains/plugin/ScheduleFactoryRegistry.js';

/** @returns {import('../src/domains/plugin/ScheduleFactoryRegistry.js').ScheduleFactory} */
function makeFactory(factoryId, pluginId = 'github') {
  return {
    pluginId,
    factoryId,
    createTaskSpec(instanceId, _deps) {
      return /** @type {any} */ ({
        id: instanceId,
        profile: 'poller',
        trigger: { type: 'interval', ms: 60_000 },
        admission: { gate: async () => ({ run: false, reason: 'stub' }) },
        run: { overlap: 'skip', timeoutMs: 30_000, execute: async () => {} },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
      });
    },
  };
}

describe('ScheduleFactoryRegistry', () => {
  it('registers and retrieves a factory by factoryId', () => {
    const registry = new ScheduleFactoryRegistry();
    const factory = makeFactory('github.cicd-check');
    registry.register(factory);
    assert.strictEqual(registry.get('github.cicd-check'), factory);
  });

  it('retrieves a factory only for its owning plugin', () => {
    const registry = new ScheduleFactoryRegistry();
    const factory = makeFactory('github.review-feedback', 'github');
    registry.register(factory);

    assert.strictEqual(registry.getForPlugin('github.review-feedback', 'github'), factory);
    assert.strictEqual(registry.getForPlugin('github.review-feedback', 'other-plugin'), null);
  });

  it('returns null for unknown factoryId', () => {
    const registry = new ScheduleFactoryRegistry();
    assert.strictEqual(registry.get('nonexistent'), null);
  });

  it('has() returns true for registered, false for unknown', () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeFactory('github.review'));
    assert.strictEqual(registry.has('github.review'), true);
    assert.strictEqual(registry.has('unknown'), false);
  });

  it('rejects duplicate factoryId registration', () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeFactory('github.cicd-check'));
    assert.throws(() => registry.register(makeFactory('github.cicd-check')), /already registered/);
  });

  it('rejects factories without an owning pluginId', () => {
    const registry = new ScheduleFactoryRegistry();
    assert.throws(
      () => registry.register(/** @type {any} */ ({ factoryId: 'github.review-feedback', createTaskSpec: () => ({}) })),
      /pluginId/,
    );
  });

  it('factory createTaskSpec returns a valid TaskSpec-shaped object', () => {
    const registry = new ScheduleFactoryRegistry();
    const factory = makeFactory('github.poller');
    registry.register(factory);

    const retrieved = registry.get('github.poller');
    assert.ok(retrieved);
    const deps = { log: { info: () => {}, error: () => {} } };
    const taskSpec = retrieved.createTaskSpec('plugin-github-poller', deps);
    assert.strictEqual(taskSpec.id, 'plugin-github-poller');
    assert.strictEqual(taskSpec.profile, 'poller');
    assert.deepStrictEqual(taskSpec.trigger, { type: 'interval', ms: 60_000 });
  });

  it('supports multiple distinct factories', () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeFactory('github.cicd'));
    registry.register(makeFactory('github.review'));
    registry.register(makeFactory('github.conflict'));

    assert.ok(registry.has('github.cicd'));
    assert.ok(registry.has('github.review'));
    assert.ok(registry.has('github.conflict'));
    assert.strictEqual(registry.get('github.cicd')?.factoryId, 'github.cicd');
    assert.strictEqual(registry.get('github.review')?.factoryId, 'github.review');
  });
});
