import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

const exporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(tracerProvider);
after(async () => {
  await tracerProvider.shutdown();
  trace.disable();
});
const { invokeSingleCat } = await import('../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
const { AcpAgentService } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');
const { AgentSessionBridgeService } = await import(
  '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js'
);
const { AcpSessionProvider } = await import(
  '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js'
);
const { SessionChainStore } = await import('../../dist/domains/cats/services/stores/ports/SessionChainStore.js');
const { toStoredToolEvent } = await import('../../dist/domains/cats/services/agents/routing/route-helpers.js');

function acpService(updates, { workspace = '/tmp', home } = {}) {
  const resumes = [];
  const configOptions = [{ id: 'model', currentValue: 'model', options: [{ value: 'model' }] }];
  const client = {
    isAlive: true,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
      _meta: { antigravity: { systemPrompt: { append: true } } },
    },
    promptCapabilities: {},
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    setSessionPermissionHandler() {},
    newSession: async () => ({ sessionId: 'native', configOptions }),
    resumeSession: async (id) => {
      resumes.push(id);
      return { sessionId: id, configOptions };
    },
    loadSession: async (id) => {
      resumes.push(id);
      return { sessionId: id, configOptions };
    },
    async *promptStream() {
      for (const update of updates) yield { sessionId: 'native', update };
      return 'end_turn';
    },
  };
  const service = new AcpAgentService({
    catId: 'codex',
    providerName: 'fixture-acp',
    modelName: 'model',
    sessionModel: 'model',
    projectRoot: workspace,
    poolKey: { projectPath: workspace, providerProfile: 'test' },
    pool: { acquire: async () => ({ client, release() {}, canResumeRequestedSession: true }), rememberSession() {} },
    ...(home
      ? {
          antigravity: {
            profile: { carrier: 'acp', enabled: true, profileId: 'fixture', model: 'model', autoApprove: true },
            profileHome: home,
            l0CompilerFn: async () => 'CANONICAL-L0',
          },
        }
      : {}),
  });
  return { service, resumes };
}

function consumer(service, plugin, workspace = '/tmp') {
  const inputs = [],
    source = [],
    transcript = [];
  const store = new SessionChainStore();
  const tapped = {
    async *invoke(prompt, options) {
      inputs.push(options);
      for await (const message of service.invoke(prompt, options)) {
        source.push(structuredClone(message));
        yield message;
      }
    },
  };
  const selected = plugin
    ? new AgentSessionBridgeService({
        catId: 'codex',
        metadata: { provider: 'fixture-acp', model: 'model' },
        passHostOptions: true,
        resolveHostSession: (options) => ({
          sessionId: options.hostSessionId ?? 'host',
          resumeNativeSessionId: options.sessionId,
        }),
        provider: new AcpSessionProvider({ catId: 'codex', service: tapped }),
      })
    : tapped;
  let invocation = 0;
  const run = async () =>
    Array.fromAsync(
      invokeSingleCat(
        {
          registry: { create: () => ({ invocationId: `inv-${++invocation}`, callbackToken: 'fixture' }) },
          sessionManager: {
            get: async () => null,
            getOrCreate: async () => ({}),
            store: async () => {},
            resolveWorkingDirectory: () => workspace,
          },
          sessionChainStore: store,
          threadStore: null,
          apiUrl: 'http://127.0.0.1:3162',
          transcriptWriter: { appendEvent: (_session, event) => transcript.push(structuredClone(event)) },
        },
        { catId: 'codex', service: selected, prompt: 'hello', userId: 'user', threadId: 'thread', isLastCat: true },
      ),
    );
  return { inputs, source, transcript, run, record: () => store.getActive('codex', 'thread', 'user') };
}

const answer = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } };
const toolFields = ({
  type,
  toolName,
  toolUseId,
  toolInput,
  toolSource,
  toolRawPayload,
  toolResultStatus,
  content,
}) => ({ type, toolName, toolUseId, toolInput, toolSource, toolRawPayload, toolResultStatus, content });
const usageEvents = (messages) =>
  messages
    .filter((m) => {
      try {
        return m.type === 'system_info' && JSON.parse(m.content).type === 'invocation_usage';
      } catch {
        return false;
      }
    })
    .map((m) => JSON.parse(m.content));

