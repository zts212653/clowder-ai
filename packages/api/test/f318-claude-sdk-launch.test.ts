import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';

test('launch preserves resume, account isolation, native identity and managed F296 settings', async () => {
  const { prepareClaudeSdkLaunch } = await import('../src/domains/cats/services/agents/providers/claude-sdk-launch.js');
  const { buildClaudeCompactionLaunchPlan } = await import(
    '../src/domains/cats/services/agents/providers/claude-compaction-launch-plan.js'
  );
  const plan = buildClaudeCompactionLaunchPlan();
  assert.equal(plan.ready, true);
  let recorded: import('../src/domains/cats/services/types.js').PreparedProviderRequestV1 | undefined;
  const prepared = await prepareClaudeSdkLaunch({
    catId: createCatId('opus'),
    model: 'claude-opus-4-6',
    prompt: 'actual task',
    l0CompilerFn: async () => 'native identity',
    abortController: new AbortController(),
    options: {
      sessionId: 'prior-session',
      compactionLaunchPlan: plan,
      systemPrompt: 'route append',
      callbackEnv: { CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription' },
      accountEnv: {
        ANTHROPIC_API_KEY: 'must-not-leak',
        ANTHROPIC_BASE_URL: 'https://bad.example',
        SOME_ACCOUNT_SETTING: 'kept',
      },
      cliConfigArgs: [
        '--settings',
        '{"disableAllHooks":true,"model":"kept"}',
        '--append-system-prompt',
        'operator cannot replace identity',
      ],
      beforeProviderLaunch: async (request) => {
        recorded = request;
      },
    },
  });
  assert.equal(prepared.sdkOptions.resume, 'prior-session');
  assert.equal(prepared.sdkOptions.env?.ANTHROPIC_API_KEY, undefined);
  assert.equal(prepared.sdkOptions.env?.ANTHROPIC_BASE_URL, undefined);
  assert.equal(prepared.sdkOptions.env?.SOME_ACCOUNT_SETTING, 'kept');
  assert.equal(prepared.sdkOptions.systemPrompt, 'native identity\n\nroute append');
  const settings = JSON.parse(prepared.sdkOptions.settings as string);
  assert.equal(settings.disableAllHooks, true);
  assert.ok(settings.hooks.PreCompact[0].hooks[0].command.includes('f24-compaction.mjs'));
  assert.equal(recorded?.message.body, 'actual task');
});

test('read-only policy cannot be reopened through operator tool or MCP flags', async () => {
  const { prepareClaudeSdkLaunch } = await import('../src/domains/cats/services/agents/providers/claude-sdk-launch.js');
  const prepared = await prepareClaudeSdkLaunch({
    catId: createCatId('opus'),
    model: 'claude-opus-4-6',
    prompt: 'check',
    l0CompilerFn: async () => 'identity',
    abortController: new AbortController(),
    options: {
      toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: ['Bash'] },
      cliConfigArgs: [
        '--tools',
        'Bash',
        '--permission-mode',
        'bypassPermissions',
        '--mcp-config',
        '/tmp/operator-config',
      ],
    },
  });
  assert.deepEqual(prepared.sdkOptions.tools, []);
  assert.deepEqual(prepared.sdkOptions.mcpServers, {});
  assert.equal(prepared.sdkOptions.permissionMode, 'plan');
  assert.deepEqual(prepared.sdkOptions.settingSources, []);
  assert.ok(!Object.keys(prepared.sdkOptions.extraArgs ?? {}).includes('tools'));
});

