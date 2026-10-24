import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopWindowObserver } from '../src/domains/plugin/desktop-window-runtime/observer.ts';

function observer(poll, freshnessMs = 300) {
  return new DesktopWindowObserver({
    id: 'fixture',
    window: { poll },
    lease: 'lease',
    connection: { renewRuntimeLease: async () => {} },
    features: {
      run: async (_lease, operation) => operation({ contributionIds: ['window'] }),
    },
    freshnessMs,
    now: Date.now,
    isCurrent: () => true,
  });
}

test('a later successful observation cannot outrun an already pending poll timeout', async () => {
  let polls = 0;
  const probe = observer(() => (++polls === 1 ? new Promise(() => {}) : Promise.resolve('visible')));
  const first = probe.observe();
  const second = probe.observe();
  assert.equal(polls, 0, 'poll starts on the next microtask');
  await Promise.resolve();
  assert.equal(polls, 1, 'only one child control poll may be in flight');
  await assert.rejects(first, /desktop heartbeat expired/);
  await assert.rejects(second, /desktop heartbeat expired/);
  assert.equal(probe.observation, undefined);
  assert.equal(probe.diagnostic()?.pending, true);
});

test('a failing first poll cannot bind its cause to a later pending poll', async () => {
  let rejectFirst;
  let polls = 0;
  const probe = observer(() =>
    ++polls === 1
      ? new Promise((_resolve, reject) => {
          rejectFirst = reject;
        })
      : new Promise(() => {}),
  );
  const first = probe.observe();
  const second = probe.observe();
  await Promise.resolve();
  assert.equal(polls, 1);
  rejectFirst(new Error('first control poll failed'));
  await assert.rejects(first, /first control poll failed/);
  await assert.rejects(second, /first control poll failed/);
  assert.equal(polls, 1);
  assert.equal(probe.diagnostic()?.pending, false);
});

test('show waits for the current poll and then checks the post-show state', async () => {
  let releaseFirst;
  let polls = 0;
  const probe = observer(() =>
    ++polls === 1
      ? new Promise((resolve) => {
          releaseFirst = resolve;
        })
      : Promise.resolve('visible'),
  );
  const first = probe.observe();
  const afterShow = probe.observeAfterShow();
  await Promise.resolve();
  assert.equal(polls, 1);
  releaseFirst('hidden');
  await first;
  await afterShow;
  assert.equal(polls, 2);
  assert.equal(probe.observation?.state, 'visible');
});

test('a successful child poll renews its still-live lease before package integrity work', async () => {
  const order = [];
  const probe = new DesktopWindowObserver({
    id: 'fixture',
    window: { poll: async () => 'visible' },
    lease: 'lease',
    connection: {
      renewRuntimeLease: async () => {
        order.push('renew');
      },
    },
    features: {
      run: async (_lease, operation) => {
        order.push('integrity');
        await operation({ contributionIds: ['window'] });
      },
    },
    freshnessMs: 300,
    now: Date.now,
    isCurrent: () => true,
  });
  await probe.observe();
  assert.deepEqual(order, ['renew', 'integrity']);
});

test('lease renewal denial publishes no fresh observation and never invokes old feature authority', async () => {
  let effects = 0;
  const probe = new DesktopWindowObserver({
    id: 'fixture',
    window: { poll: async () => 'visible' },
    lease: 'expired',
    connection: {
      renewRuntimeLease: async () => {
        throw new Error('runtime lease expired');
      },
    },
    features: {
      run: async (_lease, operation) => {
        effects++;
        await operation({ contributionIds: ['window'] });
      },
    },
    freshnessMs: 300,
    now: Date.now,
    isCurrent: () => true,
  });
  await assert.rejects(probe.observe(), /runtime lease expired/);
  assert.equal(effects, 0);
  assert.equal(probe.observation, undefined);
  assert.equal(probe.diagnostic()?.phase, 'lease-renew');
});

test('failure evidence omits open text and unknown codes even from cyclic error causes', async () => {
  const secret = 'TEST_SECRET_TOKEN';
  const error = Object.assign(new Error(`owner-content ${secret}`), { code: 'ESECRET_TOKEN' });
  error.name = `${secret}Error`;
  error.cause = error;
  const probe = observer(async () => {
    throw error;
  });
  await assert.rejects(probe.observe(), (thrown) => thrown === error);
  const diagnostic = probe.diagnostic(error);
  assert.equal(diagnostic.error.origin, 'unverified');
  assert.equal(diagnostic.error.code, undefined);
  assert.equal(diagnostic.error.type, undefined);
  const encoded = JSON.stringify(diagnostic);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes('owner-content'), false);
  assert.ok(encoded.length < 1_024);
});

test('unreadable exception properties cannot replace the original poll failure or block diagnostics', async () => {
  const error = new Error();
  for (const property of ['message', 'code', 'cause', 'stack']) {
    Object.defineProperty(error, property, {
      get: () => {
        throw new Error('private getter');
      },
    });
  }
  const probe = observer(async () => {
    throw error;
  });
  await assert.rejects(probe.observe(), (thrown) => thrown === error);
  assert.equal(probe.diagnostic(error).stages[0].status, 'failed');
  assert.equal(JSON.stringify(probe.diagnostic(error)).includes('private getter'), false);
});