test('AGY ACP binding is committed and reaches the next validated native resume on both paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-binding-consumption-'));
  try {
    const workspace = join(root, 'work'),
      home = join(root, 'profile');
    await mkdir(workspace);
    await mkdir(home);
    const results = [];
    for (const plugin of [false, true]) {
      const { service, resumes } = acpService([answer], { workspace, home });
      const c = consumer(service, plugin, workspace);
      const first = await c.run();
      assert.equal(
        first.some((m) => m.type === 'error'),
        false,
      );
      const binding = c.record().nativeSessionBinding;
      assert.equal(binding?.carrier, 'agy_acp');
      assert.equal(binding.workspaceRoot, await realpath(workspace));
      assert.equal(binding.profileHome, await realpath(home));
      assert.equal(binding.cliSessionId, 'native');
      const second = await c.run();
      assert.equal(
        second.some((m) => m.type === 'error'),
        false,
      );
      assert.deepEqual(c.inputs[1].nativeSessionBinding, binding);
      assert.equal(c.inputs[1].sessionId, 'native');
      assert.deepEqual(resumes, ['native']);
      const rejected = await Array.fromAsync(
        service.invoke('hello', {
          ...c.inputs[1],
          signal: new AbortController().signal,
          nativeSessionBinding: { ...binding, l0Hash: 'mismatched' },
        }),
      );
      assert.ok(rejected.some((m) => m.type === 'error' && m.error.includes('binding differs')));
      assert.deepEqual(resumes, ['native'], 'a mismatched binding must never reach native resume');
      results.push(binding);
    }
    assert.deepEqual(results[1], results[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed native MCP tools retain status and facts in delivery, spans, transcript and tool history', async () => {
  const update = {
    sessionUpdate: 'tool_call',
    toolCallId: 'failed-call',
    toolName: 'mcp__fixture__read_file',
    rawInput: { path: '/tmp/fixture' },
    rawOutput: { error: 'permission denied' },
    content: [{ type: 'text', text: 'permission denied' }],
    _meta: { is_mcp_tool_call: true },
    status: 'failed',
  };
  const results = [];
  for (const plugin of [false, true]) {
    exporter.reset();
    const c = consumer(acpService([update, answer]).service, plugin);
    const delivered = await c.run();
    const tools = delivered.filter((m) => m.type === 'tool_use' || m.type === 'tool_result');
    assert.equal(tools.length, 2);
    assert.equal(tools[1].toolResultStatus, 'error');
    assert.equal(tools[1].toolSource, 'mcp');
    assert.deepEqual(tools[1].toolInput, update.rawInput);
    assert.deepEqual(tools[1].toolRawPayload.rawOutput, update.rawOutput);
    assert.deepEqual(
      c.transcript.filter((m) => m.type === 'tool_use' || m.type === 'tool_result').map(toolFields),
      tools.map(toolFields),
    );
    assert.deepEqual(
      tools.map(toolFields),
      c.source.filter((m) => m.type === 'tool_use' || m.type === 'tool_result').map(toolFields),
    );
    const span = exporter.getFinishedSpans().find((s) => s.attributes['tool.use_id'] === 'failed-call');
    assert.ok(span);
    assert.equal(span.attributes['tool.result.status'], 'error');
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    const stored = toStoredToolEvent(tools[1]);
    assert.equal(stored.status, 'error');
    assert.equal(stored.inputDetail, JSON.stringify(update.rawInput));
    results.push({
      tools: tools.map(toolFields),
      history: { status: stored.status, detail: stored.detail, inputDetail: stored.inputDetail },
    });
  }
  assert.deepEqual(results[1], results[0]);
});

test('usage_update is consumed once and is absent from later thinking and done on both paths', async () => {
  const results = [];
  for (const plugin of [false, true]) {
    const c = consumer(
      acpService([
        answer,
        { sessionUpdate: 'usage_update', used: 85000, size: 100000 },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'trailing thinking' } },
      ]).service,
      plugin,
    );
    const delivered = await c.run();
    const usage = usageEvents(delivered);
    assert.equal(usage.length, 1);
    assert.equal(delivered.findLast((m) => m.type === 'done').metadata?.usage, undefined);
    assert.equal(c.transcript.findLast((m) => m.type === 'done').metadata?.usage, undefined);
    assert.equal(delivered.find((m) => m.content?.includes('trailing thinking')).metadata?.usage, undefined);
    assert.equal(
      c.transcript.some((m) => m.type === 'agent_loop'),
      false,
    );
    results.push(usage);
  }
  assert.deepEqual(results[1], results[0]);
});