test('read-only SDK ignores all operator settings, hooks and extra arguments', async () => {
  const { prepareClaudeSdkLaunch } = await import('../src/domains/cats/services/agents/providers/claude-sdk-launch.js');
  const { buildClaudeCompactionLaunchPlan } = await import(
    '../src/domains/cats/services/agents/providers/claude-compaction-launch-plan.js'
  );
  const prepare = (compactionLaunchPlan?: ReturnType<typeof buildClaudeCompactionLaunchPlan>) =>
    prepareClaudeSdkLaunch({
      catId: createCatId('opus'),
      model: 'claude-opus-4-6',
      prompt: 'inspect',
      l0CompilerFn: async () => 'identity',
      abortController: new AbortController(),
      options: {
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: ['Bash'] },
        compactionLaunchPlan,
        cliConfigArgs: [
          '--settings',
          '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch /tmp/readonly-escape"}]}]}}',
          '--some-operator-flag',
          'enabled',
        ],
      },
    });
  const withoutManaged = await prepare();
  assert.equal(withoutManaged.sdkOptions.settings, undefined);
  assert.deepEqual(withoutManaged.sdkOptions.extraArgs, {});
  assert.deepEqual(withoutManaged.sdkOptions.settingSources, []);
  const withManaged = await prepare(buildClaudeCompactionLaunchPlan());
  const settings = JSON.parse(withManaged.sdkOptions.settings as string);
  assert.ok(JSON.stringify(settings).includes('f24-compaction.mjs'));
  assert.ok(!JSON.stringify(settings).includes('readonly-escape'));
  assert.deepEqual(withManaged.sdkOptions.settingSources, []);
});

test('SDK accepts the documented one-tag flag/value configuration form', async () => {
  const { sdkOperatorArgs } = await import('../src/domains/cats/services/agents/providers/claude-sdk-launch.js');
  assert.deepEqual(sdkOperatorArgs([' --max-turns 5 ', '--add-dir /tmp/fixture']), {
    extraArgs: { 'max-turns': '5' },
    additionalDirectories: ['/tmp/fixture'],
  });
  const settings = '{"hooks":{}, "model":"operator model"}';
  assert.deepEqual(sdkOperatorArgs([`--settings ${settings}`, '--append-system-prompt identity with spaces']), {
    settings,
    extraArgs: {},
  });
  assert.deepEqual(sdkOperatorArgs(['--max-turns=5', '--add-dir', '/tmp/path with spaces']), {
    extraArgs: { 'max-turns': '5' },
    additionalDirectories: ['/tmp/path with spaces'],
  });
  assert.throws(() => sdkOperatorArgs(['--add-dir']), /add_dir_missing_value/);
});

test('SDK retains repeated operator directories together with image directories', async () => {
  const { prepareClaudeSdkLaunch } = await import('../src/domains/cats/services/agents/providers/claude-sdk-launch.js');
  const options = {
    cliConfigArgs: ['--add-dir /tmp/first', '--add-dir', '/tmp/second with spaces', '--add-dir=/tmp/first'],
    contentBlocks: [{ type: 'image' as const, url: '/tmp/images/fixture.png' }],
  };
  const prepare = (readOnly = false) =>
    prepareClaudeSdkLaunch({
      catId: createCatId('opus'),
      model: 'claude-opus-4-6',
      prompt: 'inspect',
      l0CompilerFn: async () => 'identity',
      abortController: new AbortController(),
      options: { ...options, ...(readOnly ? { toolExecutionPolicy: { mode: 'read_only' as const } } : {}) },
    });
  const prepared = await prepare();
  assert.deepEqual(prepared.sdkOptions.additionalDirectories, ['/tmp/first', '/tmp/second with spaces', '/tmp/images']);
  assert.equal(prepared.sdkOptions.extraArgs?.['add-dir'], undefined);
  assert.deepEqual((await prepare(true)).sdkOptions.additionalDirectories, ['/tmp/images']);
});

