/**
 * F319 Phase B — served model on the app-server carrier.
 * The host's stderr trace lines are keyed by prompt_cache_key (= Codex thread
 * id) in a process-wide registry; an invocation may only consume an
 * observation made after it started.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const { CodexAgentService } = await import('../dist/domains/cats/services/agents/providers/CodexAgentService.js');
const { codexHostServedModels } = await import('../dist/domains/cats/services/agents/providers/codex-served-model.js');

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;
  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }
  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

/** Minimal app-server wire: initialize → thread/start → turn/start → turn/completed. */
class FakeAppServerWire {
  constructor(threadId) {
    this.threadId = threadId;
    this.inbox = new AsyncInbox();
    this.writes = [];
  }
  read() {
    return this.inbox;
  }
  async write(message) {
    this.writes.push(message);
    if (message.method === 'initialize') {
      this.inbox.push({ id: message.id, result: { userAgent: 'fake-app-server' } });
    } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      this.inbox.push({ id: message.id, result: { thread: { id: this.threadId, turns: [] } } });
    } else if (message.method === 'turn/start') {
      this.inbox.push({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
      setImmediate(() => {
        this.inbox.push({
          method: 'turn/completed',
          params: { threadId: message.params.threadId, turn: { id: 'turn-1', status: 'completed', items: [] } },
        });
      });
    }
  }
  rememberSession() {}
  async close() {
    this.inbox.close();
  }
}

const HOST_LINE = (key, model, id) =>
  `2026-09-21T10:00:00.000000Z TRACE codex_api::sse::responses: SSE event: {"type":"response.created","response":{"id":"${id}","object":"response","status":"in_progress","model":"${model}","prompt_cache_key":"${key}"},"sequence_number":0}`;

async function drain(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

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

function createService(model) {
  return new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model,
    rawArchive: { append: async () => {} },
  });
}

const OBSERVATION_DEFAULT = {
  CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION: undefined,
  CAT_CAFE_CODEX_OAUTH_TRANSPORT: undefined,
};

