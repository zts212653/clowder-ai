import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({
  resumeFails = false,
  replacement = false,
  empty = false,
  capability = true,
  stopReason = 'end_turn',
  providerError = false,
  wrongModel = false,
  mcpServers = [],
  onResume = () => {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agy-acp-integration-'));
  roots.push(root);
  const workspace = join(root, 'work');
  const home = join(root, 'profile');
  mkdirSync(workspace);
  mkdirSync(home);
  const calls = [];
  const configOptions = [
    {
      id: 'model',
      currentValue: wrongModel ? 'other-model' : 'model',
      options: [{ value: wrongModel ? 'other-model' : 'model' }],
    },
  ];
  const client = {
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
      _meta: { antigravity: { systemPrompt: { append: capability } } },
    },
    promptCapabilities: {},
    newSession: async (...args) => {
      calls.push(['new', ...args]);
      return { sessionId: 'acp-original', configOptions };
    },
    loadSession: async (...args) => {
      calls.push(['load', ...args]);
      if (resumeFails) throw new Error('trajectory missing');
      return { sessionId: replacement ? 'replacement' : args[0], configOptions };
    },
    resumeSession: async (...args) => {
      calls.push(['resume', ...args]);
      onResume(args);
      if (resumeFails) throw new Error('trajectory missing');
      return { sessionId: replacement ? 'replacement' : args[0], configOptions };
    },
    setSessionConfigOption: async (...args) => calls.push(['model', ...args]),
    setSessionPermissionHandler: (...args) => calls.push(['permission', ...args]),
    cancelSession: (...args) => calls.push(['cancel', ...args]),
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    recentCapacitySignal: null,
    async *promptStream(id, input) {
      calls.push(['prompt', id, input]);
      if (!empty)
        yield {
          sessionId: id,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' } },
        };
      if (providerError) throw new Error('AGY ACP provider execution failed (session-scoped stderr diagnostic)');
      return stopReason;
    },
  };
  const pool = {
    acquire: async () => ({ client, release: () => calls.push(['release']), canResumeRequestedSession: true }),
    rememberSession() {},
    release: () => calls.push(['release']),
  };
  const service = new AcpAgentService({
    catId: 'gemini-argon',
    pool,
    poolKey: { projectPath: workspace, providerProfile: 'argon' },
    projectRoot: workspace,
    providerName: 'google',
    modelName: 'model',
    sessionModel: 'model',
    mcpServers,
    antigravity: {
      profile: { carrier: 'acp', enabled: true, profileId: 'argon', model: 'model', autoApprove: true },
      profileHome: home,
      l0CompilerFn: async () => 'CANONICAL-L0-NONCE',
    },
  });
  const options = {
    workingDirectory: workspace,
    auditContext: { userId: 'owner', threadId: 'thread', invocationId: 'invocation', catId: 'gemini-argon' },
  };
  return { service, calls, options, workspace, home };
}

test('AGY ACP sends canonical L0 in native metadata and keeps the user body clean', async () => {
  const f = fixture();
  assert.equal(f.service.injectsL0Natively?.(), true);
  const events = await Array.fromAsync(f.service.invoke('USER-BODY', f.options));
  const setup = f.calls.find(([name]) => name === 'new');
  assert.equal(setup[3].antigravity.systemPrompt.append, 'CANONICAL-L0-NONCE');
  assert.equal(f.calls.find(([name]) => name === 'prompt')[2], 'USER-BODY');
  const binding = events.find((e) => e.type === 'session_init').nativeSessionBinding;
  assert.equal(binding.carrier, 'agy_acp');
  assert.equal(binding.cliSessionId, 'acp-original');
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
  assert.deepEqual(f.service.freshnessCarrierCapability(), {
    provider: 'google',
    carrier: 'agy_acp',
    deliverySemantics: 'unsupported',
    activeInvocationGuidance: 'unsupported',
  });
});

test('AGY ACP cold resumes the original id with identity metadata every time', async () => {
  const f = fixture();
  const first = await Array.fromAsync(f.service.invoke('first', f.options));
  const binding = first.find((e) => e.nativeSessionBinding).nativeSessionBinding;
  f.calls.length = 0;
  const second = await Array.fromAsync(
    f.service.invoke('second', { ...f.options, sessionId: 'acp-original', nativeSessionBinding: binding }),
  );
  assert.equal(
    second.some((e) => e.type === 'error'),
    false,
  );
  const setup = f.calls.find(([name]) => name === 'resume');
  assert.equal(setup[1], 'acp-original');
  assert.equal(setup[4].antigravity.systemPrompt.append, 'CANONICAL-L0-NONCE');
  assert.equal(
    f.calls.some(([name]) => name === 'new'),
    false,
  );
});

test('AGY ACP refuses old CLI ids before any provider session or prompt', async () => {
  const f = fixture();
  const events = await Array.fromAsync(f.service.invoke('must not run', { ...f.options, sessionId: 'old-cli-id' }));
  assert.equal(
    events.some((e) => e.type === 'error'),
    true,
  );
  assert.equal(
    f.calls.some(([name]) => ['new', 'load', 'resume', 'prompt'].includes(name)),
    false,
  );
});

for (const mode of ['resumeFails', 'replacement', 'empty'])
  test(`AGY ACP ${mode} never replays on a fresh session`, async () => {
    const firstFixture = fixture();
    const first = await Array.fromAsync(firstFixture.service.invoke('first', firstFixture.options));
    const f = fixture({ [mode]: true });
    const binding = {
      ...first.find((e) => e.nativeSessionBinding)?.nativeSessionBinding,
      workspaceRoot: f.workspace,
      profileHome: f.home,
    };
    const events = await Array.fromAsync(
      f.service.invoke('second', { ...f.options, sessionId: 'acp-original', nativeSessionBinding: binding }),
    );
    assert.equal(
      events.some((e) => e.type === 'error'),
      true,
    );
    assert.equal(
      f.calls.some(([name]) => name === 'new'),
      false,
    );
    assert.ok(f.calls.filter(([name]) => name === 'prompt').length <= 1);
    assert.equal(events.filter((e) => e.type === 'done').length, 1);
  });

test('AGY ACP without advertised system append refuses before model work', async () => {
  const f = fixture({ capability: false });
  const events = await Array.fromAsync(f.service.invoke('must not run', f.options));
  assert.equal(
    events.some((e) => e.type === 'error'),
    true,
  );
  assert.equal(
    f.calls.some(([name]) => ['new', 'prompt'].includes(name)),
    false,
  );
});

test('AGY ACP refuses an unavailable configured model before sending the user body', async () => {
  const f = fixture({ wrongModel: true });
  const events = await Array.fromAsync(f.service.invoke('must not run on another model', f.options));
  assert.equal(
    events.some((e) => e.type === 'error'),
    true,
  );
  assert.equal(
    f.calls.some(([name]) => name === 'prompt'),
    false,
  );
});

for (const mode of [{ stopReason: 'cancelled' }, { stopReason: 'refusal' }, { providerError: true }])
  test(`AGY ACP reports provider failure honestly: ${JSON.stringify(mode)}`, async () => {
    const f = fixture(mode);
    const events = await Array.fromAsync(f.service.invoke('work', f.options));
    assert.equal(
      events.some((e) => e.type === 'error'),
      true,
    );
    assert.equal(events.filter((e) => e.type === 'done').length, 1);
    assert.equal(f.calls.filter(([name]) => name === 'prompt').length, 1);
  });

test('AGY ACP refreshes principal credentials before resume and passes only their file to host MCP', async () => {
  let seen;
  const f = fixture({
    mcpServers: [{ name: 'cat-cafe-memory', command: process.execPath, args: [], env: [] }],
    onResume: (args) => {
      const path = args[2][0].env.find((entry) => entry.name === 'CAT_CAFE_CREDENTIAL_FILE').value;
      seen = JSON.parse(readFileSync(path, 'utf8'));
    },
  });
  const previous = process.env.CAT_CAFE_MCP_CREDS_DIR;
  process.env.CAT_CAFE_MCP_CREDS_DIR = f.home;
  const callbackEnv = {
    CAT_CAFE_API_URL: 'http://127.0.0.1:3102',
    CAT_CAFE_THREAD_ID: 'thread-credential',
    CAT_CAFE_CAT_ID: 'gemini-argon',
    CAT_CAFE_INVOCATION_ID: 'first',
    CAT_CAFE_CALLBACK_TOKEN: 'synthetic-first',
  };
  try {
    const events = await Array.fromAsync(f.service.invoke('first', { ...f.options, callbackEnv }));
    const setup = f.calls.find(([name]) => name === 'new');
    assert.equal(
      setup[2][0].env.some((entry) => ['CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN'].includes(entry.name)),
      false,
    );
    const binding = events.find((event) => event.nativeSessionBinding).nativeSessionBinding;
    await Array.fromAsync(
      f.service.invoke('second', {
        ...f.options,
        sessionId: 'acp-original',
        nativeSessionBinding: binding,
        callbackEnv: { ...callbackEnv, CAT_CAFE_INVOCATION_ID: 'second', CAT_CAFE_CALLBACK_TOKEN: 'synthetic-second' },
      }),
    );
    assert.equal(seen.invocationId, 'second');
  } finally {
    if (previous === undefined) delete process.env.CAT_CAFE_MCP_CREDS_DIR;
    else process.env.CAT_CAFE_MCP_CREDS_DIR = previous;
  }
});
