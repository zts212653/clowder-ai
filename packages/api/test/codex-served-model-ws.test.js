/**
 * F319 Phase B.2 — websocket frame observation.
 * On the builtin transport codex 0.155.1 exposes every frame through
 * `RUST_LOG=tungstenite::protocol=trace`; `response.created` carries the
 * declared model + prompt_cache_key, `codex.response.metadata` carries the
 * per-turn headers (turn-state token, safety buffering). Line shapes below are
 * the real ones observed on 2026-09-21 (tokens replaced, values kept).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  parseCodexUpstreamTraceLine,
  parseCodexSseTraceLine,
  createCodexServedModelTracker,
  createCodexHostServedModelRegistry,
  CODEX_UPSTREAM_METADATA_ATTACH_WINDOW_MS,
} = await import('../dist/domains/cats/services/agents/providers/codex-served-model.js');

const TS = '2026-09-21T23:56:28.136316Z';
const WS_META = (turnStateLength = 312, faster = 'gpt-5.6-luna') =>
  `${TS} TRACE tungstenite::protocol: Received message {"type":"codex.response.metadata","headers":{"x-codex-turn-state":"${'a'.repeat(turnStateLength)}","x-codex-safety-buffering-enabled":"true","x-codex-safety-buffering-faster-model":"${faster}","x-models-etag":"W/\\"etag\\""}}`;
const WS_CREATED = (key, model, id) =>
  `${TS} TRACE tungstenite::protocol: Received message {"type":"response.created","response":{"id":"${id}","object":"response","status":"in_progress","model":"${model}","prompt_cache_key":"${key}","metadata":{}},"sequence_number":0}`;
const WS_COMPLETED = (key, model, id) =>
  `${TS} TRACE tungstenite::protocol: Received message {"type":"response.completed","response":{"id":"${id}","object":"response","status":"completed","model":"${model}","prompt_cache_key":"${key}","safety_buffering":false}}`;
const WS_DELTA = `${TS} TRACE tungstenite::protocol: Received message {"type":"response.output_text.delta","delta":"OK"}`;

describe('F319 Phase B.2 parseCodexUpstreamTraceLine (websocket frames)', () => {
  test('reads the declared model and prompt cache key from a response.created frame', () => {
    const parsed = parseCodexUpstreamTraceLine(WS_CREATED('thread-1', 'gpt-5.6-luna', 'resp_ws_1'));
    assert.equal(parsed?.kind, 'observation');
    assert.deepEqual(parsed.observation, {
      eventType: 'response.created',
      responseId: 'resp_ws_1',
      servedModel: 'gpt-5.6-luna',
      source: 'ws_response_object',
      promptCacheKey: 'thread-1',
    });
    // Phase A callers keep working on websocket lines too.
    assert.equal(
      parseCodexSseTraceLine(WS_CREATED('thread-1', 'gpt-5.6-luna', 'resp_ws_1'))?.servedModel,
      'gpt-5.6-luna',
    );
  });

  test('turns a codex.response.metadata frame into header facts without keeping the token', () => {
    const parsed = parseCodexUpstreamTraceLine(WS_META(312, 'gpt-5.6-luna'));
    assert.equal(parsed?.kind, 'metadata');
    assert.deepEqual(parsed.frame, {
      turnStateLength: 312,
      safetyBufferingEnabled: true,
      safetyBufferingFasterModel: 'gpt-5.6-luna',
    });
    assert.ok(!JSON.stringify(parsed).includes('aaaaaaaa'), 'the sticky-routing token itself must not be retained');
  });

  test('response.completed carries the safety_buffering flag; deltas stay unobserved', () => {
    const completed = parseCodexUpstreamTraceLine(WS_COMPLETED('thread-1', 'gpt-5.6-sol', 'resp_ws_2'));
    assert.equal(completed?.kind, 'observation');
    assert.equal(completed.observation.safetyBuffering, false);
    assert.equal(parseCodexUpstreamTraceLine(WS_DELTA), undefined);
    assert.equal(
      parseCodexUpstreamTraceLine('2026-09-21 TRACE tungstenite::protocol: Received message not-json'),
      undefined,
    );
  });
});

describe('F319 Phase B.2 tracker attaches the metadata frame to the next response', () => {
  test('metadata → created → completed yields one snapshot with the frame facts', () => {
    let clock = 1_000;
    const tracker = createCodexServedModelTracker({ now: () => clock });
    tracker.onStderrLine(WS_META(312));
    clock += 150;
    tracker.onStderrLine(WS_CREATED('thread-1', 'gpt-5.6-luna', 'resp_ws_1'));
    clock += 800;
    tracker.onStderrLine(WS_COMPLETED('thread-1', 'gpt-5.6-luna', 'resp_ws_1'));
    assert.deepEqual(tracker.snapshot(), {
      servedModel: 'gpt-5.6-luna',
      servedResponseId: 'resp_ws_1',
      servedModelSource: 'ws_response_object',
      upstreamTurnStateLength: 312,
      upstreamSafetyBufferingFasterModel: 'gpt-5.6-luna',
      upstreamSafetyBuffering: false,
    });
  });

  test('a stale metadata frame (outside the attach window) is not attributed', () => {
    let clock = 1_000;
    const tracker = createCodexServedModelTracker({ now: () => clock });
    tracker.onStderrLine(WS_META(312));
    clock += CODEX_UPSTREAM_METADATA_ATTACH_WINDOW_MS + 1;
    tracker.onStderrLine(WS_CREATED('thread-1', 'gpt-5.6-sol', 'resp_ws_3'));
    const snapshot = tracker.snapshot();
    assert.equal(snapshot?.servedModel, 'gpt-5.6-sol');
    assert.equal(snapshot?.upstreamTurnStateLength, undefined, 'unknown attribution stays absent, never guessed');
  });
});

describe('F319 Phase B.2 host registry attribution', () => {
  test('a single pending frame on the host stream is attributed to the next keyed response', () => {
    let clock = 5_000;
    const registry = createCodexHostServedModelRegistry({ now: () => clock });
    registry.ingestStderrLine(WS_META(312));
    clock += 120;
    registry.ingestStderrLine(WS_CREATED('thread-A', 'gpt-6-astra', 'resp_a1'));
    clock += 900;
    registry.ingestStderrLine(WS_COMPLETED('thread-A', 'gpt-5.6-luna', 'resp_a1'));
    const entry = registry.lookup('thread-A');
    assert.equal(entry?.servedModel, 'gpt-5.6-luna');
    assert.equal(entry?.source, 'ws_response_object');
    assert.equal(entry?.upstream?.turnStateLength, 312);
    assert.equal(entry?.safetyBuffering, false);
  });

  test('two metadata frames before any response (concurrent turns) are ambiguous and dropped', () => {
    let clock = 5_000;
    const registry = createCodexHostServedModelRegistry({ now: () => clock });
    registry.ingestStderrLine(WS_META(312));
    clock += 10;
    registry.ingestStderrLine(WS_META(312));
    clock += 100;
    registry.ingestStderrLine(WS_CREATED('thread-A', 'gpt-5.6-sol', 'resp_a2'));
    clock += 50;
    registry.ingestStderrLine(WS_CREATED('thread-B', 'gpt-5.6-terra', 'resp_b2'));
    assert.equal(registry.lookup('thread-A')?.servedModel, 'gpt-5.6-sol');
    assert.equal(registry.lookup('thread-A')?.upstream, undefined, 'ambiguous frame must not be attributed');
    assert.equal(registry.lookup('thread-B')?.servedModel, 'gpt-5.6-terra');
    assert.equal(registry.lookup('thread-B')?.upstream, undefined);
  });
});

/**
 * Phase B.4: `codex app-server` colours its stderr even when it is a pipe (its fmt
 * layer never turns ANSI off, unlike `codex exec`), so the target and the `:` are
 * split by SGR escapes. Line shape copied from a real 0.155.1 app-server session
 * (2026-09-22T03:04Z, raw stderr); the turn-state token is replaced by a same-length filler.
 */
