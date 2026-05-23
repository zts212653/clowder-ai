import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';

export function createMockProcess(exitCode = 0) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit') {
      process.nextTick(() => originalEmit('close', ...args));
    }
    return emitted;
  };
  const proc = {
    stdout,
    stderr,
    pid: 98765,
    kill: mock.fn(() => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', exitCode, null);
      });
      return true;
    }),
    on: (event, listener) => {
      emitter.on(event, listener);
      return proc;
    },
    once: (event, listener) => {
      emitter.once(event, listener);
      return proc;
    },
    _emitter: emitter,
  };
  return proc;
}

export function emitDareEvents(proc, events, exitCode = 0) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.end();
  process.nextTick(() => proc._emitter.emit('exit', exitCode, null));
}

export async function collect(iterable) {
  const messages = [];
  for await (const item of iterable) messages.push(item);
  return messages;
}

export function envelope(event, data, seq = 1) {
  return {
    schema_version: 'client-headless-event-envelope.v1',
    ts: 1709500000 + seq,
    session_id: 'sess-l1',
    run_id: 'run-l1',
    seq,
    event,
    data,
  };
}
