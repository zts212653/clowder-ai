import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, deferred, fixture, liveFixture, options, turn } from './fake-session-provider.js';

const dispatchOptions = { expectedInvocationId: 'inv', force: false };
const supplement = { text: 'supplement', imagePaths: ['/image.png'], messageIds: ['message'], deliveryId: 'delivery' };
const rows = [
  [{ status: 'accepted' }, { accepted: true }],
  [{ status: 'turn_ended' }, { accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' }],
  [
    { status: 'rejected', reason: 'invalid_input' },
    { accepted: false, reason: 'invalid_input', acceptance: 'not_accepted' },
  ],
  [
    { status: 'rejected', reason: 'provider_rejected' },
    { accepted: false, reason: 'provider_rejected', acceptance: 'not_accepted' },
  ],
  [{ status: 'unsupported' }, { accepted: false, reason: 'provider_rejected', acceptance: 'not_accepted' }],
  [{ status: 'unknown' }, { accepted: false, reason: 'exception', acceptance: 'unknown' }],
  [new Error('uncertain'), { accepted: false, reason: 'exception', acceptance: 'unknown' }],
];
for (const [result, expected] of rows)
  test(`dispatcher maps ${JSON.stringify(result)}`, async () => {
    const f = await liveFixture();
    if (result instanceof Error) f.provider.inputError = result;
    else f.provider.inputResult = result;
    assert.deepEqual(await f.dispatcher.dispatch(supplement, dispatchOptions), {
      ...expected,
      ...(expected.accepted ? { handle: f.dispatcher.handle } : {}),
    });
    assert.equal(f.dispatcher.invocationId, 'inv');
    assert.deepEqual(f.dispatcher.capabilities, { append: true, steer: false, inputReadReceipt: true });
    assert.deepEqual(f.provider.calls.input, [
      {
        id: 'host',
        expected: { invocationId: 'inv', nativeTurnId: 'native-turn' },
        message: { text: 'supplement', images: ['/image.png'], messageIds: ['message'], deliveryId: 'delivery' },
      },
    ]);
    await f.finish();
    assert.equal(f.releases, 1);
    assert.deepEqual(await f.dispatcher.dispatch(supplement, dispatchOptions), {
      accepted: false,
      reason: 'active_run_closed',
      acceptance: 'not_accepted',
    });
    assert.equal(f.provider.calls.input.length, 1);
  });

test('deliveryId reaches input, inspect and read receipt unchanged; unknown is not retried', async () => {
  const f = await liveFixture();
  f.provider.inputResult = { status: 'unknown' };
  let reads = 0;
  await f.dispatcher.dispatch(
    {
      ...supplement,
      onInputRead: async () => {
        reads++;
      },
    },
    dispatchOptions,
  );
  assert.equal(await f.dispatcher.inspectInput('delivery'), 'accepted');
  assert.deepEqual(f.provider.calls.inspect, [
    { id: 'host', expected: { invocationId: 'inv', nativeTurnId: 'native-turn' }, deliveryId: 'delivery' },
  ]);
  f.provider.inbox.push(turn('input_read', { deliveryId: 'delivery' }));
  f.provider.inbox.push(turn('input_read', { deliveryId: 'delivery' }));
  f.provider.inbox.push(turn('status', { phase: 'receipt-consumed' }));
  assert.equal((await f.iterator.next()).value.content, 'receipt-consumed');
  assert.equal(reads, 1);
  assert.equal(f.provider.calls.input.length, 1);
  await f.finish();
  assert.equal(await f.dispatcher.inspectInput('delivery'), 'unknown');
  assert.equal(f.provider.calls.inspect.length, 1);
});

test('missing deliveryId gets a UUID; mismatch and force never reach provider', async () => {
  const f = await liveFixture();
  await f.dispatcher.dispatch({ text: 'x', messageIds: [] }, dispatchOptions);
  assert.match(
    f.provider.calls.input[0].message.deliveryId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.deepEqual(await f.dispatcher.dispatch(supplement, { ...dispatchOptions, expectedInvocationId: 'other' }), {
    accepted: false,
    reason: 'active_run_mismatch',
    acceptance: 'not_accepted',
  });
  assert.deepEqual(await f.dispatcher.dispatch(supplement, { ...dispatchOptions, force: true }), {
    accepted: false,
    reason: 'provider_rejected',
    acceptance: 'not_accepted',
  });
  assert.equal(f.provider.calls.input.length, 1);
  await f.finish();
});

for (const bound of [true, false])
  test(`fixed handle and optional inspect (bound=${bound})`, async () => {
    const f = await liveFixture({}, {}, (provider) => {
      provider.binding = bound ? { state: 'bound', nativeSessionId: 'native' } : { state: 'pending_first_input' };
      provider.omitNativeTurn = !bound;
      provider.inspectInput = undefined;
      provider.support.inputReadReceipt = 'unsupported';
    });
    assert.deepEqual(f.dispatcher.handle, {
      provider: 'other',
      carrier: 'other',
      threadId: bound ? 'native' : 'host',
      turnId: bound ? 'native-turn' : 'inv',
    });
    assert.equal(f.dispatcher.capabilities.inputReadReceipt, false);
    assert.equal(f.dispatcher.inspectInput, undefined);
    await f.finish();
  });

test('unsupported input never registers; no registration also works on supported input', async () => {
  const { provider, bridge } = fixture();
  const opts = options({
    activeRunDispatch: { invocationId: 'inv', register: () => assert.fail('registered unsupported input') },
  });
  await collect(bridge.invoke('x', opts));
  provider.support.input = 'supported';
  await collect(bridge.invoke('x', options()));
  assert.equal(provider.calls.input.length, 0);
});

test('abort cancels once, discards late output/done and releases once', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const f = await liveFixture({ signal: controller.signal });
  const waiting = f.iterator.next();
  controller.abort();
  f.provider.inbox.push(turn('output', { text: 'late', textMode: 'append' }));
  f.provider.inbox.push(turn('done', { outcome: 'completed' }));
  const done = await waiting;
  assert.equal(done.value.type, 'done');
  assert.equal(done.value.errorCode, 'cancelled');
  assert.equal((await f.iterator.next()).done, true);
  assert.deepEqual(f.provider.calls.cancel, [
    { id: 'host', expected: { invocationId: 'inv', nativeTurnId: 'native-turn' }, reason: 'abort' },
  ]);
  assert.equal(f.releases, 1);
  await f.dispatcher.dispatch(supplement, dispatchOptions);
  assert.equal(f.provider.calls.input.length, 0);
});

test('abort while start awaits settle cancels returned turn and discards its events', async () => {
  const { bridge, provider } = fixture();
  provider.support.continuityEvidence = 'pre_send';
  const controller = new AbortController();
  const messages = await collect(
    bridge.invokeWithContinuityPreflight(
      {
        settle: async () => {
          controller.abort();
          return { prompt: 'x', promptGenerationId: 'g' };
        },
      },
      options({ signal: controller.signal }),
    ),
  );
  assert.deepEqual(
    messages.map((m) => [m.type, m.errorCode]),
    [['done', 'cancelled']],
  );
  assert.equal(provider.calls.cancel.length, 1);
  assert.deepEqual(provider.bytes, []);
});

test('iterator failure releases dispatcher without releasing session', async () => {
  const f = await liveFixture();
  f.provider.inbox.next = async () => {
    throw new Error('stream broke');
  };
  const messages = await collect(f.iterator);
  assert.deepEqual(
    messages.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(f.releases, 1);
  assert.equal(f.provider.calls.cancel.length, 0);
  assert.equal(f.provider.calls.release.length, 0);
});

test('consumer closes iterator early: releases dispatcher; retained handle cannot dispatch', async () => {
  const f = await liveFixture();
  await f.iterator.return();
  assert.equal(f.releases, 1);
  assert.equal((await f.dispatcher.dispatch(supplement, dispatchOptions)).reason, 'active_run_closed');
  assert.equal(f.provider.calls.input.length, 0);
});

test('slow input-read receipt cannot block output or Stop; late rejection only warns', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const f = await liveFixture({ signal: controller.signal });
  const pending = deferred();
  let reads = 0;
  await f.dispatcher.dispatch(
    {
      ...supplement,
      onInputRead: () => {
        reads++;
        return pending.promise;
      },
    },
    dispatchOptions,
  );
  f.provider.inbox.push(turn('input_read', { deliveryId: 'delivery' }));
  f.provider.inbox.push(turn('status', { phase: 'still-streaming' }));
  assert.equal((await f.iterator.next()).value.content, 'still-streaming');
  assert.equal(reads, 1);
  const next = f.iterator.next();
  controller.abort();
  assert.equal((await next).value.errorCode, 'cancelled');
  assert.equal((await f.iterator.next()).done, true);
  pending.reject(new Error('late receipt persistence failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.warnings.length, 1);
  assert.equal(f.releases, 1);
});

test('synchronous input-read callback failure cannot fail a successful turn', async () => {
  const f = await liveFixture();
  await f.dispatcher.dispatch(
    {
      ...supplement,
      onInputRead: () => {
        throw new Error('receipt failure');
      },
    },
    dispatchOptions,
  );
  f.provider.inbox.push(turn('input_read', { deliveryId: 'delivery' }));
  const messages = await f.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    messages.map((m) => [m.type, m.errorCode]),
    [['done', undefined]],
  );
  assert.equal(f.warnings.length, 1);
});
