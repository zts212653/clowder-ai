/**
 * F319 Served Model Provenance — CodexAgentService integration.
 * The upstream response object, not the config echo, decides
 * metadata.servedModel; mismatches become visible in the same thread.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const { CodexAgentService: ProductionCodexAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/CodexAgentService.js'
);
const { estimateCostFromTokens } = await import('../dist/config/model-pricing.js');

class CodexAgentService extends ProductionCodexAgentService {
  constructor(options = {}) {
    super({ ...options, cliCommand: process.execPath });
  }
}

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function createMockProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit') process.nextTick(() => originalEmit('close', ...args));
    return emitted;
  };
  const stdin = new PassThrough();
  stdin.resume();
  return {
    stdout,
    stderr,
    stdin,
    pid: 12345,
    killed: false,
    exitCode: null,
    kill() {
      this.killed = true;
      return true;
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    _emitter: emitter,
  };
}

function emitCodexEvents(proc, events) {
  for (const event of events) proc.stdout.write(`${JSON.stringify(event)}\n`);
  setImmediate(() => {
    proc.stderr.end();
    proc.stdout.end();
    proc._emitter.emit('exit', 0, null);
  });
}

const SSE_CREATED = (model, id = 'resp_f319') =>
  `2026-09-21T07:05:50.783078Z TRACE codex_api::sse::responses: SSE event: {"type":"response.created","response":{"id":"${id}","object":"response","status":"in_progress","model":"${model}","prompt_cache_key":"thread-f319"},"sequence_number":0}\n`;

async function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function runInvocation({ stderrLines = [], model = 'gpt-5.4', usage, invokeOptions } = {}) {
  const proc = createMockProcess();
  const spawnFn = mock.fn(() => proc);
  const service = new CodexAgentService({ l0CompilerFn: fakeL0Compiler, spawnFn, model });
  const promise = collect(service.invoke('served model probe', invokeOptions));
  for (const line of stderrLines) proc.stderr.write(line);
  emitCodexEvents(proc, [
    { type: 'thread.started', thread_id: 'thread-f319' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'OK' } },
    { type: 'turn.completed', usage: usage ?? { input_tokens: 1000, output_tokens: 100 } },
  ]);
  const events = await promise;
  const call = spawnFn.mock.calls[0];
  return { events, args: call.arguments[1], env: call.arguments[2]?.env ?? {} };
}

const OBSERVATION_DEFAULT = {
  CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION: undefined,
  CAT_CAFE_CODEX_OAUTH_TRANSPORT: undefined,
};

describe('F319 served model provenance', () => {
  test('default on: the transport is untouched (builtin websocket) and both trace directives are set', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      const { args, env } = await runInvocation();
      // Phase B.2: observation rides the operator's transport — no HTTPS override.
      assert.ok(args.includes('model_provider="openai"'), 'OAuth default keeps the built-in provider pin');
      assert.ok(!args.includes('model_provider="openai_https"'), 'observation must not force the HTTPS transport');
      assert.match(env.RUST_LOG ?? '', /codex_api::sse::responses=trace/);
      assert.match(env.RUST_LOG ?? '', /tungstenite::protocol=trace/);
    });
  });

  test('websocket frames on the default transport stamp servedModel and the upstream frame facts', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      const ts = '2026-09-21T23:56:28.136316Z';
      const meta = `${ts} TRACE tungstenite::protocol: Received message {"type":"codex.response.metadata","headers":{"x-codex-turn-state":"${'t'.repeat(312)}","x-codex-safety-buffering-enabled":"true","x-codex-safety-buffering-faster-model":"gpt-5.6-luna"}}\n`;
      const created = `${ts} TRACE tungstenite::protocol: Received message {"type":"response.created","response":{"id":"resp_ws_exec","object":"response","status":"in_progress","model":"gpt-5.3-codex","prompt_cache_key":"thread-f319","metadata":{}}}\n`;
      const completed = `${ts} TRACE tungstenite::protocol: Received message {"type":"response.completed","response":{"id":"resp_ws_exec","object":"response","status":"completed","model":"gpt-5.3-codex","prompt_cache_key":"thread-f319","safety_buffering":false}}\n`;
      const { events } = await runInvocation({ model: 'gpt-5.4', stderrLines: [meta, created, completed] });
      const done = events.find((e) => e.type === 'done');
      assert.equal(done.metadata.servedModel, 'gpt-5.3-codex');
      assert.equal(done.metadata.servedResponseId, 'resp_ws_exec');
      assert.equal(done.metadata.servedModelSource, 'ws_response_object');
      assert.equal(done.metadata.modelVerified, true);
      assert.equal(done.metadata.upstreamTurnStateLength, 312);
      assert.equal(done.metadata.upstreamSafetyBufferingFasterModel, 'gpt-5.6-luna');
      assert.equal(done.metadata.upstreamSafetyBuffering, false);
      const warning = events.find(
        (e) => e.semanticEvent?.kind === 'warning' && e.semanticEvent.category === 'model_reroute',
      );
      assert.ok(warning, 'mismatch observed on websocket frames must still surface the reroute warning');
    });
  });

  test('off: spawn args and env are unchanged from today', async () => {
    await withEnv({ ...OBSERVATION_DEFAULT, CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION: 'off' }, async () => {
      const { args, env, events } = await runInvocation({ stderrLines: [SSE_CREATED('gpt-5.3-codex')] });
      assert.ok(args.includes('model_provider="openai"'));
      assert.ok(!args.includes('model_provider="openai_https"'));
      assert.equal(env.RUST_LOG, undefined);
      const done = events.find((e) => e.type === 'done');
      assert.equal(done.metadata.servedModel, undefined, 'off means no observation is recorded');
    });
  });

  test('records servedModel / servedResponseId / modelVerified from the response object', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      const { events } = await runInvocation({ model: 'gpt-5.4', stderrLines: [SSE_CREATED('gpt-5.4', 'resp_same')] });
      const done = events.find((e) => e.type === 'done');
      assert.equal(done.metadata.model, 'gpt-5.4');
      assert.equal(done.metadata.servedModel, 'gpt-5.4');
      assert.equal(done.metadata.servedResponseId, 'resp_same');
      assert.equal(done.metadata.servedModelSource, 'sse_response_object');
      assert.equal(done.metadata.modelVerified, true);
      assert.ok(
        !events.some((e) => e.semanticEvent?.kind === 'warning' && e.semanticEvent.category === 'model_reroute'),
        'matching served model must not raise a reroute warning',
      );
    });
  });

  test('no observation: fields stay absent and modelVerified is not claimed', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      const { events } = await runInvocation({ stderrLines: ['2026-09-21T06:29:08Z  INFO codex_core: hello\n'] });
      const done = events.find((e) => e.type === 'done');
      assert.equal(done.metadata.servedModel, undefined);
      assert.equal(done.metadata.servedResponseId, undefined);
      assert.notEqual(done.metadata.modelVerified, true);
    });
  });

  test('mismatch: emits a model_reroute warning and prices the turn by the served model', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      const { events } = await runInvocation({
        model: 'gpt-5.4',
        stderrLines: [SSE_CREATED('gpt-5.3-codex', 'resp_luna')],
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
      });
      const done = events.find((e) => e.type === 'done');
      assert.equal(done.metadata.servedModel, 'gpt-5.3-codex');
      assert.equal(done.metadata.modelVerified, true);
      const expected = estimateCostFromTokens('gpt-5.3-codex', 1_000_000, 100_000, undefined);
      const requestedPrice = estimateCostFromTokens('gpt-5.4', 1_000_000, 100_000, undefined);
      assert.notEqual(expected, requestedPrice, 'fixture models must be priced differently');
      assert.equal(done.metadata.usage.costUsd, expected);
      const warning = events.find(
        (e) => e.semanticEvent?.kind === 'warning' && e.semanticEvent.category === 'model_reroute',
      );
      assert.ok(warning, 'mismatch must surface as a model_reroute warning semantic event');
      assert.equal(warning.type, 'provider_signal');
      assert.match(warning.semanticEvent.message, /gpt-5\.4/);
      assert.match(warning.semanticEvent.message, /gpt-5\.3-codex/);
      assert.match(warning.semanticEvent.message, /resp_luna/);
      assert.ok(events.indexOf(warning) < events.indexOf(done), 'warning must precede done');
    });
  });

  test('API-key custom base URL path is untouched by observation', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      const { args, env } = await runInvocation({
        model: 'qwen-plus',
        invokeOptions: {
          callbackEnv: {
            OPENAI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
            OPENAI_API_KEY: 'sk-test',
            CODEX_AUTH_MODE: 'api_key',
          },
        },
      });
      assert.ok(args.includes('model_provider="custom"'));
      assert.ok(!args.includes('model_provider="openai_https"'));
      assert.equal(env.RUST_LOG, undefined);
    });
  });

  test('api_key label without a custom base URL is observed like OAuth (auth label ≠ wire)', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      // Clowder AI's account walk can label a cat `api_key` (installer account
      // holds a key) while Codex itself signs the request with the ChatGPT
      // login in auth.json. Either way the request reaches OpenAI's own
      // backend, so the served model must be observed — the label is not
      // the wire (alpha AC-B4 miss, 2026-09-21).
      const { args, env, events } = await runInvocation({
        model: 'gpt-5.4',
        stderrLines: [SSE_CREATED('gpt-5.3-codex', 'resp_label')],
        invokeOptions: { callbackEnv: { OPENAI_API_KEY: 'sk-test', CODEX_AUTH_MODE: 'api_key' } },
      });
      // Phase B.2: no transport override for any label; only the trace directives are added.
      assert.ok(!args.includes('model_provider="openai_https"'), 'observation must not force the HTTPS transport');
      assert.ok(!args.includes('model_provider="custom"'), 'no custom base URL → not the custom provider');
      assert.match(env.RUST_LOG ?? '', /codex_api::sse::responses=trace/);
      assert.match(env.RUST_LOG ?? '', /tungstenite::protocol=trace/);
      const done = events.find((e) => e.type === 'done');
      assert.equal(done.metadata.servedModel, 'gpt-5.3-codex');
      assert.equal(done.metadata.servedResponseId, 'resp_label');
      assert.equal(done.metadata.modelVerified, true);
    });
  });

  test('off + api_key label: launch is exactly the pre-F319 default provider', async () => {
    await withEnv({ ...OBSERVATION_DEFAULT, CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION: 'off' }, async () => {
      const { args, env } = await runInvocation({
        invokeOptions: { callbackEnv: { OPENAI_API_KEY: 'sk-test', CODEX_AUTH_MODE: 'api_key' } },
      });
      assert.ok(!args.includes('model_provider="openai_https"'), 'off must not force HTTPS on api_key sessions');
      assert.ok(!args.includes('model_provider="openai"'), 'the OAuth-only builtin pin stays OAuth-only');
      assert.equal(env.RUST_LOG, undefined);
    });
  });
});