const ESC = '\u001b';
const ANSI_PREFIX = `${ESC}[2m2026-09-22T03:04:34.790849Z${ESC}[0m ${ESC}[35mTRACE${ESC}[0m ${ESC}[2mtungstenite::protocol${ESC}[0m${ESC}[2m:${ESC}[0m Received message `;
const ANSI_META = `${ANSI_PREFIX}{"type":"codex.response.metadata","headers":{"x-models-etag":"W/\\"5684\\"","x-codex-turn-state":"${'g'.repeat(312)}","x-codex-safety-buffering-enabled":"true","x-codex-safety-buffering-faster-model":"gpt-5.6-luna"}}`;
const ANSI_CREATED = `${ANSI_PREFIX}{"type":"response.created","response":{"id":"resp_ansi_1","object":"response","status":"in_progress","model":"gpt-5.6-sol","prompt_cache_key":"thread-ansi","metadata":{}},"sequence_number":0}`;
const ANSI_SSE = `${ESC}[2m2026-09-22T03:04:35.058916Z${ESC}[0m ${ESC}[35mTRACE${ESC}[0m ${ESC}[2mcodex_api::sse::responses${ESC}[0m${ESC}[2m:${ESC}[0m SSE event: {"type":"response.created","response":{"id":"resp_ansi_sse","model":"gpt-5.6-sol","prompt_cache_key":"thread-ansi"}}`;

