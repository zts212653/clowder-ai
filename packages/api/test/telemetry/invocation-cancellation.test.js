import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
process.env.NODE_ENV = 'test';
const logDir = await mkdtemp(join(tmpdir(), 'cancel-observations-'));
process.env.LOG_DIR = logDir;
const require = createRequire(`${root}/packages/api/package.json`);
const { catRegistry } = await import(pathToFileURL(`${root}/packages/shared/dist/index.js`));
const metricCalls = [];
const { metrics, trace, SpanStatusCode } = require('@opentelemetry/api');
const { NodeTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-node');
const exporter = new InMemorySpanExporter();
const traceProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
traceProvider.register();
metrics.setGlobalMeterProvider({
  getMeter() {
    const instrument = (name) => ({
      add: (value, attributes) => metricCalls.push({ name, value, attributes }),
      record() {},
      addCallback() {},
      removeCallback() {},
    });
    return {
      createCounter: instrument,
      createUpDownCounter: instrument,
      createHistogram: instrument,
      createObservableGauge: instrument,
      createObservableCounter: instrument,
      createObservableUpDownCounter: instrument,
      addBatchObservableCallback() {},
      removeBatchObservableCallback() {},
    };
  },
});
const load = (path) => import(pathToFileURL(`${root}/packages/api/dist/${path}.js`));
const { AcpClient, AcpProtocolError } = await load('domains/cats/services/agents/providers/acp/AcpClient');
const { AcpAgentService } = await load('domains/cats/services/agents/providers/acp/AcpAgentService');
const { ClaudeAgentService } = await load('domains/cats/services/agents/providers/ClaudeAgentService');
const { CodexAgentService } = await load('domains/cats/services/agents/providers/CodexAgentService');
const { routeSerial } = await load('domains/cats/services/agents/routing/route-serial');
const { InvocationTracker } = await load('domains/cats/services/agents/invocation/InvocationTracker');
const { MessageStore } = await load('domains/cats/services/stores/ports/MessageStore');
const { logger, LOG_DIR_PATH } = await load('infrastructure/logger');
const runId = randomUUID().slice(0, 8);
async function logsFor(catId, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const lines = await readFile(join(LOG_DIR_PATH, 'api.log'), 'utf8').catch(() => '');
    const logs = lines
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    if (logs.some((l) => l.catId === catId && l.msg === message)) return logs;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`No flushed ${message} log for ${catId}`);
}
const { appendTestLifecycleResponseSource } = await import(
  pathToFileURL(`${root}/packages/api/test/helpers/message-from-fixtures.js`)
);
const { fakeL0Compiler } = await import(pathToFileURL(`${root}/packages/api/test/helpers/fake-l0-compiler.js`));

