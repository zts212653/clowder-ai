import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  MemoryProcessDiagnostics,
  memoryProcessStderrBoundary,
} from '../../dist/domains/memory/memory-process-diagnostics.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

const boundary = (collector, id, phase) => memoryProcessStderrBoundary(collector.token, id, phase);
test('late stderr from an earlier request cannot appear in a later request crash diagnostic', async () => {
  const stream = new PassThrough();
  const collector = new MemoryProcessDiagnostics(stream);
  collector.begin(1);
  stream.write(boundary(collector, 1, 'begin') + 'private first request\n');
  collector.finish(1);
  collector.begin(2);
  stream.write('delayed private first output\n' + boundary(collector, 1, 'end'));
  const next = Buffer.from(boundary(collector, 2, 'begin') + 'second request 崩溃\n');
  for (const byte of next) stream.write(Buffer.from([byte]));
  stream.end();
  await once(stream, 'end');
  const tail = collector.tail(2);
  assert.match(tail, /second request 崩溃/);
  assert.doesNotMatch(tail, /private|first|delayed/);
  assert.equal(collector.tail(1), '');
});
test('diagnostics preserve a bounded stderr tail and erase it when the request settles', async () => {
  const stream = new PassThrough();
  const collector = new MemoryProcessDiagnostics(stream);
  collector.begin(1);
  stream.write(boundary(collector, 1, 'begin') + 'prefix secret\n' + '诊断'.repeat(10000) + '\ncrash tail');
  stream.end(boundary(collector, 1, 'end'));
  await once(stream, 'end');
  const tail = collector.tail(1);
  assert.ok(Buffer.byteLength(tail) <= 8192);
  assert.ok(tail.endsWith('crash tail'));
  assert.doesNotMatch(tail, /prefix secret/);
  collector.finish(1);
  assert.equal(collector.tail(1), '');
});
test('module-startup failure is attributable to the first request without a begin marker', async () => {
  const stream = new PassThrough();
  const collector = new MemoryProcessDiagnostics(stream);
  collector.begin(1);
  stream.end('Cannot load native module\n');
  await once(stream, 'end');
  assert.match(collector.tail(1), /Cannot load native module/);
});

test('a real memory child startup crash returns only its bounded stderr tail and the next read recovers', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-crash-diagnostics-'));
  const store = new SqliteEvidenceStore(join(dir, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const previous = process.env.NODE_OPTIONS;
  const restore = () => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  };
  const preload = new URL('../helpers/memory-child-startup-failure.mjs', import.meta.url).href;
  process.env.NODE_OPTIONS = `${previous ?? ''} --import=${preload}`;
  try {
    await assert.rejects(store.search('fixture'), (error) => {
      assert.match(error.message, /Memory process exited \(17\)/);
      assert.match(error.stderrTail, /native loader fixture failure/);
      assert.ok(Buffer.byteLength(error.stderrTail) <= 8192);
      assert.doesNotMatch(error.stderrTail, /discarded startup prefix/);
      return true;
    });
  } finally {
    restore();
  }
  assert.deepEqual(await store.search('fixture'), []);
});
