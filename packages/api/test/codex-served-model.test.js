/**
 * F319 Served Model Provenance — pure helpers.
 * The upstream Responses API object is the only place the ChatGPT backend
 * declares which model answered; Codex 0.155.1 only surfaces it through the
 * `codex_api::sse::responses=trace` dump on the HTTPS transport.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  parseCodexSseTraceLine,
  createCodexServedModelTracker,
  buildCodexServedModelMismatchEvent,
  mergeRustLogDirective,
  CODEX_SERVED_MODEL_RUST_LOG_DIRECTIVE,
  CODEX_SERVED_MODEL_WS_RUST_LOG_DIRECTIVE,
  CODEX_SERVED_MODEL_RUST_LOG_DIRECTIVES,
  CODEX_SERVED_MODEL_RUST_LOG_DEFAULT,
} = await import('../dist/domains/cats/services/agents/providers/codex-served-model.js');
const { getCodexServedModelObservation } = await import('../dist/config/codex-cli.js');

const CREATED_LINE =
  '2026-09-21T07:05:50.783078Z TRACE codex_api::sse::responses: SSE event: {"type":"response.created","response":{"id":"resp_0d46","object":"response","created_at":1789974349,"status":"in_progress","model":"gpt-5.6-luna","prompt_cache_key":"01a0c2c8-f74f-7682-882d-6ad262be6248"},"sequence_number":0}';
const COMPLETED_LINE =
  '2026-09-21T07:05:55.000000Z TRACE codex_api::sse::responses: SSE event: {"type":"response.completed","response":{"id":"resp_0d46","object":"response","status":"completed","model":"gpt-5.6-luna","prompt_cache_key":"01a0c2c8-f74f-7682-882d-6ad262be6248"},"sequence_number":9}';

describe('F319 parseCodexSseTraceLine', () => {
  test('extracts model, response id and prompt cache key from response.created', () => {
    const observation = parseCodexSseTraceLine(CREATED_LINE);
    assert.deepEqual(observation, {
      eventType: 'response.created',
      responseId: 'resp_0d46',
      servedModel: 'gpt-5.6-luna',
      // Phase B.2: the source names the transport the line came from.
      source: 'sse_response_object',
      promptCacheKey: '01a0c2c8-f74f-7682-882d-6ad262be6248',
    });
  });

  test('ignores delta events and unrelated log lines', () => {
    assert.equal(
      parseCodexSseTraceLine(
        'TRACE codex_api::sse::responses: SSE event: {"type":"response.output_text.delta","delta":"OK"}',
      ),
      undefined,
    );
    assert.equal(parseCodexSseTraceLine('2026-09-21T06:29:08Z  INFO codex_core::shell_snapshot: created'), undefined);
    assert.equal(parseCodexSseTraceLine(''), undefined);
  });

  test('malformed JSON or missing model is "unobserved", never a default value', () => {
    assert.equal(parseCodexSseTraceLine('SSE event: {"type":"response.created","response":'), undefined);
    assert.equal(
      parseCodexSseTraceLine('SSE event: {"type":"response.created","response":{"id":"resp_x"}}'),
      undefined,
    );
  });
});

describe('F319 createCodexServedModelTracker', () => {
  test('starts unobserved and reports the latest observation', () => {
    const tracker = createCodexServedModelTracker();
    assert.equal(tracker.snapshot(), undefined);
    tracker.onStderrLine(CREATED_LINE);
    assert.deepEqual(tracker.snapshot(), {
      servedModel: 'gpt-5.6-luna',
      servedResponseId: 'resp_0d46',
      servedModelSource: 'sse_response_object',
    });
    tracker.onStderrLine(COMPLETED_LINE);
    assert.equal(tracker.snapshot()?.servedResponseId, 'resp_0d46');
    assert.equal(tracker.observationCount(), 2);
  });

  test('reassembles a trace line split across chunks only when fed whole lines', () => {
    const tracker = createCodexServedModelTracker();
    tracker.onStderrLine('garbage before');
    tracker.onStderrLine(CREATED_LINE);
    assert.equal(tracker.snapshot()?.servedModel, 'gpt-5.6-luna');
  });
});

describe('F319 buildCodexServedModelMismatchEvent', () => {
  test('returns undefined when served model matches the request (case-insensitive)', () => {
    assert.equal(
      buildCodexServedModelMismatchEvent({
        catId: 'codex-astra',
        requestedModel: 'GPT-6-Astra',
        servedModel: 'gpt-6-astra',
        servedResponseId: 'resp_1',
        occurredAt: 1,
      }),
      undefined,
    );
  });

  test('builds a model_reroute warning semantic event on mismatch', () => {
    const event = buildCodexServedModelMismatchEvent({
      catId: 'codex-astra',
      requestedModel: 'gpt-6-astra',
      servedModel: 'gpt-5.6-luna',
      servedResponseId: 'resp_0d46',
      occurredAt: 1789974349000,
      invocationId: 'inv-1',
    });
    assert.ok(event);
    assert.equal(event.kind, 'warning');
    assert.equal(event.category, 'model_reroute');
    assert.equal(event.severity, 'warning');
    assert.equal(event.invocationId, 'inv-1');
    assert.match(event.message, /gpt-6-astra/);
    assert.match(event.message, /gpt-5\.6-luna/);
    assert.match(event.message, /resp_0d46/);
    assert.equal(event.provenance?.provider, 'codex');
    assert.equal(event.provenance?.nativeType, 'response.created');
  });
});

describe('F319 observation switch + RUST_LOG', () => {
  test('defaults on, honours off, ignores junk', () => {
    assert.equal(getCodexServedModelObservation({}), 'on');
    assert.equal(getCodexServedModelObservation({ CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION: 'off' }), 'off');
    assert.equal(getCodexServedModelObservation({ CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION: ' on ' }), 'on');
    assert.equal(getCodexServedModelObservation({ CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION: 'maybe' }), 'on');
  });

  test('merges the trace directive without clobbering an operator RUST_LOG', () => {
    // No operator RUST_LOG: keep codex exec's own default (`error,…`) so other
    // crates' error logs are not silenced, then add the trace directive.
    assert.equal(mergeRustLogDirective(undefined), CODEX_SERVED_MODEL_RUST_LOG_DEFAULT);
    assert.equal(mergeRustLogDirective(''), CODEX_SERVED_MODEL_RUST_LOG_DEFAULT);
    assert.match(CODEX_SERVED_MODEL_RUST_LOG_DEFAULT, /^error,/);
    for (const directive of CODEX_SERVED_MODEL_RUST_LOG_DIRECTIVES) {
      assert.ok(CODEX_SERVED_MODEL_RUST_LOG_DEFAULT.includes(directive), `default must carry ${directive}`);
    }
    // Phase B.2: both transports are traced — SSE events on HTTPS, tungstenite frames on the builtin websocket.
    const both = CODEX_SERVED_MODEL_RUST_LOG_DIRECTIVES.join(',');
    assert.equal(mergeRustLogDirective('codex_core=info'), `codex_core=info,${both}`);
    assert.equal(mergeRustLogDirective(`codex_core=info,${both}`), `codex_core=info,${both}`);
    assert.equal(
      mergeRustLogDirective(`codex_core=info,${CODEX_SERVED_MODEL_RUST_LOG_DIRECTIVE}`),
      `codex_core=info,${CODEX_SERVED_MODEL_RUST_LOG_DIRECTIVE},${CODEX_SERVED_MODEL_WS_RUST_LOG_DIRECTIVE}`,
    );
  });
});

describe('F319 Phase B createCodexHostServedModelRegistry', () => {
  const HOST_LINE = (key, model, id) =>
    `2026-09-21T10:00:00.000000Z TRACE codex_api::sse::responses: SSE event: {"type":"response.created","response":{"id":"${id}","object":"response","status":"in_progress","model":"${model}","prompt_cache_key":"${key}"},"sequence_number":0}`;

  test('keys observations by prompt_cache_key (= Codex thread id) and keeps the latest', async () => {
    const { createCodexHostServedModelRegistry, snapshotFromHostEntry } = await import(
      '../dist/domains/cats/services/agents/providers/codex-served-model.js'
    );
    let clock = 1000;
    const registry = createCodexHostServedModelRegistry({ now: () => clock });
    registry.ingestStderrLine('INFO codex_core: noise');
    registry.ingestStderrLine(HOST_LINE('thread-a', 'gpt-5.6-luna', 'resp_a1'));
    clock = 2000;
    registry.ingestStderrLine(HOST_LINE('thread-b', 'gpt-5.6-sol', 'resp_b1'));
    clock = 3000;
    registry.ingestStderrLine(HOST_LINE('thread-a', 'gpt-6-astra', 'resp_a2'));
    assert.equal(registry.size(), 2);
    const a = registry.lookup('thread-a');
    assert.equal(a?.servedModel, 'gpt-6-astra');
    assert.equal(a?.responseId, 'resp_a2');
    assert.equal(a?.observedAt, 3000);
    assert.deepEqual(snapshotFromHostEntry(a), {
      servedModel: 'gpt-6-astra',
      servedResponseId: 'resp_a2',
      servedModelSource: 'sse_response_object',
    });
    assert.equal(registry.lookup('thread-c'), undefined, 'unknown thread is unobserved');
  });

  test('sinceMs fences out observations from before the invocation started', async () => {
    const { createCodexHostServedModelRegistry } = await import(
      '../dist/domains/cats/services/agents/providers/codex-served-model.js'
    );
    let clock = 5000;
    const registry = createCodexHostServedModelRegistry({ now: () => clock });
    registry.ingestStderrLine(HOST_LINE('thread-a', 'gpt-5.6-luna', 'resp_old'));
    assert.equal(registry.lookup('thread-a', 6000), undefined, 'older than the invocation → unobserved');
    clock = 7000;
    registry.ingestStderrLine(HOST_LINE('thread-a', 'gpt-5.6-luna', 'resp_new'));
    assert.equal(registry.lookup('thread-a', 6000)?.responseId, 'resp_new');
  });

  test('lines without prompt_cache_key are ignored and the registry stays bounded', async () => {
    const { createCodexHostServedModelRegistry } = await import(
      '../dist/domains/cats/services/agents/providers/codex-served-model.js'
    );
    const registry = createCodexHostServedModelRegistry({ maxEntries: 2 });
    registry.ingestStderrLine(
      'SSE event: {"type":"response.created","response":{"id":"resp_x","model":"gpt-5.6-sol"}}',
    );
    assert.equal(registry.size(), 0);
    registry.ingestStderrLine(HOST_LINE('t1', 'm', 'r1'));
    registry.ingestStderrLine(HOST_LINE('t2', 'm', 'r2'));
    registry.ingestStderrLine(HOST_LINE('t3', 'm', 'r3'));
    assert.equal(registry.size(), 2);
    assert.equal(registry.lookup('t1'), undefined, 'oldest thread evicted');
    assert.ok(registry.lookup('t3'));
  });
});
