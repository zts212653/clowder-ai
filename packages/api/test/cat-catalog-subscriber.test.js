import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

const { configEventBus, createChangeSetId } = await import('../dist/config/config-event-bus.js');
const { createCatCatalogSubscriber } = await import('../dist/config/cat-catalog-subscriber.js');

describe('CatCatalogSubscriber', () => {
  /** @type {Array<() => void>} */
  const cleanups = [];
  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  it('emitChangeAsync awaits subscriber before resolving (P1-1: consistency)', async () => {
    let reconciled = false;
    const onReconcile = mock.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      reconciled = true;
    });
    const sub = createCatCatalogSubscriber({
      onReconcile,
      log: { info() {}, warn() {} },
    });
    cleanups.push(() => sub.unsubscribe());

    await configEventBus.emitChangeAsync({
      source: 'cat-config',
      scope: 'domain',
      changedKeys: ['test-cat'],
      changeSetId: createChangeSetId(),
      timestamp: Date.now(),
    });

    // After emitChangeAsync resolves, reconcile MUST be complete
    assert.equal(reconciled, true);
    assert.equal(onReconcile.mock.callCount(), 1);
  });

  it('calls onReconcile when a cat-config event is emitted', async () => {
    const onReconcile = mock.fn(async () => {});
    const sub = createCatCatalogSubscriber({
      onReconcile,
      log: { info() {}, warn() {} },
    });
    cleanups.push(() => sub.unsubscribe());

    configEventBus.emitChange({
      source: 'cat-config',
      scope: 'domain',
      changedKeys: ['test-cat'],
      changeSetId: createChangeSetId(),
      timestamp: Date.now(),
    });

    // onReconcile is async fire-and-forget; give microtask time
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(onReconcile.mock.callCount(), 1);
  });

  it('ignores non-cat-config events (env, secrets, config-store)', () => {
    const onReconcile = mock.fn(async () => {});
    const sub = createCatCatalogSubscriber({
      onReconcile,
      log: { info() {}, warn() {} },
    });
    cleanups.push(() => sub.unsubscribe());

    for (const source of /** @type {const} */ (['env', 'secrets', 'config-store'])) {
      configEventBus.emitChange({
        source,
        scope: 'key',
        changedKeys: ['SOME_VAR'],
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });
    }
    assert.equal(onReconcile.mock.callCount(), 0);
  });

  it('unsubscribe stops listening', () => {
    const onReconcile = mock.fn(async () => {});
    const sub = createCatCatalogSubscriber({
      onReconcile,
      log: { info() {}, warn() {} },
    });
    sub.unsubscribe();

    configEventBus.emitChange({
      source: 'cat-config',
      scope: 'domain',
      changedKeys: ['test-cat'],
      changeSetId: createChangeSetId(),
      timestamp: Date.now(),
    });
    assert.equal(onReconcile.mock.callCount(), 0);
  });

  it('serializes concurrent reconciles (P1-2: no stale overwrite)', async () => {
    const order = [];
    let callCount = 0;
    const onReconcile = mock.fn(async () => {
      const myCall = ++callCount;
      order.push(`start-${myCall}`);
      // Simulate async work (e.g. A2A dynamic import)
      await new Promise((r) => setTimeout(r, myCall === 1 ? 80 : 20));
      order.push(`end-${myCall}`);
    });
    const sub = createCatCatalogSubscriber({
      onReconcile,
      log: { info() {}, warn() {} },
    });
    cleanups.push(() => sub.unsubscribe());

    // Fire two events rapidly
    configEventBus.emitChange({
      source: 'cat-config',
      scope: 'domain',
      changedKeys: ['cat-a'],
      changeSetId: createChangeSetId(),
      timestamp: Date.now(),
    });
    configEventBus.emitChange({
      source: 'cat-config',
      scope: 'domain',
      changedKeys: ['cat-b'],
      changeSetId: createChangeSetId(),
      timestamp: Date.now(),
    });

    // Wait for both to complete
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(onReconcile.mock.callCount(), 2);
    // Serialized: second must start AFTER first ends
    assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('logs warning when onReconcile throws', async () => {
    const warnFn = mock.fn();
    const sub = createCatCatalogSubscriber({
      onReconcile: async () => {
        throw new Error('boom');
      },
      log: { info() {}, warn: warnFn },
    });
    cleanups.push(() => sub.unsubscribe());

    configEventBus.emitChange({
      source: 'cat-config',
      scope: 'domain',
      changedKeys: ['test-cat'],
      changeSetId: createChangeSetId(),
      timestamp: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(warnFn.mock.callCount(), 1);
  });
});