describe('F319 Phase B.4 ANSI-coloured app-server stderr', () => {
  test('a coloured metadata frame still yields the turn-state length', () => {
    const parsed = parseCodexUpstreamTraceLine(ANSI_META);
    assert.equal(parsed?.kind, 'metadata');
    assert.equal(parsed.frame.turnStateLength, 312);
    assert.equal(parsed.frame.safetyBufferingFasterModel, 'gpt-5.6-luna');
    assert.ok(!JSON.stringify(parsed).includes('gggggggg'), 'the token itself must not be retained');
  });

  test('a coloured response.created frame yields the declared model from the websocket source', () => {
    const parsed = parseCodexUpstreamTraceLine(ANSI_CREATED);
    assert.equal(parsed?.kind, 'observation');
    assert.equal(parsed.observation.servedModel, 'gpt-5.6-sol');
    assert.equal(parsed.observation.source, 'ws_response_object');
    assert.equal(parsed.observation.promptCacheKey, 'thread-ansi');
  });

  test('coloured SSE lines keep parsing (the Phase B.3 path)', () => {
    assert.equal(parseCodexSseTraceLine(ANSI_SSE)?.servedModel, 'gpt-5.6-sol');
  });

  test('the host registry attributes coloured frames end to end', () => {
    let clock = 9_000;
    const registry = createCodexHostServedModelRegistry({ now: () => clock });
    registry.ingestStderrLine(ANSI_META);
    clock += 150;
    registry.ingestStderrLine(ANSI_CREATED);
    const entry = registry.lookup('thread-ansi');
    assert.equal(entry?.servedModel, 'gpt-5.6-sol');
    assert.equal(entry?.source, 'ws_response_object');
    assert.equal(entry?.upstream?.turnStateLength, 312);
  });

  test('an escape sequence inside the JSON payload is data, not colour (JSON escapes ESC as \\u001b)', () => {
    const line = `${ANSI_PREFIX}{"type":"response.created","response":{"id":"resp_esc","model":"gpt-5.6-sol","prompt_cache_key":"k\\u001b[0m"}}`;
    assert.equal(parseCodexUpstreamTraceLine(line)?.observation?.promptCacheKey, `k${ESC}[0m`);
  });
});
