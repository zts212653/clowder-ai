import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { observeMessageSend } from '../dist/routes/message-send-diagnostics.js';

const response = () => Object.assign(new EventEmitter(), { writableFinished: false });

test('fast send observation preserves the original result without emitting diagnostic lines', async () => {
  const entries = [];
  const value = { body: 'private-body-canary' };
  assert.equal(
    await observeMessageSend({ info: (row) => entries.push(row) }, response(), async (trace) =>
      trace.measure('receipt', () => value),
    ),
    value,
  );
  assert.deepEqual(entries, []);
});

test('a slow admitted send joins its committed source and named phase without retaining content', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const entries = [];
  const raw = response();
  const value = { content: 'private-body-canary', userId: 'private-owner-canary' };
  const result = await observeMessageSend({ info: (row) => entries.push(row) }, raw, async (trace) => {
    trace.committed('committed-source-id');
    return trace.measure('projectImport', async () => {
      clock += 1500;
      return value;
    });
  });
  assert.equal(result, value);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'handler_settled');
  assert.equal(entries[0].outcome, 'resolved');
  assert.equal(entries[0].committedSourceMessageId, 'committed-source-id');
  assert.equal(entries[0].phases.projectImport, 1500);
  assert.doesNotMatch(JSON.stringify(entries), /private-body-canary|private-owner-canary/);
  assert.equal(raw.listenerCount('close'), 0);
});

test('client close captures an in-flight post-commit phase and later settlement is bounded to two lines', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const entries = [];
  const raw = response();
  const result = { accepted: true };
  const pending = observeMessageSend({ info: (row) => entries.push(row) }, raw, async (trace) => {
    trace.committed('committed-before-disconnect');
    return trace.measure('holds', async () => {
      entered.resolve();
      await release.promise;
      return result;
    });
  });
  try {
    await entered.promise;
    clock += 1200;
    raw.emit('close');
    raw.emit('close');
    assert.equal(entries.length, 1, 'the actual client-close boundary must be visible before a stalled await settles');
    assert.equal(entries[0].event, 'client_closed');
    assert.equal(entries[0].activePhase, 'holds');
    assert.equal(entries[0].committedSourceMessageId, 'committed-before-disconnect');
  } finally {
    release.resolve();
    await pending;
  }
  assert.equal(await pending, result, 'disconnect observation cannot cancel or relabel durable acceptance');
  assert.equal(entries.length, 2);
  assert.equal(entries[1].event, 'handler_settled');
  assert.equal(raw.listenerCount('close'), 0);
});

test('diagnostic failures preserve the exact send error and remove the disconnect listener', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const raw = response();
  const exact = new Error('private-error-canary');
  await assert.rejects(
    observeMessageSend(
      {
        info() {
          throw new Error('logger unavailable');
        },
      },
      raw,
      async (trace) =>
        trace.measure('draft', () => {
          clock += 1200;
          throw exact;
        }),
    ),
    (error) => error === exact,
  );
  assert.equal(raw.listenerCount('close'), 0);
});