describe('F319 Phase B app-server served model', () => {
  test('a host observation for this thread made during the invocation lands on done metadata', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      const threadId = `codex-thread-f319-${Date.now()}`;
      const service = createService('gpt-5.4');
      const events = await drain(
        service.invoke('served model probe', {
          invocationId: 'invocation-f319-app-server',
          agentCarrierSessionFactory: async () => {
            // Ingested after the invocation started, as the real host stderr would be.
            codexHostServedModels.ingestStderrLine(HOST_LINE(threadId, 'gpt-5.3-codex', 'resp_host_1'));
            return new FakeAppServerWire(threadId);
          },
        }),
      );
      const done = events.find((e) => e.type === 'done');
      assert.ok(done, 'app-server invocation must end with done');
      assert.equal(done.metadata.sessionId, threadId, 'sessionId is the Codex thread id used for correlation');
      assert.equal(done.metadata.servedModel, 'gpt-5.3-codex');
      assert.equal(done.metadata.servedResponseId, 'resp_host_1');
      assert.equal(done.metadata.servedModelSource, 'sse_response_object');
      assert.equal(done.metadata.modelVerified, true);
      const warning = events.find(
        (e) => e.semanticEvent?.kind === 'warning' && e.semanticEvent.category === 'model_reroute',
      );
      assert.ok(warning, 'mismatch on the app-server carrier must surface the reroute warning');
      assert.equal(warning.semanticEvent.provenance?.carrier, 'app_server');
      assert.ok(events.indexOf(warning) < events.indexOf(done), 'warning precedes done');
    });
  });

  test('an observation from before the invocation started is not attributed to it', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      const threadId = `codex-thread-f319-stale-${Date.now()}`;
      codexHostServedModels.ingestStderrLine(HOST_LINE(threadId, 'gpt-5.3-codex', 'resp_stale'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const service = createService('gpt-5.4');
      const events = await drain(
        service.invoke('served model probe', {
          invocationId: 'invocation-f319-app-server-stale',
          agentCarrierSessionFactory: async () => new FakeAppServerWire(threadId),
        }),
      );
      const done = events.find((e) => e.type === 'done');
      assert.ok(done);
      assert.equal(done.metadata.sessionId, threadId);
      assert.equal(done.metadata.servedModel, undefined, 'stale host observation must stay unobserved');
      assert.notEqual(done.metadata.modelVerified, true);
      assert.ok(
        !events.some((e) => e.semanticEvent?.kind === 'warning' && e.semanticEvent.category === 'model_reroute'),
        'no reroute warning without a fresh observation',
      );
    });
  });

  test('observation off: host registry is not consulted', async () => {
    await withEnv({ ...OBSERVATION_DEFAULT, CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION: 'off' }, async () => {
      const threadId = `codex-thread-f319-off-${Date.now()}`;
      const service = createService('gpt-5.4');
      const events = await drain(
        service.invoke('served model probe', {
          invocationId: 'invocation-f319-app-server-off',
          agentCarrierSessionFactory: async () => {
            codexHostServedModels.ingestStderrLine(HOST_LINE(threadId, 'gpt-5.3-codex', 'resp_off'));
            return new FakeAppServerWire(threadId);
          },
        }),
      );
      const done = events.find((e) => e.type === 'done');
      assert.ok(done);
      assert.equal(done.metadata.servedModel, undefined);
    });
  });

  test('api_key label: a fresh host observation still lands on done (auth label ≠ wire)', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      const threadId = `codex-thread-f319-label-${Date.now()}`;
      const service = createService('gpt-5.4');
      const events = await drain(
        service.invoke('served model probe', {
          invocationId: 'invocation-f319-app-server-label',
          callbackEnv: { OPENAI_API_KEY: 'sk-test', CODEX_AUTH_MODE: 'api_key' },
          agentCarrierSessionFactory: async () => {
            codexHostServedModels.ingestStderrLine(HOST_LINE(threadId, 'gpt-5.3-codex', 'resp_host_label'));
            return new FakeAppServerWire(threadId);
          },
        }),
      );
      const done = events.find((e) => e.type === 'done');
      assert.ok(done, 'app-server invocation must end with done');
      assert.equal(done.metadata.sessionId, threadId);
      assert.equal(done.metadata.servedModel, 'gpt-5.3-codex');
      assert.equal(done.metadata.modelVerified, true);
    });
  });

  test('Phase B.2: websocket frames on the host stream stamp servedModel and the attributed frame facts', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      const threadId = `codex-thread-f319-ws-${Date.now()}`;
      const ts = '2026-09-21T23:56:28.136316Z';
      const meta = `${ts} TRACE tungstenite::protocol: Received message {"type":"codex.response.metadata","headers":{"x-codex-turn-state":"${'t'.repeat(312)}","x-codex-safety-buffering-enabled":"true","x-codex-safety-buffering-faster-model":"gpt-5.6-luna"}}`;
      const created = `${ts} TRACE tungstenite::protocol: Received message {"type":"response.created","response":{"id":"resp_ws_host","object":"response","status":"in_progress","model":"gpt-5.3-codex","prompt_cache_key":"${threadId}","metadata":{}}}`;
      const completed = `${ts} TRACE tungstenite::protocol: Received message {"type":"response.completed","response":{"id":"resp_ws_host","object":"response","status":"completed","model":"gpt-5.3-codex","prompt_cache_key":"${threadId}","safety_buffering":false}}`;
      const service = createService('gpt-5.4');
      const events = await drain(
        service.invoke('served model probe', {
          invocationId: 'invocation-f319-app-server-ws',
          agentCarrierSessionFactory: async () => {
            for (const line of [meta, created, completed]) codexHostServedModels.ingestStderrLine(line);
            return new FakeAppServerWire(threadId);
          },
        }),
      );
      const done = events.find((e) => e.type === 'done');
      assert.ok(done, 'app-server invocation must end with done');
      assert.equal(done.metadata.servedModel, 'gpt-5.3-codex');
      assert.equal(done.metadata.servedModelSource, 'ws_response_object');
      assert.equal(done.metadata.upstreamTurnStateLength, 312);
      assert.equal(done.metadata.upstreamSafetyBufferingFasterModel, 'gpt-5.6-luna');
      assert.equal(done.metadata.upstreamSafetyBuffering, false);
      assert.equal(done.metadata.modelVerified, true);
    });
  });

  test('Phase B.4: observing on the app_server carrier keeps the builtin websocket transport (frames are observable once ANSI is stripped)', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      const threadId = `codex-thread-f319-b4-${Date.now()}`;
      const service = createService('gpt-5.4');
      let launch;
      const events = await drain(
        service.invoke('served model probe', {
          invocationId: 'invocation-f319-app-server-b4',
          agentCarrierSessionFactory: async (sessionOptions) => {
            launch = sessionOptions;
            return new FakeAppServerWire(threadId);
          },
        }),
      );
      assert.ok(
        events.find((e) => e.type === 'done'),
        'app-server invocation must end with done',
      );
      assert.ok(launch, 'session factory must receive the launch options');
      assert.ok(!launch.args.includes('model_provider="openai_https"'), 'observation must not force HTTPS');
      assert.ok(launch.args.includes('model_provider="openai"'), 'OAuth default keeps the builtin (websocket) pin');
      assert.match(launch.env?.RUST_LOG ?? '', /tungstenite::protocol=trace/);
      assert.match(launch.env?.RUST_LOG ?? '', /codex_api::sse::responses=trace/);
    });
  });

  test('Phase B.4: the operator HTTPS rollback is still honoured on the app_server carrier', async () => {
    await withEnv({ ...OBSERVATION_DEFAULT, CAT_CAFE_CODEX_OAUTH_TRANSPORT: 'https' }, async () => {
      const threadId = `codex-thread-f319-b4-https-${Date.now()}`;
      const service = createService('gpt-5.4');
      let launch;
      await drain(
        service.invoke('served model probe', {
          invocationId: 'invocation-f319-app-server-b4-https',
          agentCarrierSessionFactory: async (sessionOptions) => {
            launch = sessionOptions;
            return new FakeAppServerWire(threadId);
          },
        }),
      );
      assert.ok(launch.args.includes('model_provider="openai_https"'), 'operator https transport stays selectable');
      assert.match(launch.env?.RUST_LOG ?? '', /codex_api::sse::responses=trace/);
    });
  });

  test('Phase B.4: ANSI-coloured websocket frames from the real app-server host land turn-state on done', async () => {
    await withEnv(OBSERVATION_DEFAULT, async () => {
      const threadId = `codex-thread-f319-b4-ansi-${Date.now()}`;
      const esc = '\u001b';
      const prefix = `${esc}[2m2026-09-22T03:04:34.790849Z${esc}[0m ${esc}[35mTRACE${esc}[0m ${esc}[2mtungstenite::protocol${esc}[0m${esc}[2m:${esc}[0m Received message `;
      const meta = `${prefix}{"type":"codex.response.metadata","headers":{"x-codex-turn-state":"${'t'.repeat(312)}","x-codex-safety-buffering-enabled":"true","x-codex-safety-buffering-faster-model":"gpt-5.6-luna"}}`;
      const created = `${prefix}{"type":"response.created","response":{"id":"resp_ansi_host","object":"response","status":"in_progress","model":"gpt-5.3-codex","prompt_cache_key":"${threadId}","metadata":{}}}`;
      const service = createService('gpt-5.4');
      const events = await drain(
        service.invoke('served model probe', {
          invocationId: 'invocation-f319-app-server-b4-ansi',
          agentCarrierSessionFactory: async () => {
            for (const line of [meta, created]) codexHostServedModels.ingestStderrLine(line);
            return new FakeAppServerWire(threadId);
          },
        }),
      );
      const done = events.find((e) => e.type === 'done');
      assert.ok(done, 'app-server invocation must end with done');
      assert.equal(done.metadata.servedModel, 'gpt-5.3-codex');
      assert.equal(done.metadata.servedModelSource, 'ws_response_object');
      assert.equal(done.metadata.upstreamTurnStateLength, 312);
    });
  });

  test('Phase B.3: observation off leaves the app_server launch on the operator transport', async () => {
    await withEnv({ ...OBSERVATION_DEFAULT, CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION: 'off' }, async () => {
      const threadId = `codex-thread-f319-b3-off-${Date.now()}`;
      const service = createService('gpt-5.4');
      let launch;
      await drain(
        service.invoke('served model probe', {
          invocationId: 'invocation-f319-app-server-b3-off',
          agentCarrierSessionFactory: async (sessionOptions) => {
            launch = sessionOptions;
            return new FakeAppServerWire(threadId);
          },
        }),
      );
      assert.ok(!launch.args.includes('model_provider="openai_https"'), 'off must not force HTTPS');
      assert.ok(launch.args.includes('model_provider="openai"'), 'OAuth default keeps the builtin pin');
      assert.equal(launch.env?.RUST_LOG, undefined);
    });
  });
});