const noop = () => {};
const rawArchive = { append: async () => {} };
async function waitAbort(signal) {
  if (signal.aborted) return;
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}
async function acp(profile, catId) {
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough(),
    events = new EventEmitter();
  const wire = [];
  const child = {
    pid: 12345,
    stdin,
    stdout,
    stderr,
    killed: false,
    on: events.on.bind(events),
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events),
    kill() {
      this.killed = true;
      stdout.end();
      events.emit('exit', 0, null);
      return true;
    },
  };
  stdin.on('data', (buf) => {
    for (const line of buf.toString().trim().split('\n')) {
      const m = JSON.parse(line);
      wire.push(m.method);
      if (m.method === 'initialize')
        setImmediate(() =>
          stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: m.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true },
                agentInfo: { name: profile, version: 'fixture' },
              },
            }) + '\n',
          ),
        );
      else if (m.method === 'session/new')
        setImmediate(() =>
          stdout.write(
            JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { sessionId: `${catId}-native`, configOptions: [] } }) +
              '\n',
          ),
        );
      else if (m.method === 'session/prompt')
        setImmediate(() =>
          stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: m.params.sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'waiting' } },
              },
            }) + '\n',
          ),
        );
    }
  });
  const client = new AcpClient({ command: 'protocol-fixture', args: [], cwd: root, spawnFn: () => child });
  await client.initialize();
  const poolKey = { projectPath: root, providerProfile: catId };
  let releases = 0;
  const service = new AcpAgentService({
    catId,
    providerName: profile,
    modelName: '',
    projectRoot: root,
    mcpSupport: false,
    poolKey,
    pool: {
      async acquire() {
        return {
          client,
          poolKey,
          release() {
            releases++;
          },
        };
      },
    },
  });
  service.l0CompilerFn = fakeL0Compiler;
  return { service, wire, releaseCount: () => releases, close: () => client.close() };
}
async function fixture(profile, catId) {
  catRegistry.register(catId, {
    ...catRegistry.tryGet('codex').config,
    id: catId,
    name: catId,
    displayName: catId,
    mentionPatterns: [`@${catId}`],
    cli: { effort: '' },
    clientId: { gemini: 'google', opencode: 'opencode', claude: 'anthropic', codex: 'openai' }[profile],
    configurationSource: 'native_tool',
    defaultModel: '',
    mcpSupport: false,
  });
  if (profile === 'gemini' || profile === 'opencode') return acp(profile, catId);
  const native =
    profile === 'claude'
      ? new ClaudeAgentService({ catId, model: 'fixture', rawArchive, l0CompilerFn: fakeL0Compiler })
      : new CodexAgentService({
          catId,
          model: 'fixture',
          cliCommand: process.execPath,
          carrierMode: 'exec_json',
          rawArchive,
          l0CompilerFn: fakeL0Compiler,
        });
  const service = {
    l0CompilerFn: fakeL0Compiler,
    invoke(text, options) {
      return native.invoke(text, {
        ...options,
        spawnCliOverride: async function* (launch) {
          if (profile === 'claude')
            yield { type: 'assistant', message: { content: [{ type: 'text', text: 'waiting' }] } };
          else yield { type: 'item.completed', item: { id: 'item', type: 'agent_message', text: 'waiting' } };
          await waitAbort(launch.signal);
        },
      });
    },
  };
  return { service, close: async () => {} };
}