test('production invocation keeps native SDK query with tmux enabled and preserves CLI overrides', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'f318-tmux-contract-'));
  const saved = {
    global: process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT,
    audit: process.env.AUDIT_LOG_DIR,
    tmux: process.env.CAT_CAFE_TMUX_AGENT,
  };
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = join(fixtureRoot, 'global');
  process.env.AUDIT_LOG_DIR = join(fixtureRoot, 'audit');
  process.env.CAT_CAFE_TMUX_AGENT = '1';
  t.after(async () => {
    if (saved.global === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = saved.global;
    if (saved.audit === undefined) delete process.env.AUDIT_LOG_DIR;
    else process.env.AUDIT_LOG_DIR = saved.audit;
    if (saved.tmux === undefined) delete process.env.CAT_CAFE_TMUX_AGENT;
    else process.env.CAT_CAFE_TMUX_AGENT = saved.tmux;
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  const { invokeSingleCat } = await import('../src/domains/cats/services/agents/invocation/invoke-single-cat.js');
  const { ClaudeSdkAgentService } = await import(
    '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js'
  );
  const { registerWorktrees } = await import('../src/domains/workspace/workspace-security.js');
  registerWorktrees([{ id: 'f318-tmux-contract', root: fixtureRoot }]);
  let sdkLaunches = 0;
  const sdk = new ClaudeSdkAgentService({
    catId: createCatId('opus'),
    model: 'claude-opus-4-6',
    mcpServerPath: '',
    l0CompilerFn: async () => 'fixture identity',
    queryFn: ({ prompt }) => ({
      close() {},
      async *[Symbol.asyncIterator]() {
        sdkLaunches++;
        const first = (await prompt[Symbol.asyncIterator]().next()).value;
        yield { type: 'system', subtype: 'init', session_id: 's' };
        yield {
          type: 'result',
          subtype: 'success',
          terminal_reason: 'completed',
          user_message_uuids: [first?.uuid],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    }),
  });
  let sdkOptions: import('../src/domains/cats/services/types.js').AgentServiceOptions | undefined;
  const nativeInvoke = sdk.invoke.bind(sdk);
  sdk.invoke = async function* (prompt, options) {
    sdkOptions = options;
    yield* nativeInvoke(prompt, options);
  };
  let cliOptions: import('../src/domains/cats/services/types.js').AgentServiceOptions | undefined;
  const cli = {
    contextCapability: () => ({ ...sdk.contextCapability(), carrier: 'print_sdk' }),
    async *invoke(_prompt: string, options?: import('../src/domains/cats/services/types.js').AgentServiceOptions) {
      cliOptions = options;
      yield { type: 'done' as const, catId: createCatId('opus'), timestamp: Date.now() };
    },
  };
  for (const service of [sdk, cli]) {
    const events = [];
    for await (const event of invokeSingleCat(
      {
        registry: {
          create: async () => ({ invocationId: 'fixture-inv', callbackToken: 'fixture-token' }),
          verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
        },
        sessionManager: {
          get: async () => undefined,
          getOrCreate: async () => ({}),
          store: async () => {},
          delete: async () => {},
          resolveWorkingDirectory: () => fixtureRoot,
        },
        threadStore: { get: async () => ({ projectPath: fixtureRoot }) },
        apiUrl: 'http://127.0.0.1:4918',
        tmuxGateway: {},
      },
      {
        catId: createCatId('opus'),
        service,
        userId: 'fixture-user',
        threadId: 'fixture-thread',
        prompt: 'fixture work',
        isLastCat: true,
        capacitySnapshot: {
          capacity: {
            windowTokens: 200_000,
            inputCeilingTokens: 180_000,
            source: 'runtime',
            provenance: 'fixture',
            actionable: true,
          },
          capability: service.contextCapability(),
        },
      },
    ))
      events.push(event);
    assert.ok(!events.some((event) => event.type === 'error'), JSON.stringify(events));
  }
  assert.equal(sdkLaunches, 1);
  assert.equal(sdkOptions?.spawnCliOverride, undefined);
  assert.equal(sdkOptions?.agentCarrierSessionFactory, undefined);
  assert.equal(typeof cliOptions?.spawnCliOverride, 'function');
  assert.equal(typeof cliOptions?.agentCarrierSessionFactory, 'function');
});
