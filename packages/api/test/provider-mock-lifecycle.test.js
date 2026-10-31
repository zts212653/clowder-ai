import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { emitProcessExit, waitForMockProcessReady } from './helpers/mock-process-lifecycle.js';
import { createMockProcess, emitEvents } from './helpers/provider-archive-test-helpers.js';

test('provider fixture waits for a delayed consumer before writing output or exiting', async () => {
  const proc = createMockProcess();
  const events = [{ type: 'result', subtype: 'success' }];
  const emission = emitEvents(proc, events);

  // An event-loop turn alone is not readiness: launch preparation is still pending.
  await setImmediate();
  assert.equal(proc.stdout.writableEnded, false);
  assert.equal(proc.stdout.readableLength, 0);

  let output = '';
  const lifecycle = [];
  proc.stdout.on('data', (chunk) => {
    output += chunk;
  });
  proc.once('exit', (code, signal) => lifecycle.push(['exit', code, signal]));
  proc.once('close', (code, signal) => lifecycle.push(['close', code, signal]));
  proc.once('error', assert.fail);
  await emission;

  assert.equal(proc._emitter.listenerCount('newListener'), 0);
  assert.equal(output, `${JSON.stringify(events[0])}\n`);
  assert.deepEqual(lifecycle, [
    ['exit', 0, null],
    ['close', 0, null],
  ]);
});

test('provider fixture rejects absent consumers and removes its readiness listener', async () => {
  const proc = createMockProcess();
  await assert.rejects(waitForMockProcessReady(proc, { timeoutMs: 20 }), /consumer not ready.*exit, close, error/);
  assert.equal(proc._emitter.listenerCount('newListener'), 0);
});

test('provider fixture waits for close after exit and permits a consumed spawn-error listener', async () => {
  const emitter = new EventEmitter();
  const proc = { _emitter: emitter };
  emitter.once('exit', () => {});
  emitter.once('close', () => {});
  emitter.once('error', () => {});
  await waitForMockProcessReady(proc);
  emitter.emit('error', new Error('spawn ENOENT'));
  let settled = false;
  const completion = emitProcessExit(proc, null).then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(settled, false, 'exit alone cannot complete the fixture');
  emitter.emit('close', null, null);
  await completion;
  assert.equal(settled, true);
});

test('provider fixture rejects missing close within its deadline and removes its close listener', async () => {
  const emitter = new EventEmitter();
  const proc = { _emitter: emitter };
  emitter.once('exit', () => {});
  emitter.once('close', () => {});
  await assert.rejects(emitProcessExit(proc, 0, null, { timeoutMs: 20 }), /did not close within 20ms after exit/);
  assert.equal(emitter.listenerCount('close'), 1, 'only the consumer listener remains');
});
