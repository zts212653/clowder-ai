/**
 * F153 Phase B: Runtime exporter-level tracing tests.
 *
 * Uses InMemorySpanExporter to verify that real OTel spans are produced
 * with correct parent-child relationships, attributes, and status codes.
 * Complements the structural tests in otel-tracing-phase-b.test.js.
 *
 * Requires dist/ build — run `pnpm build` in packages/api first.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import { clearTimeout as clearKeepAliveTimeout, setTimeout as setKeepAliveTimeout } from 'node:timers';

// OTel SDK test utilities
const { trace, SpanStatusCode, context } = await import('@opentelemetry/api');
const { InMemorySpanExporter, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');

// Module under test
const { spawnCli } = await import('../../dist/utils/cli-spawn.js');

/** Collect all items from an async iterable */
async function collect(iterable) {
  const keepAlive = setKeepAliveTimeout(() => {}, 15_000);
  const items = [];
  try {
    for await (const item of iterable) {
      items.push(item);
    }
    return items;
  } finally {
    clearKeepAliveTimeout(keepAlive);
  }
}

/** Create a mock child process */
function createMockProcess(opts = {}) {
  const { exitOnKill = true, exitCode = null, pid = 12345 } = opts;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    pid,
    exitCode: null,
    kill: mock.fn((signal) => {
      if (exitOnKill) {
        process.nextTick(() => {
          if (!stdout.destroyed) stdout.end();
          emitter.emit('exit', exitCode, signal || 'SIGTERM');
        });
      }
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

function createMockSpawnFn(mockProcess) {
  return mock.fn(() => mockProcess);
}

// --- Test setup: register InMemorySpanExporter (OTel 2.x API) ---
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

test('F153 runtime: cli_session span is produced with correct parent', async () => {
  exporter.reset();

  const tracer = trace.getTracer('cat-cafe-api-test');
  const parentSpan = tracer.startSpan('cat_cafe.invocation');

  const proc = createMockProcess({ exitCode: 0 });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli(
      {
        command: 'test-cli',
        args: ['--json'],
        parentSpan,
        invocationId: 'inv-123',
        cliSessionId: 'sess-456',
      },
      { spawnFn },
    ),
  );

  proc.stdout.write('{"type":"message","text":"hello"}\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);

  await promise;
  parentSpan.end();

  const spans = exporter.getFinishedSpans();
  const cliSpan = spans.find((s) => s.name === 'cat_cafe.cli_session');

  assert.ok(cliSpan, 'Should produce a cat_cafe.cli_session span');
  assert.equal(
    cliSpan.parentSpanContext.spanId,
    parentSpan.spanContext().spanId,
    'cli_session span should be child of invocation span',
  );
});

test('F153 runtime: cli_session span has correct attributes', async () => {
  exporter.reset();

  const tracer = trace.getTracer('cat-cafe-api-test');
  const parentSpan = tracer.startSpan('cat_cafe.invocation');

  const proc = createMockProcess({ exitCode: 0, pid: 99999 });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli(
      {
        command: 'claude',
        args: ['--json', '--prompt', 'hello'],
        parentSpan,
        invocationId: 'inv-attr-test',
        cliSessionId: 'sess-attr-test',
      },
      { spawnFn },
    ),
  );

  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  await promise;
  parentSpan.end();

  const spans = exporter.getFinishedSpans();
  const cliSpan = spans.find((s) => s.name === 'cat_cafe.cli_session');
  assert.ok(cliSpan, 'Should find cli_session span');

  const attrs = cliSpan.attributes;
  assert.equal(attrs['cli.command'], 'claude', 'Should have cli.command');
  assert.equal(attrs['cli.arg_count'], 3, 'Should have cli.arg_count');
  assert.equal(attrs['cli.pid'], 99999, 'Should have cli.pid');
  assert.equal(attrs.invocationId, 'inv-attr-test', 'Should use redactor-safe invocationId key');
  assert.equal(attrs.sessionId, 'sess-attr-test', 'Should use redactor-safe sessionId key');
});

test('F153 runtime: cli_session span status OK on clean exit', async () => {
  exporter.reset();

  const tracer = trace.getTracer('cat-cafe-api-test');
  const parentSpan = tracer.startSpan('cat_cafe.invocation');

  const proc = createMockProcess({ exitCode: 0 });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [], parentSpan }, { spawnFn }));

  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  await promise;
  parentSpan.end();

  const spans = exporter.getFinishedSpans();
  const cliSpan = spans.find((s) => s.name === 'cat_cafe.cli_session');
  assert.ok(cliSpan, 'Should find cli_session span');
  assert.equal(cliSpan.status.code, SpanStatusCode.OK, 'Status should be OK on clean exit');
});

test('F153 runtime: cli_session span status ERROR on non-zero exit', async () => {
  exporter.reset();

  const tracer = trace.getTracer('cat-cafe-api-test');
  const parentSpan = tracer.startSpan('cat_cafe.invocation');

  const proc = createMockProcess({ exitCode: 1 });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [], parentSpan }, { spawnFn }));

  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);
  await promise;
  parentSpan.end();

  const spans = exporter.getFinishedSpans();
  const cliSpan = spans.find((s) => s.name === 'cat_cafe.cli_session');
  assert.ok(cliSpan, 'Should find cli_session span');
  assert.equal(cliSpan.status.code, SpanStatusCode.ERROR, 'Status should be ERROR on non-zero exit');
  assert.ok(cliSpan.status.message.includes('exit code 1'), 'Error message should include exit code');
});

test('F153 runtime: no cli_session span when parentSpan is not provided', async () => {
  exporter.reset();

  const proc = createMockProcess({ exitCode: 0 });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  await promise;

  const spans = exporter.getFinishedSpans();
  const cliSpan = spans.find((s) => s.name === 'cat_cafe.cli_session');
  assert.equal(cliSpan, undefined, 'Should NOT produce cli_session span without parentSpan');
});

test('F153 runtime: redactor-safe attribute keys are used (not dotted)', async () => {
  exporter.reset();

  const tracer = trace.getTracer('cat-cafe-api-test');
  const parentSpan = tracer.startSpan('cat_cafe.invocation');

  const proc = createMockProcess({ exitCode: 0 });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli(
      {
        command: 'test-cli',
        args: [],
        parentSpan,
        invocationId: 'inv-redact',
        cliSessionId: 'sess-redact',
      },
      { spawnFn },
    ),
  );

  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  await promise;
  parentSpan.end();

  const spans = exporter.getFinishedSpans();
  const cliSpan = spans.find((s) => s.name === 'cat_cafe.cli_session');
  assert.ok(cliSpan, 'Should find cli_session span');

  const attrKeys = Object.keys(cliSpan.attributes);
  assert.ok(!attrKeys.includes('cat_cafe.invocation_id'), 'Must not use dotted cat_cafe.invocation_id');
  assert.ok(!attrKeys.includes('cat_cafe.cli_session_id'), 'Must not use dotted cat_cafe.cli_session_id');
  assert.ok(attrKeys.includes('invocationId'), 'Must use camelCase invocationId');
  assert.ok(attrKeys.includes('sessionId'), 'Must use camelCase sessionId');
});
