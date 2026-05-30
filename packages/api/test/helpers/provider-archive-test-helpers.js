/**
 * #780: Shared test helpers for provider raw-archive integration tests.
 *
 * Extracted from provider-raw-archive.test.js to keep that file under the
 * 350-line hard cap (AGENTS.md 代码质量红线). Provides mock process / spawn /
 * archive-sink / L0-compiler builders shared by Claude / OpenCode / Kimi cases.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';

export async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

export function createMockProcess() {
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
    pid: 99999,
    exitCode: null,
    kill: mock.fn(() => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', null, 'SIGTERM');
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

export function createMockSpawnFn(proc) {
  return mock.fn(() => proc);
}

export function emitEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
}

export function createMockArchive() {
  return {
    append: mock.fn(async () => {}),
    getPath: (id) => `/tmp/test-archive/${id}.ndjson`,
  };
}

/** Fake L0 compiler for Claude (required since F203) */
export function buildFakeL0Compiler(content = 'COMPILED-L0') {
  const fn = async ({ outPath }) => {
    if (outPath) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(outPath, content, 'utf8');
    }
    return content;
  };
  return fn;
}
