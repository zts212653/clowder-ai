import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';

describe('AccountBindingSubscriber — F136 Phase 4c', () => {
  let configEventBus;
  let createAccountBindingSubscriber;

  before(async () => {
    ({ configEventBus } = await import('../dist/config/config-event-bus.js'));
    ({ createAccountBindingSubscriber } = await import('../dist/config/account-binding-subscriber.js'));
  });

  it('calls onRebind when accounts event fires', async () => {
    const rebindFn = mock.fn(async () => {});
    const log = { info: mock.fn(), warn: mock.fn() };
    const handle = createAccountBindingSubscriber({ onRebind: rebindFn, log });

    await configEventBus.emitChangeAsync({
      source: 'accounts',
      scope: 'key',
      changedKeys: ['my-glm'],
      changeSetId: 'test-1',
      timestamp: Date.now(),
    });

    assert.equal(rebindFn.mock.callCount(), 1);
    handle.unsubscribe();
  });

  it('ignores non-accounts events', async () => {
    const rebindFn = mock.fn(async () => {});
    const log = { info: mock.fn(), warn: mock.fn() };
    const handle = createAccountBindingSubscriber({ onRebind: rebindFn, log });

    await configEventBus.emitChangeAsync({
      source: 'cat-config',
      scope: 'domain',
      changedKeys: ['opus'],
      changeSetId: 'test-2',
      timestamp: Date.now(),
    });

    await configEventBus.emitChangeAsync({
      source: 'env',
      scope: 'key',
      changedKeys: ['SOME_VAR'],
      changeSetId: 'test-3',
      timestamp: Date.now(),
    });

    assert.equal(rebindFn.mock.callCount(), 0);
    handle.unsubscribe();
  });

  it('serializes concurrent rebind calls via promise chain', async () => {
    const order = [];
    let callNum = 0;
    let resolveFirst;
    const firstPromise = new Promise((r) => {
      resolveFirst = r;
    });

    const rebindFn = mock.fn(async () => {
      callNum++;
      if (callNum === 1) {
        order.push('first-start');
        await firstPromise;
        order.push('first-end');
      } else {
        order.push('second-start');
        order.push('second-end');
      }
    });

    const log = { info: mock.fn(), warn: mock.fn() };
    const handle = createAccountBindingSubscriber({ onRebind: rebindFn, log });

    const event = {
      source: 'accounts',
      scope: 'key',
      changedKeys: ['claude'],
      changeSetId: 'test-4',
      timestamp: Date.now(),
    };

    // Fire two events without awaiting — both should chain
    const p1 = configEventBus.emitChangeAsync(event);
    const p2 = configEventBus.emitChangeAsync({ ...event, changeSetId: 'test-5' });

    // Resolve the first to let the chain continue
    resolveFirst();
    await Promise.all([p1, p2]);

    assert.equal(rebindFn.mock.callCount(), 2);
    // Second must start AFTER first ends (serialized)
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
    handle.unsubscribe();
  });

  it('logs warning on rebind failure without crashing', async () => {
    const rebindFn = mock.fn(async () => {
      throw new Error('rebind boom');
    });
    const log = { info: mock.fn(), warn: mock.fn() };
    const handle = createAccountBindingSubscriber({ onRebind: rebindFn, log });

    await configEventBus.emitChangeAsync({
      source: 'accounts',
      scope: 'key',
      changedKeys: ['bad-account'],
      changeSetId: 'test-6',
      timestamp: Date.now(),
    });

    assert.equal(rebindFn.mock.callCount(), 1);
    assert.equal(log.warn.mock.callCount(), 1);
    handle.unsubscribe();
  });

  it('passes changedKeys to onRebind callback', async () => {
    const rebindFn = mock.fn(async (_keys) => {});
    const log = { info: mock.fn(), warn: mock.fn() };
    const handle = createAccountBindingSubscriber({ onRebind: rebindFn, log });

    await configEventBus.emitChangeAsync({
      source: 'accounts',
      scope: 'key',
      changedKeys: ['claude', 'codex'],
      changeSetId: 'test-7',
      timestamp: Date.now(),
    });

    assert.equal(rebindFn.mock.callCount(), 1);
    assert.deepEqual(rebindFn.mock.calls[0].arguments[0], ['claude', 'codex']);
    handle.unsubscribe();
  });
});
