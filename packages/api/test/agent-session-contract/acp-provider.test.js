import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { transformAcpEvent } from '../../dist/domains/cats/services/agents/providers/acp/acp-event-transformer.js';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { registerPluginAgentProvider } from '../../dist/domains/cats/services/agents/session-contract/plugin-agent-provider-registration.js';
import { RegisteredSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { collect, deferred, options } from './fake-session-provider.js';

const message = (type, extra = {}) => ({ catId: 'codex', type, timestamp: 1, ...extra });
function harness(service) {
  const provider = new AcpSessionProvider({ catId: 'codex', service });
  const bridge = new AgentSessionBridgeService({
    catId: 'codex',
    provider,
    passHostOptions: true,
    resolveHostSession: (opts) => ({ sessionId: opts.hostSessionId ?? 'host', resumeNativeSessionId: opts.sessionId }),
  });
  return { provider, bridge };
}
test('adapter options preserve Host fields but override identity, credentials, native id and signal', async () => {
  const calls = [];
  const released = [];
  const service = {
    async *invoke(text, opts) {
      calls.push({ text, opts });
      yield message('session_init', { sessionId: 'bound' });
      yield message('done');
    },
    async releaseSession(id) {
      released.push(id);
    },
  };
  const { provider, bridge } = harness(service);
  const hostOnly = { runtimeInteractionPort: {}, spawnCliOverride: () => {}, systemPrompt: 'identity' };
  const opts = options({ ...hostOnly, sessionId: 'resume', callbackEnv: { token: 'test' } });
  await collect(bridge.invoke('one', opts));
  await collect(bridge.invoke('two', options(hostOnly)));
  assert.equal(calls[0].opts.runtimeInteractionPort, hostOnly.runtimeInteractionPort);
  assert.equal(calls[0].opts.spawnCliOverride, hostOnly.spawnCliOverride);
  assert.equal(calls[0].opts.sessionId, 'resume');
  assert.equal(calls[1].opts.sessionId, 'bound');
  assert.equal(calls[0].opts.invocationId, 'inv');
  assert.equal(calls[0].opts.callbackEnv, opts.callbackEnv);
  assert.ok(calls[0].opts.signal instanceof AbortSignal);
  assert.deepEqual(provider.capabilities(), {
    input: 'unsupported',
    inputReadReceipt: 'unsupported',
    inspectInput: 'unsupported',
    compact: 'unsupported',
    cancelTurn: 'supported',
    observesCompaction: false,
    continuityEvidence: 'none',
  });
  await bridge.releaseAll('disabled');
  await bridge.releaseAll('again');
  assert.deepEqual(released, ['bound']);
  assert.deepEqual(await provider.input(), { status: 'unsupported' });
});
test('adapter rejects deferred, busy and absent sessions; cancellation aborts exact turn', async () => {
  const hold = deferred();
  let signal;
  const { provider } = harness({
    async *invoke(_text, opts) {
      signal = opts.signal;
      await hold.promise;
      yield message('done');
    },
  });
  await provider.openSession({ sessionId: 'host' });
  const input = { invocation: { invocationId: 'inv', callbackEnv: {}, mcpServers: [] }, prompt: { kind: 'deferred' } };
  assert.deepEqual(await provider.startTurn('host', input, new AbortController().signal), {
    ok: false,
    code: 'failed',
    reason: 'deferred_prompt_unsupported',
  });
  input.prompt = { kind: 'frozen', text: 'x' };
  assert.equal((await provider.startTurn('absent', input, new AbortController().signal)).code, 'session_unavailable');
  const started = await provider.startTurn('host', input, new AbortController().signal);
  const run = collect(started.events);
  assert.equal((await provider.startTurn('host', input, new AbortController().signal)).code, 'busy');
  assert.equal((await provider.cancelTurn('host', { invocationId: 'other' })).code, 'turn_ended');
  assert.deepEqual(await provider.cancelTurn('host', { invocationId: 'inv' }), { ok: true });
  assert.equal(signal.aborted, true);
  assert.equal((await run).at(-1).outcome, 'cancelled');
  hold.resolve();
  assert.equal((await provider.cancelTurn('host', { invocationId: 'inv' })).code, 'turn_ended');
});
test('adapter supplies done on EOF; errors/outcomes/metadata/status map as agreed', async () => {
  const { bridge } = harness({
    async *invoke() {
      yield message('session_init', { sessionId: 'native' });
      yield message('text', {
        content: 'snapshot',
        textMode: 'replace',
        metadata: { provider: 'acp', model: 'm', usage: { inputTokens: 2 } },
      });
      yield message('tool_use', { toolName: 'read', toolUseId: 'call', toolInput: { path: 'x' } });
      yield message('tool_result', {
        toolName: 'read',
        toolUseId: 'call',
        content: 'result',
        toolResultStatus: 'error',
      });
      yield message('provider_signal', { content: 'capacity retry warning' });
      yield message('error', { error: 'failed' });
    },
  });
  const messages = await collect(bridge.invoke('x', options()));
  assert.deepEqual(
    messages.map((m) => m.type),
    ['session_init', 'text', 'tool_use', 'tool_result', 'provider_signal', 'error', 'done'],
  );
  assert.equal(messages[1].textMode, 'replace');
  assert.equal(messages[1].metadata.model, 'm');
  assert.equal(messages[3].toolResultStatus, 'error');
  assert.equal(messages[4].content, 'capacity retry warning');
  assert.equal(messages[5].errorCode, 'provider_error');
  assert.equal(messages.at(-1).errorCode, undefined);
});
test('release reports errors; native id absence strips stale Host sessionId', async () => {
  let received;
  const { provider, bridge } = harness({
    async *invoke(_text, opts) {
      received = opts;
      yield message('done');
    },
  });
  await provider.openSession({ sessionId: 'direct' });
  const started = await provider.startTurn(
    'direct',
    {
      prompt: { kind: 'frozen', text: '' },
      invocation: { invocationId: 'inv', callbackEnv: {} },
      hostOptions: { sessionId: 'stale' },
    },
    new AbortController().signal,
  );
  await collect(started.events);
  assert.equal(Object.hasOwn(received, 'sessionId'), false);
  const failing = harness({
    async *invoke() {
      yield message('session_init', { sessionId: 'native' });
      yield message('done', { errorCode: 'e' });
    },
    async releaseSession() {
      throw new Error('close failed');
    },
  });
  assert.equal((await collect(failing.bridge.invoke('x', options()))).at(-1).errorCode, 'e');
  assert.deepEqual(await failing.provider.release('host'), { ok: false, code: 'failed', reason: 'close failed' });
  await bridge.releaseAll('done');
});
test('real ACP transformer replay preserves output, thinking and usage telemetry', async () => {
  const metadata = { provider: 'acp', model: 'fixture' };
  const updates = [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    { sessionUpdate: 'tool_call', toolName: 'read_file', toolInput: { path: '/tmp/test.txt' }, toolCallId: 'call' },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
    { sessionUpdate: 'usage_update', used: 85000, size: 100000 },
  ];
  const native = updates
    .map((update) => transformAcpEvent({ sessionId: 's1', update }, 'codex', structuredClone(metadata)))
    .filter(Boolean);
  const { bridge } = harness({
    async *invoke() {
      yield message('session_init', { sessionId: 's1' });
      yield* native;
      yield message('done');
    },
  });
  const messages = await collect(bridge.invoke('x', options()));
  const fields = (m) => ({
    type: m.type,
    content: m.content,
    toolName: m.toolName,
    toolInput: m.toolInput,
    toolUseId: m.toolUseId,
    errorCode: m.errorCode,
    model: m.metadata?.model,
    usage: m.metadata?.usage,
  });
  for (const original of native)
    assert.deepEqual(fields(messages.find((m) => m.type === original.type)), fields(original));
  for (const type of ['system_info', 'agent_loop']) {
    assert.ok(native.some((m) => m.type === type));
    assert.ok(messages.some((m) => m.type === type));
  }
  assert.equal(
    messages.some((m) => m.type === 'status'),
    false,
  );
});
test(
  'reference ACP subprocess: factory → adapter → bridge, two turns + resume + cancel',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-reference-'));
    const pools = new Map();
    const previousMode = process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
    // The transport fixture does not attest trust in the host machine's Temp ancestors.
    if (process.platform === 'win32') process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
    try {
      const service = await createAcpServiceForConfig({
        projectRoot: root,
        bootstrapRoot: join(root, 'bootstrap'),
        profileId: 'codex',
        config: {
          id: 'codex',
          clientId: 'acp',
          defaultModel: 'fixture',
          mcpSupport: false,
          configurationSource: 'native_tool',
        },
        effectiveModel: '',
        acpConfig: {
          command: 'node',
          startupArgs: [
            fileURLToPath(new URL('../fixtures/agent-session-reference/fake-acp-agent.mjs', import.meta.url)),
          ],
        },
        poolRegistry: pools,
        log: { info() {}, warn() {} },
      });
      assert.ok(service);
      const { provider } = harness(service);
      const registry = new SessionImplementationRegistry();
      const registration = registerPluginAgentProvider(registry, {
        pluginId: 'local.agent-session-reference',
        declaration: { id: 'agent', transport: 'acp', acp: { command: 'node', startupArgs: [] } },
        createProvider: () => provider,
      });
      const bridge = new RegisteredSessionAgentService({
        catId: 'codex',
        registry,
        ref: { pluginId: 'local.agent-session-reference', contributionId: 'agent' },
      });
      const first = await collect(bridge.invoke('first', options({ hostSessionId: 'host' })));
      const id = first.find((m) => m.type === 'session_init').sessionId;
      const second = await collect(bridge.invoke('second #tool', options({ hostSessionId: 'host' })));
      assert.ok(second.some((m) => m.content?.includes('previous=first')));
      assert.ok(second.some((m) => m.type === 'tool_use'));
      const resumed = await collect(bridge.invoke('resumed', options({ hostSessionId: 'new-host', sessionId: id })));
      assert.ok(resumed.some((m) => m.content?.includes('previous=second #tool')));
      const controller = new AbortController();
      const iterator = bridge
        .invoke('#wait', options({ hostSessionId: 'host', signal: controller.signal }))
        [Symbol.asyncIterator]();
      let next;
      do {
        next = await iterator.next();
      } while (!next.done && next.value.content !== 'waiting');
      assert.equal(next.done, false);
      controller.abort();
      const rest = await collect(iterator);
      assert.equal(rest.at(-1).errorCode, 'cancelled');
      await bridge.releaseAll('test_complete');
      registration.unregister();
    } finally {
      await Promise.all([...pools.values()].map((pool) => pool.closeAll()));
      if (previousMode === undefined) delete process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
      else process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = previousMode;
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test('return before first event consumption clears active turn and abort link', async () => {
  let invokes = 0;
  const { provider } = harness({
    async *invoke() {
      invokes++;
      yield message('done');
    },
  });
  await provider.openSession({ sessionId: 'host' });
  const input = { invocation: { invocationId: 'inv', callbackEnv: {} }, prompt: { kind: 'frozen', text: '' } };
  const controller = new AbortController();
  const first = await provider.startTurn('host', input, controller.signal);
  controller.abort();
  await first.events[Symbol.asyncIterator]().return();
  const second = await provider.startTurn('host', input, new AbortController().signal);
  assert.equal(second.ok, true);
  await collect(second.events);
  assert.equal(invokes, 1);
});

test('member/account revision refreshes the Host ACP factory while retaining provider identity', async () => {
  const { createRefreshingAcpSessionProvider } = await import(
    '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js'
  );
  let revision = 1;
  let creations = 0;
  const provider = createRefreshingAcpSessionProvider({
    catId: 'codex',
    scope: {},
    revision: () => revision,
    createService: async () => {
      creations++;
      const model = `model-${revision}`;
      return {
        async *invoke() {
          yield message('text', { content: 'ok', metadata: { provider: 'acp', model } });
          yield message('done');
        },
      };
    },
  });
  const bridge = new AgentSessionBridgeService({
    catId: 'codex',
    provider,
    passHostOptions: true,
    resolveHostSession: () => ({ sessionId: 'host' }),
  });
  await collect(bridge.invoke('one', options()));
  await collect(bridge.invoke('two', options()));
  assert.equal(creations, 1);
  revision++;
  const refreshed = await collect(bridge.invoke('three', options()));
  assert.equal(creations, 2);
  assert.equal(refreshed[0].metadata.model, 'model-2');
  await bridge.releaseAll('done');
});

test(
  'reference HTTP mode POSTs only sessionId/text through a mocked fetch (no HTTP server)',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-http-'));
    const pools = new Map();
    const previousMode = process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
    // This case tests HTTP payload projection, not trust in the machine's Temp ancestors.
    // Native strict-mode rejection remains covered by acp-bootstrap-strict-native.test.ts.
    if (process.platform === 'win32') process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
    try {
      const preload = join(root, 'mock-fetch.mjs');
      await writeFile(
        preload,
        `globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (url !== 'https://fixture.invalid/agent' || options.method !== 'POST' || Object.keys(body).sort().join() !== 'sessionId,text') throw new Error('invalid HTTP handoff');
      return { json: async () => ({ text: 'HTTP:' + body.text }) };
    };`,
      );
      const service = await createAcpServiceForConfig({
        projectRoot: root,
        bootstrapRoot: join(root, 'bootstrap'),
        profileId: 'codex',
        config: {
          id: 'codex',
          clientId: 'acp',
          defaultModel: 'fixture',
          mcpSupport: false,
          configurationSource: 'native_tool',
        },
        effectiveModel: '',
        acpConfig: {
          command: 'node',
          startupArgs: [
            '--import',
            pathToFileURL(preload).href,
            fileURLToPath(new URL('../fixtures/agent-session-reference/fake-acp-agent.mjs', import.meta.url)),
            '--http',
            'https://fixture.invalid/agent',
          ],
        },
        poolRegistry: pools,
        log: { info() {}, warn() {} },
      });
      const { bridge } = harness(service);
      const messages = await collect(bridge.invoke('question', options()));
      assert.ok(messages.some((m) => m.content === 'HTTP:question'));
      await bridge.releaseAll('done');
    } finally {
      await Promise.all([...pools.values()].map((pool) => pool.closeAll()));
      if (previousMode === undefined) delete process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
      else process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = previousMode;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('configuration refresh and plugin replacement serialize factories in the same Host pool scope', async () => {
  const { createRefreshingAcpSessionProvider } = await import(
    '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js'
  );
  const scope = {};
  const gate = deferred();
  const entered = deferred();
  let builds = 0;
  let revision = 1;
  const service = {
    async *invoke() {
      yield message('done');
    },
  };
  const createService = async () => {
    builds++;
    if (builds === 1) {
      entered.resolve();
      await gate.promise;
    }
    return service;
  };
  const make = () =>
    createRefreshingAcpSessionProvider({ catId: 'codex', scope, revision: () => revision, createService });
  const bridge = (provider) =>
    new AgentSessionBridgeService({
      catId: 'codex',
      provider,
      resolveHostSession: (opts) => ({ sessionId: opts.hostSessionId }),
    });
  const old = bridge(make());
  const first = collect(old.invoke('old', options({ hostSessionId: 'old' })));
  await entered.promise;
  revision++;
  const fresh = bridge(make());
  const second = collect(fresh.invoke('new', options({ hostSessionId: 'new' })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(builds, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(builds, 2);
  await old.releaseAll('done');
  await fresh.releaseAll('done');
});

test('startTurn calls invoke before returning without consuming the returned iterable, including no hostOptions', async () => {
  const calls = [];
  let iterations = 0;
  const { provider } = harness({
    invoke(text, opts) {
      calls.push({ text, opts });
      return {
        async *[Symbol.asyncIterator]() {
          iterations++;
          yield message('done');
        },
      };
    },
  });
  await provider.openSession({ sessionId: 'host', resume: { nativeSessionId: 'resume' } });
  const input = {
    invocation: { invocationId: 'inv', callbackEnv: { token: 'host' } },
    prompt: { kind: 'frozen', text: 'x' },
  };
  assert.equal((await provider.startTurn('absent', input, new AbortController().signal)).code, 'session_unavailable');
  assert.equal(
    (await provider.startTurn('host', { ...input, prompt: { kind: 'deferred' } }, new AbortController().signal)).code,
    'failed',
  );
  assert.equal(calls.length, 0);
  const started = await provider.startTurn('host', input, new AbortController().signal);
  assert.equal(started.ok, true);
  assert.equal((await provider.startTurn('host', input, new AbortController().signal)).code, 'busy');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'x');
  assert.equal(calls[0].opts.invocationId, 'inv');
  assert.equal(calls[0].opts.callbackEnv, input.invocation.callbackEnv);
  assert.equal(calls[0].opts.sessionId, 'resume');
  assert.ok(calls[0].opts.signal instanceof AbortSignal);
  assert.equal(iterations, 0);
  await started.events[Symbol.asyncIterator]().return();
  assert.equal(calls[0].opts.signal.aborted, true);
  assert.equal(iterations, 0);
});

test('a synchronously throwing invoke leaves no busy turn', async () => {
  let fail = true;
  const { provider } = harness({
    invoke() {
      if (fail) throw new Error('sync invoke failed');
      return {
        async *[Symbol.asyncIterator]() {
          yield message('done');
        },
      };
    },
  });
  await provider.openSession({ sessionId: 'host' });
  const input = { invocation: { invocationId: 'inv', callbackEnv: {} }, prompt: { kind: 'frozen', text: 'x' } };
  await assert.rejects(provider.startTurn('host', input, new AbortController().signal), /sync invoke failed/);
  fail = false;
  const started = await provider.startTurn('host', input, new AbortController().signal);
  assert.equal(started.ok, true);
  await collect(started.events);
});

test('reopening preserves native_bound and active turns; an explicit resume overrides native id', async () => {
  const calls = [];
  const { provider } = harness({
    invoke(_text, opts) {
      calls.push(opts);
      return {
        async *[Symbol.asyncIterator]() {
          yield message('session_init', { sessionId: 'bound' });
          yield message('done');
        },
      };
    },
  });
  const input = { invocation: { invocationId: 'inv', callbackEnv: {} }, prompt: { kind: 'frozen', text: 'x' } };
  const start = () => provider.startTurn('host', input, new AbortController().signal);
  await provider.openSession({ sessionId: 'host' });
  await collect((await start()).events);
  assert.deepEqual(await provider.openSession({ sessionId: 'host' }), {
    ok: true,
    binding: { state: 'pending_first_input' },
  });
  const second = await start();
  assert.equal(calls[1].sessionId, 'bound');
  await provider.openSession({ sessionId: 'host' });
  assert.equal((await start()).code, 'busy');
  await collect(second.events);
  await provider.openSession({ sessionId: 'host', resume: { nativeSessionId: 'replacement' } });
  const third = await start();
  assert.equal(calls[2].sessionId, 'replacement');
  await collect(third.events);
  const fourth = await start();
  assert.equal(calls[3].sessionId, 'bound');
  await collect(fourth.events);
});