await test('#1672 cancellation observations', async (t) => {
  t.after(async () => {
    await traceProvider.shutdown();
    trace.disable();
    metrics.disable();
    await new Promise((resolve) => logger.flush(resolve));
    await rm(logDir, { recursive: true, force: true });
  });
  for (const profile of ['gemini', 'opencode']) {
    await t.test(
      `#1672 ${profile}: explicit user cancel releases once without failure events or error logs`,
      async () => {
        const catId = `cancel-direct-${profile}-${runId}`,
          h = await fixture(profile, catId),
          controller = new AbortController(),
          messages = [];
        try {
          const iterator = h.service.invoke('wait', { signal: controller.signal })[Symbol.asyncIterator]();
          while (true) {
            const n = await iterator.next();
            assert.equal(n.done, false);
            messages.push(n.value);
            if (n.value.type === 'text') break;
          }
          const next = iterator.next();
          controller.abort('user_cancel');
          const n = await next;
          if (!n.done) messages.push(n.value);
          for await (const m of iterator) messages.push(m);
          assert.ok(h.wire.includes('session/cancel'));
          assert.equal(h.releaseCount(), 1);
          assert.equal(
            messages.filter((m) => m.type === 'error').length,
            0,
            'expected cancellation is not a provider failure',
          );
          await new Promise((resolve) => logger.flush(resolve));
          const logs = await logsFor(catId, 'ACP invocation locally cancelled; provider termination unconfirmed');
          const failures = logs.filter(
            (l) => l.level >= 50 && (l.catId === catId || JSON.stringify(l).includes(`${catId}-native`)),
          );
          assert.deepEqual(failures, [], 'expected cancellation must not log level 50');
        } finally {
          await h.close();
        }
      },
    );
  }
  for (const profile of ['gemini', 'opencode', 'claude', 'codex']) {
    await t.test(`#1672 ${profile}: routed user cancel is counted once as canceled`, async () => {
      const catId = `cancel-route-${profile}-${runId}`,
        threadId = catId,
        h = await fixture(profile, catId),
        tracker = new InvocationTracker(),
        batch = tracker.startAll(threadId, [catId], 'fixture');
      const store = new MessageStore();
      let stopped = false,
        responseId;
      const deps = {
        services: { [catId]: h.service },
        invocationDeps: {
          registry: {
            create: () => ({ invocationId: `${catId}-turn`, callbackToken: 'fixture' }),
            verify: () => ({ ok: false }),
          },
          sessionManager: { get: async () => null, getOrCreate: async () => ({}), resolveWorkingDirectory: () => root },
          threadStore: {
            get: async () => ({ id: threadId, userId: 'fixture', projectPath: root }),
            getParticipantsWithActivity: async () => [],
            consumeMentionRoutingFeedback: async () => null,
            updateParticipantActivity: async () => {},
          },
          apiUrl: 'http://fixture.invalid',
        },
        messageStore: store,
        draftStore: { delete: async () => {}, touch: async () => {}, upsert: async () => {} },
        toolEventLog: { append: async () => {}, updateSummary: async () => {} },
        socketManager: { broadcastToRoom: noop },
      };
      try {
        for await (const message of routeSerial(deps, [catId], 'wait', 'fixture', threadId, {
          signal: batch.signal,
          signalForCat: () => tracker.getController(threadId, catId)?.signal,
          onLifecycleInvocationStarted: async (input) => {
            const row = await appendTestLifecycleResponseSource(store, { ...input, timestamp: input.startedAt });
            responseId = row.id;
            return {
              responseMessageId: row.id,
              priorFrontierMessageId: null,
              activeRun: {
                threadId,
                targetId: catId,
                invocationId: input.invocationId,
                responseMessageId: row.id,
                inputEntryIds: [],
                inputMessageIds: [],
                privateInputEntryIds: [],
                startedAt: input.startedAt,
              },
            };
          },
        })) {
          if (message.type === 'text' && message.content === 'waiting' && !stopped) {
            stopped = true;
            setImmediate(() => tracker.cancel(threadId, catId, 'fixture', 'user_cancel'));
          }
        }
        assert.equal(stopped, true);
        assert.equal(store.getById(responseId).lifecycle.status, 'canceled');
        // The aborted router does not await the invocation iterator's async finally.
        for (
          let i = 0;
          i < 20 &&
          !metricCalls.some((x) => x.name === 'cat_cafe.invocation.completed' && x.attributes['agent.id'] === catId);
          i++
        )
          await new Promise((resolve) => setImmediate(resolve));
        const calls = metricCalls.filter(
          (x) => x.name === 'cat_cafe.invocation.completed' && x.attributes['agent.id'] === catId,
        );
        assert.equal(calls.length, 1);
        assert.equal(calls[0].attributes.status, 'canceled');
        await traceProvider.forceFlush();
        const span = exporter
          .getFinishedSpans()
          .find((s) => s.name === 'cat_cafe.invocation' && s.attributes['agent.id'] === catId);
        assert.ok(span);
        assert.equal(span.status.code, SpanStatusCode.UNSET);
        assert.equal(span.attributes.status, 'canceled');
      } finally {
        await h.close();
      }
    });
  }
  await t.test('#1672 protocol failures remain failures, even beside an owner Stop', async () => {
    const controller = new AbortController();
    const catId = `protocol-${runId}`;
    const client = {
      onCapacity() {},
      offCapacity() {},
      newSession: async () => ({ sessionId: 'protocol', configOptions: [] }),
      cancelSession() {},
      clearRecentCapacitySignal() {},
      recentCapacitySignal: null,
      async *promptStream() {
        yield { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } };
        controller.abort('user_cancel');
        throw new AcpProtocolError(-32603, 'bad protocol');
      },
    };
    const service = new AcpAgentService({
      catId,
      providerName: 'gemini',
      modelName: '',
      projectRoot: root,
      mcpSupport: false,
      poolKey: { projectPath: root, providerProfile: catId },
      pool: { acquire: async () => ({ client, release() {} }) },
    });
    const messages = [];
    for await (const msg of service.invoke('fail', { signal: controller.signal })) messages.push(msg);
    assert.equal(messages.find((m) => m.type === 'error')?.errorCode, 'prompt_failure');
    const logs = await logsFor(catId, 'ACP prompt failure');
    assert.ok(logs.some((l) => l.catId === catId && l.level === 50));
  });

  const { invokeSingleCat } = await load('domains/cats/services/agents/invocation/invoke-single-cat');
  const { MEMBER_TIMEOUT_REASON } = await load('domains/cats/services/agents/invocation/member-output-timeout');
  for (const reason of [undefined, 'unknown_abort', MEMBER_TIMEOUT_REASON]) {
    await t.test(`#1672 non-owner interruption ${reason ?? 'iterator.return'} remains error`, async () => {
      const catId = `unexpected-${String(reason)}-${runId}`,
        h = await fixture('codex', catId),
        controller = new AbortController();
      const deps = {
        registry: {
          create: () => ({ invocationId: `${catId}-turn`, callbackToken: 'fixture' }),
          verify: () => ({ ok: false }),
        },
        sessionManager: { get: async () => null, getOrCreate: async () => ({}), resolveWorkingDirectory: () => root },
        threadStore: null,
        apiUrl: 'http://fixture.invalid',
      };
      const iterator = invokeSingleCat(deps, {
        catId,
        service: h.service,
        prompt: 'wait',
        userId: 'fixture',
        threadId: catId,
        isLastCat: true,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await iterator.next();
          assert.equal(next.done, false);
          if (next.value.type === 'text') break;
        }
        if (reason !== undefined) controller.abort(reason);
        await iterator.return();
        const calls = metricCalls.filter(
          (x) => x.name === 'cat_cafe.invocation.completed' && x.attributes['agent.id'] === catId,
        );
        assert.equal(calls.length, 1);
        assert.equal(calls[0].attributes.status, 'error');
        await traceProvider.forceFlush();
        const span = exporter
          .getFinishedSpans()
          .find((s) => s.name === 'cat_cafe.invocation' && s.attributes['agent.id'] === catId);
        assert.ok(span);
        assert.equal(span.status.code, SpanStatusCode.ERROR);
      } finally {
        await h.close();
      }
    });
  }
  await t.test('#1672 an unowned cancellation error is not recorded as success', async () => {
    const catId = `unowned-cancel-${runId}`,
      h = await fixture('codex', catId);
    const service = {
      ...h.service,
      async *invoke() {
        yield {
          type: 'error',
          catId,
          errorCode: 'INVOCATION_CANCELLED',
          error: 'unexpected abort',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId, timestamp: Date.now() };
      },
    };
    const deps = {
      registry: {
        create: () => ({ invocationId: `${catId}-turn`, callbackToken: 'fixture' }),
        verify: () => ({ ok: false }),
      },
      sessionManager: { get: async () => null, getOrCreate: async () => ({}), resolveWorkingDirectory: () => root },
      threadStore: null,
      apiUrl: 'http://fixture.invalid',
    };
    for await (const _ of invokeSingleCat(deps, {
      catId,
      service,
      prompt: 'test',
      userId: 'fixture',
      threadId: catId,
      isLastCat: true,
    })) {
    }
    const calls = metricCalls.filter(
      (x) => x.name === 'cat_cafe.invocation.completed' && x.attributes['agent.id'] === catId,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].attributes.status, 'error');
    await h.close();
  });
});
