import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { DshTurnInput } from '../../dist/domains/cats/services/agents/providers/acp/dsh/dsh-turn-input.js';

for (const completed of [true, false]) {
  test(`pending read persistence cannot block ${completed ? 'completed' : 'cancelled'} DSH cleanup`, async () => {
    const listeners = new Set();
    const completions = [];
    let dispatcher;
    let releaseRead;
    let observerStarted = false;
    let releases = 0;
    const blockedRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const turn = new DshTurnInput(
      {
        onTurnBridgeEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async steerTurn() {
          return { accepted: true, nativeTurnId: 1, deliveryId: 'delivery' };
        },
        async inspectTurnInput() {
          return { state: 'read', nativeTurnId: 1 };
        },
      },
      'session',
      {
        activeRunDispatch: {
          invocationId: 'invocation',
          register(value) {
            dispatcher = value;
            return () => {
              releases++;
            };
          },
        },
      },
    );
    const notify = (type, fields = {}) => {
      for (const listener of listeners) listener({ sessionId: 'session', nativeTurnId: 1, type, ...fields });
    };
    notify('turn_started');
    await dispatcher.dispatch(
      {
        text: 'new input',
        messageIds: ['source'],
        deliveryId: 'delivery',
        async onInputRead() {
          observerStarted = true;
          await blockedRead;
        },
        async onInputCompleted(value) {
          completions.push(value);
        },
      },
      { expectedInvocationId: 'invocation', force: false },
    );
    notify('input_read', { deliveryId: 'delivery' });
    await setImmediate();
    assert.equal(observerStarted, true);
    if (completed) notify('turn_ended', { reason: 'completed' });
    const disposed = turn.dispose().then(() => 'closed');
    let timeout;
    try {
      assert.equal(
        await Promise.race([
          disposed,
          new Promise((resolve) => {
            timeout = setTimeout(() => resolve('blocked'), 500);
          }),
        ]),
        'closed',
        'provider cleanup must not wait for the read-receipt observer',
      );
      assert.deepEqual(completions, [completed]);
      assert.equal(releases, 1);
      assert.equal(listeners.size, 0);
    } finally {
      clearTimeout(timeout);
      releaseRead();
      await disposed;
    }
  });
}
