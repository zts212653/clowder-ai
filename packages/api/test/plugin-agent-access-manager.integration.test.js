import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { roleConfigurationRevision } from '@clowder-ai/agent-access/roles/write-role';
import { AGENT_ACCESS_OPERATIONS, OFFICIAL_AGENT_ACCESS_OPERATIONS } from '@clowder-ai/agent-contract';
import { validateManifest } from '@clowder-ai/plugin-contract';
import Fastify from 'fastify';
import { A2AAgentService } from '../dist/domains/cats/services/agents/providers/A2AAgentService.js';
import { ClaudeSdkAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { sessionImplementationKey } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createAgentAccessA2ARunner } from '../dist/domains/plugin/agent-access/a2a.js';
import { createAgentAccessAcpModelSelection } from '../dist/domains/plugin/agent-access/acp.js';
import { createAgentAccessAcpProcess } from '../dist/domains/plugin/agent-access/acp-process.js';
import { AgentAccessAcpRuntimeClient } from '../dist/domains/plugin/agent-access/acp-runtime-client.js';
import { createAgentAccessDshConnectionTest } from '../dist/domains/plugin/agent-access/dsh.js';
import { createAgentAccessKimiLaunchPlanner } from '../dist/domains/plugin/agent-access/kimi.js';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../dist/domains/plugin/carrier/plugin-owner-request-context.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import {
  createAgentRoleRead,
  createAgentRoleWrite,
  registerAgentAccessRoutes,
} from '../dist/routes/agent-access-routes.js';
import { catsRoutes } from '../dist/routes/cats.js';
import { tarArchive } from '../scripts/bundled-plugin-artifacts.mjs';
import { canonicalGzip } from '../scripts/canonical-gzip.mjs';
import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';

test('Kimi native events cross with redaction and consume only the same active package generation', async () => {
  const instance = {
    pluginInstanceId: 'kimi-event-test',
    packageDigest: 'digest-one',
    lifecycleRevision: 1,
    activationState: 'enabled',
    runtimeState: 'healthy',
  };
  const plan = await createAgentAccessKimiLaunchPlanner(
    { readCurrentAuthority: async () => ({ instance }) },
    {
      invoke: async (_instanceId, method, input) => {
        if (method === 'configure') return { args: [], managedArgvFlags: [] };
        assert.equal(input.event.content, 'Hello');
        assert.notEqual(input.event.apiKey, 'fixture-private-value');
        assert.ok(!input.event.thinking.includes('fixture-opaque-secret'));
        assert.ok(!input.event.tool_calls[0].function.arguments.includes('fixture-other-private-value'));
        instance.lifecycleRevision += 1;
        return { kind: 'ignored' };
      },
    },
  )({ prompt: 'hello', imageAccessDirs: [] });
  await assert.rejects(
    plan.normalizeEvent(
      {
        content: 'Hello',
        apiKey: 'fixture-private-value',
        thinking: 'trace fixture-opaque-secret',
        tool_calls: [
          { function: { arguments: JSON.stringify({ Authorization: 'Bearer fixture-other-private-value' }) } },
        ],
      },
      ['fixture-opaque-secret'],
    ),
    {
      message: 'session_implementation_unavailable',
    },
  );
});

test('Agent access discovery executes the same standalone entrypoint from a Manager archive across replacement and rollback', async (t) => {
  const pluginId = 'official.agent-access';
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-access-manager-'));
  const app = Fastify();
  const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
  const previousTemplate = process.env.CAT_TEMPLATE_PATH;
  const template = join(projectRoot, 'cat-template.json');
  const availableProviders = new Set();
  await writeFile(template, JSON.stringify({ version: 1, breeds: [], roleTemplates: [] }));
  process.env.CAT_CAFE_CONFIG_ROOT = projectRoot;
  process.env.CAT_TEMPLATE_PATH = template;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    contract: { manifestContractRange: '0.4.0-candidate.0', validateManifest },
    isDeclaredAgentProviderAvailable: (reference) => availableProviders.has(sessionImplementationKey(reference)),
  });
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
    if (previousTemplate === undefined) delete process.env.CAT_TEMPLATE_PATH;
    else process.env.CAT_TEMPLATE_PATH = previousTemplate;
    await app.close();
    await runtime.shutdown();
    await rm(projectRoot, { recursive: true, force: true });
  });

  const manager = createPluginManagerRuntimeComposition({
    runtime,
    catalogManifests: [],
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 0 }) },
  }).manager;
  const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = owner;
  });
  const { readLegacyNativeRuntimes: nativeRuntimeDiscovery, readDetection: agentAccessDetection } =
    registerAgentAccessRoutes(app, {
      inventory: runtime.inventoryStore,
      runtime: runtime.supervisor,
    });
  await app.register(catsRoutes, {
    nativeRuntimeDiscovery,
    agentAccessDetection,
    agentRoleRead: createAgentRoleRead(runtime.inventoryStore, runtime.supervisor),
    agentRoleWrite: createAgentRoleWrite(runtime.inventoryStore, runtime.supervisor),
  });
  const scan = async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/agent-access/v1/detect',
      headers: { host: 'localhost:3004' },
      remoteAddress: '127.0.0.1',
      payload: { refresh: true },
    });
    assert.equal(result.statusCode, 200, result.payload);
    return result.json();
  };

  const entrypoint = await readFile(new URL('../../agent-access-plugin/dist/plugin/entrypoint.mjs', import.meta.url));
  const nextModule = entrypoint
    .toString()
    .replace(/(id:\s*["']kimi["'],\s*label:\s*)(["'])Kimi\2/g, '$1$2Kimi vNext$2');
  assert.notEqual(nextModule, entrypoint.toString());
  async function archive(version, protocolVersion = 1, operations = OFFICIAL_AGENT_ACCESS_OPERATIONS) {
    const manifest = {
      pluginId,
      version,
      contractVersion: '0.4.0-candidate.0',
      name: 'Agent access discovery',
      features: [{ id: 'discovery', name: 'Client discovery', capabilities: [], resources: [] }],
      runtime: { transport: 'builtin', entrypoint: 'entrypoint.mjs' },
    };
    assert.deepEqual(validateManifest(manifest).errors ?? [], []);
    const output = join(projectRoot, `agent-access-${version}.tgz`);
    await writeFile(
      output,
      canonicalGzip(
        tarArchive([
          { name: 'package/manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) },
          {
            name: 'package/agent-access.json',
            bytes: Buffer.from(JSON.stringify({ protocolVersion, operations, transports: ['a2a'] })),
          },
          { name: 'package/entrypoint.mjs', bytes: version === '1.0.1' ? Buffer.from(nextModule) : entrypoint },
          {
            name: 'package/package.json',
            bytes: Buffer.from(JSON.stringify({ name: '@clowder-ai/agent-access', version, type: 'module' })),
          },
        ]),
      ),
    );
    return output;
  }
  const previous = await archive('1.0.0');
  const next = await archive('1.0.1');
  const incompatible = await archive('1.0.2', 2);
  const obsolete = await archive('0.9.0', 1, AGENT_ACCESS_OPERATIONS);
  const install = (path) => manager.install({ source: { kind: 'local-archive', path } });
  assert.equal((await scan()).readiness.state, 'missing');
  const setupRead = () =>
    app.inject({
      method: 'POST',
      url: '/api/cats/dsh-setup/inspect',
      headers: { host: 'localhost:3004' },
      remoteAddress: '127.0.0.1',
      payload: { runtimeId: 'unregistered-test-runtime', sourceProfile: 'acp' },
    });
  assert.deepEqual((await setupRead()).json(), { error: 'dsh_setup_unavailable' });
  const installed = await install(previous);
  await manager.setEnabled(pluginId, {
    enabled: true,
    expectedRevision: (await manager.get(pluginId)).plugin.lifecycleRevision,
  });
  const first = await scan();
  assert.equal(first.readiness.state, 'ready', JSON.stringify(first.readiness));
  assert.ok(first.candidates.some((candidate) => candidate.id === 'codex'));
  assert.equal(first.candidates.find((candidate) => candidate.id === 'kimi')?.label, 'Kimi');
  assert.deepEqual((await setupRead()).json(), { error: 'dsh_setup_custom_startup' });

  const controller = new AbortController();
  const source = Readable.from([
    {
      sequence: 0,
      event: {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'claude-msg', usage: { input_tokens: 8 } } },
      },
    },
    {
      sequence: 1,
      event: {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'shipped' } },
      },
    },
    {
      sequence: 2,
      event: { type: 'assistant', message: { id: 'claude-msg', content: [{ type: 'text', text: 'shipped' }] } },
    },
    { sequence: 3, event: { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 2 } } },
  ]);
  const claude = await runtime.supervisor.invoke(installed.pluginInstanceId, 'projectClaudeOutput', {
    catId: 'claude-fixture',
    source,
    signal: controller.signal,
  });
  const framed = [];
  for await (const frame of claude) framed.push(frame);
  assert.deepEqual(
    framed.map(({ sequence }) => sequence),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    framed.flatMap(({ messages }) => messages ?? []).map(({ content }) => content),
    ['shipped'],
  );
  assert.deepEqual(framed[3].usage, { inputTokens: 10, outputTokens: 2, lastTurnInputTokens: 8 });

  const { createAgentAccessClaudeOutput } = await import('../dist/domains/plugin/agent-access/claude.js');
  const projectClaude = createAgentAccessClaudeOutput(runtime.inventoryStore, runtime.supervisor);
  const stopController = new AbortController();
  const providerEnded = Promise.withResolvers();
  const native = (async function* () {
    try {
      yield { type: 'system', subtype: 'init', session_id: 'verified-session' };
      await wait(60_000, undefined, { signal: stopController.signal });
    } finally {
      providerEnded.resolve();
    }
  })();
  const output = projectClaude(native, {
    catId: 'verified-role',
    signal: stopController.signal,
    stop: () => stopController.abort(),
    knownCredentials: [],
  });
  const opened = await output.next();
  assert.equal(opened.value.messages.sessionId, 'verified-session');
  assert.equal(opened.value.messages.catId, 'verified-role');
  const parked = output.next();
  stopController.abort();
  await assert.rejects(parked, /abort/i);
  await providerEnded.promise;

  const closeController = new AbortController();
  const quiet = (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'verified-session' };
    await wait(60_000, undefined, { signal: closeController.signal });
  })();
  const closing = projectClaude(quiet, {
    catId: 'verified-role',
    signal: new AbortController().signal,
    stop: () => closeController.abort(),
    knownCredentials: [],
  });
  assert.equal((await closing.next()).done, false);
  const stopped = assert.rejects(closing.next(), /abort/i);
  await wait(25);
  await Promise.all([stopped, closing.return()]);
  assert.equal(closeController.signal.aborted, true);

  const credential = 'fixture_opaque_agent_credential_value';
  const projectedText = [];
  const privateInput = (async function* () {
    yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'claude-secret' } } };
    yield {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'before ' + credential.slice(0, 16) } },
    };
    yield { type: 'user', message: { content: 'host-only SDK message' }, session_id: 'verified-session' };
    yield { __livenessWarning: true, level: 'warning', silenceDurationMs: 1000 };
    yield {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: credential.slice(16) + ' after' } },
    };
    yield {
      type: 'assistant',
      message: { id: 'claude-secret', content: [{ type: 'text', text: 'before ' + credential + ' after' }] },
    };
  })();
  for await (const frame of projectClaude(privateInput, {
    catId: 'verified-role',
    signal: new AbortController().signal,
    stop: () => {},
    knownCredentials: [credential],
  })) {
    const messages = Array.isArray(frame.messages) ? frame.messages : [frame.messages];
    projectedText.push(...messages.filter((message) => message?.type === 'text').map((message) => message.content));
  }
  assert.match(projectedText.join(''), /^before .*REDACTED.* after$/i);
  assert.equal(projectedText.join('').includes(credential), false);

  const forged = createAgentAccessClaudeOutput(runtime.inventoryStore, {
    nativeActions: runtime.supervisor.nativeActions,
    invoke: async (_id, _method, input) =>
      (async function* () {
        for await (const frame of input.source) {
          assert.equal(frame.event, null, 'SDK user echo belongs to the Host');
          yield {
            sequence: frame.sequence,
            messages: {
              type: 'text',
              catId: 'verified-role',
              timestamp: 0,
              contextCompaction: { eventSource: 'claude_compact_boundary' },
            },
          };
        }
      })(),
  });
  const user = (async function* () {
    yield { type: 'user', message: { content: 'host-only SDK message' } };
  })();
  await assert.rejects(
    forged(user, {
      catId: 'verified-role',
      signal: new AbortController().signal,
      stop: () => {},
      knownCredentials: [],
    }).next(),
    /invalid_claude_compaction_frame/,
  );

  let sdkCloses = 0;
  let readsAfterIdle = 0;
  const sdk = new ClaudeSdkAgentService({
    catId: 'verified-role',
    model: 'claude-opus-4-6',
    mcpServerPath: '',
    runtimeResolver: claudeSdkRuntimeFixture,
    l0CompilerFn: async () => 'fixture identity',
    projectOutput: projectClaude,
    queryFn: ({ prompt }) => ({
      close: () => sdkCloses++,
      async *[Symbol.asyncIterator]() {
        const { value: first } = await prompt[Symbol.asyncIterator]().next();
        yield { type: 'system', subtype: 'init', session_id: 'sdk-history' };
        yield { type: 'system', subtype: 'session_state_changed', state: 'running' };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'sdk projected' }] } };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sdk-history',
          queued_turn_count: 0,
          user_message_uuids: [first.uuid],
        };
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
        readsAfterIdle++;
        throw Error('read beyond native idle');
      },
    }),
  });
  const sdkOutput = [];
  for await (const event of sdk.invoke('fixture', { workingDirectory: projectRoot })) sdkOutput.push(event);
  assert.deepEqual(
    sdkOutput.map(({ type }) => type),
    ['session_init', 'text', 'done'],
    sdkOutput.find(({ type }) => type === 'error')?.error,
  );
  assert.equal(readsAfterIdle, 0);
  assert.equal(sdkCloses, 1);
  assert.equal(sdkOutput[1].content, 'sdk projected');

  const acpCommands = [];
  const mcpSecret = 'fixture-host-held-mcp-value';
  const privatePrompt = 'Host-approved fixture prompt';
  const attachAcp = createAgentAccessAcpProcess(runtime.inventoryStore, {
    nativeActions: runtime.supervisor.nativeActions,
    invoke(instanceId, method, input) {
      if (method === 'acpSession') {
        acpCommands.push(input.operation);
        const crossing = JSON.stringify(input);
        assert.equal(crossing.includes(mcpSecret), false);
        assert.equal(crossing.includes(privatePrompt), false);
      }
      return runtime.supervisor.invoke(instanceId, method, input);
    },
  });
  const acp = new AgentAccessAcpRuntimeClient(
    {
      command: process.execPath,
      cwd: projectRoot,
      args: [
        '-e',
        `
        let pending;
        require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
          const { id, method, params, result } = JSON.parse(line);
          const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
          if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
          if (method === 'session/new' || method === 'session/load') {
            if (params.mcpServers[0].env[0].value !== '${mcpSecret}') process.exit(2);
            send({ id, result: { sessionId: 'same-acp-native' } });
          }
          if (method === 'session/prompt') {
            if (params.prompt[0].text !== '${privatePrompt}') process.exit(2);
            pending = { id, sessionId: params.sessionId };
            send({ id: 0, method: 'session/request_permission', params: { sessionId: params.sessionId } });
          }
          if (id === 0 && pending) {
            if (result?.outcome?.optionId !== 'fixture-approved') process.exit(2);
            send({ method: 'session/update', params: { sessionId: pending.sessionId, update: {
              sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'duplex ACP reply' },
            } } });
            send({ id: pending.id, result: { stopReason: 'end_turn' } });
          }
        });
      `,
      ],
    },
    attachAcp,
  );
  try {
    assert.deepEqual(await acp.initialize(), { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    const mcp = [{ name: 'actual-mcp', command: 'fixture', args: [], env: [{ name: 'TOKEN', value: mcpSecret }] }];
    const { sessionId } = await acp.newSession(projectRoot, mcp);
    assert.equal(sessionId, 'same-acp-native');
    assert.equal((await acp.loadSession(sessionId, projectRoot, mcp)).sessionId, sessionId);
    acp.setSessionPermissionHandler(sessionId, (request, respond) => {
      assert.equal(request.id, 0);
      respond({ optionId: 'fixture-approved' });
    });
    const turn = acp.promptStream(sessionId, privatePrompt);
    assert.deepEqual((await turn.next()).value.update.content, { type: 'text', text: 'duplex ACP reply' });
    assert.deepEqual(await turn.next(), { done: true, value: 'end_turn' });
    assert.equal(acp.hasPromptFinalResponse(sessionId), true);
    assert.equal(acp.isSessionSafeForReuse(sessionId), true);
    assert.deepEqual(acpCommands, ['newSession', 'loadSession', 'prompt']);
  } finally {
    await acp.close();
  }

  const selectModel = createAgentAccessAcpModelSelection(runtime.inventoryStore, runtime.supervisor);
  const codexLaunch = await runtime.supervisor.invoke(installed.pluginInstanceId, 'planCodexExec', {
    operation: 'plan_native_launch',
    client: 'codex',
    launch: { sessionId: 'codex-history', readOnly: true, groups: { sandbox: 'opaque-sandbox-group' } },
  });
  assert.deepEqual(codexLaunch.args, ['exec', 'resume', 'codex-history', '--json', 'opaque-sandbox-group', '--', '-']);
  const modelOffer = {
    configOptions: [
      { id: 'vendor-model', category: 'model', currentValue: 'other', options: [{ value: 'fixture/model' }] },
    ],
  };
  assert.deepEqual(await selectModel(modelOffer, 'fixture/model'), { configId: 'vendor-model' });
  assert.equal(await selectModel(modelOffer, 'not-advertised'), null);
  const invalidPlan = createAgentAccessAcpModelSelection(runtime.inventoryStore, {
    invoke: async () => ({ configId: 'approval' }),
  });
  await assert.rejects(invalidPlan(modelOffer, 'fixture/model'), /unapproved_acp_model_option/);
  const unavailableModelPicker = createAgentAccessAcpModelSelection(
    { readCurrentAuthority: async () => undefined },
    {
      invoke: async () => assert.fail('model selection should not reach an inactive package'),
    },
  );
  assert.equal(await unavailableModelPicker({}, 'fixture/model'), null);
  assert.equal(await unavailableModelPicker(modelOffer, 'unlisted-model'), null);
  const projected = createAgentAccessAcpModelSelection(runtime.inventoryStore, {
    invoke: async (_id, _method, input) => {
      assert.deepEqual(input.configOptions, modelOffer.configOptions);
      return { configId: 'vendor-model' };
    },
  });
  await projected(
    {
      configOptions: [
        { id: 'approval', category: 'tool', currentValue: 'fixture-private-extra' },
        { ...modelOffer.configOptions[0], extra: { fixture: 'ignore' } },
      ],
    },
    'fixture/model',
  );

  const remote = Fastify();
  t.after(() => remote.close());
  const dispatched = [];
  remote.post('/a2a', async (request) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-peer-token');
    const rpc = request.body;
    assert.equal(rpc.method, 'tasks/send');
    return {
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        id: rpc.params.id,
        status: 'TASK_STATE_COMPLETED',
        artifacts: [{ parts: [{ type: 'text', text: rpc.params.message.parts[0].text }] }],
      },
    };
  });
  const url = await remote.listen({ host: '127.0.0.1', port: 0 });
  const service = new A2AAgentService({
    catId: 'isolated-remote',
    config: { url: url + '/a2a', apiKey: 'fixture-peer-token' },
    runTurn: createAgentAccessA2ARunner(runtime.inventoryStore, runtime.supervisor),
  });
  const invoke = async (text) => {
    const output = [];
    for await (const event of service.invoke(text, {
      onRemoteExecutionDispatched: (execution) => dispatched.push(execution.kind),
    }))
      output.push(event);
    assert.deepEqual(
      output.map((event) => event.type),
      ['session_init', 'text', 'done'],
    );
    assert.equal(output[1].content, text);
  };
  await invoke('before replacement');

  const catalogPath = join(projectRoot, '.cat-cafe', 'cat-catalog.json');
  await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
  await writeFile(catalogPath, JSON.stringify({ version: 1, breeds: [] }));
  const readCatalog = async () => JSON.parse(await readFile(catalogPath, 'utf8'));
  const request = {
    kind: 'create',
    receipt: { requestHash: 'a'.repeat(64), payloadHash: 'b'.repeat(64) },
    input: {
      catId: 'isolated-role',
      name: 'Isolated role',
      displayName: 'Isolated role',
      avatar: '/avatars/default.png',
      color: { primary: '#101010', secondary: '#eeeeee' },
      mentionPatterns: ['@isolated-role'],
      roleDescription: 'Plugin-owned role write',
      clientId: 'kimi',
      configurationSource: 'native_tool',
      carrier: 'cli',
      defaultModel: 'fixture',
      mcpSupport: false,
      cli: { command: 'kimi', outputFormat: 'json' },
    },
  };
  await assert.rejects(runtime.supervisor.invoke(installed.pluginInstanceId, 'writeRole', request));
  assert.equal((await readCatalog()).breeds.length, 0);

  const mutate = (input) =>
    withPluginOwnerRequest(
      {
        pluginId,
        contributionId: 'writeRole',
        userId: owner,
        operation: 'write',
        signal: new AbortController().signal,
      },
      () =>
        withPluginOwnerWebhook(
          pluginId,
          'writeRole',
          installed.pluginInstanceId,
          false,
          () => {},
          () => runtime.supervisor.invoke(installed.pluginInstanceId, 'writeRole', input),
        ),
    );
  assert.deepEqual(await mutate(request), { status: 'committed', catId: request.input.catId });
  assert.deepEqual(await mutate(request), { status: 'committed', catId: request.input.catId, replayed: true });
  assert.equal((await readCatalog()).breeds.length, 1);
  assert.equal((await readCatalog()).breeds[0].catId, request.input.catId);
  const before = roleConfigurationRevision(await readCatalog(), request.input.catId);

  await assert.rejects(install(incompatible), /Agent access protocol version/);
  await assert.rejects(install(obsolete), /missing operations .*selectAcpModel/);
  assert.equal((await manager.get(pluginId)).plugin.installedVersion, '1.0.0');
  assert.equal((await scan()).readiness.state, 'ready');

  const planLaunch = createAgentAccessKimiLaunchPlanner(runtime.inventoryStore, runtime.supervisor);
  const launch = await planLaunch({
    prompt: 'fixture',
    imageAccessDirs: [],
    resumeSessionId: 'history-id',
    cliConfigArgs: ['--session unsolicited --output-format stream-json'],
  });
  assert.deepEqual(launch.args, ['--session', 'history-id', '-p', 'fixture', '--output-format', 'stream-json']);
  await launch.assertCurrent();
  assert.deepEqual(
    await launch.normalizeEvent({ role: 'assistant', session_id: 'history-id', content: 'Kimi reply' }),
    { kind: 'assistant', sessionId: 'history-id', text: 'Kimi reply', tools: [] },
  );
  const runConnectionTest = createAgentAccessDshConnectionTest(runtime.inventoryStore, runtime.supervisor);
  const fixtureAcpServer = `
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    const send = (value) => console.log(JSON.stringify({ jsonrpc: '2.0', ...value }));
    lines.on('line', (line) => {
      const { method, id } = JSON.parse(line);
      if (method === 'initialize') send({ id, result: { protocolVersion: 1 } });
      if (method === 'session/new') send({ id, result: { sessionId: 'isolated-dsh' } });
      if (method === 'session/prompt') {
        send({
          method: 'session/update',
          params: { sessionId: 'isolated-dsh', update: {
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DSH_CONNECTION_OK' },
          } },
        });
        send({ id, result: { stopReason: 'end_turn' } });
      }
    });
  `;
  assert.deepEqual(
    await runConnectionTest(
      { command: process.execPath, args: ['-e', fixtureAcpServer], cwd: projectRoot, spawnFn: spawn },
      projectRoot,
      {},
    ),
    { sessionId: 'isolated-dsh' },
  );

  const latest = await install(next);
  await assert.rejects(launch.assertCurrent(), /session_implementation_unavailable/);
  assert.equal(latest.pluginInstanceId, installed.pluginInstanceId);
  const afterUpdate = await scan();
  assert.equal(afterUpdate.readiness.state, 'ready');
  assert.equal(afterUpdate.candidates.find((candidate) => candidate.id === 'kimi')?.label, 'Kimi vNext');
  const legacyScan = await app.inject({
    method: 'GET',
    url: '/api/cats/native-runtimes?refresh=1',
    headers: { host: 'localhost:3004', 'X-Cat-Cafe-User': owner },
    remoteAddress: '127.0.0.1',
  });
  assert.equal(legacyScan.statusCode, 200, legacyScan.payload);
  assert.equal(legacyScan.json().runtimes.find((candidate) => candidate.id === 'kimi')?.label, 'Kimi vNext');
  assert.equal((await manager.get(pluginId)).plugin.installedVersion, '1.0.1');
  await invoke('after replacement');

  assert.deepEqual(
    await mutate({
      kind: 'update',
      catId: request.input.catId,
      expectedRevision: before,
      patch: { displayName: 'Renamed during upgrade' },
    }),
    { status: 'committed', catId: request.input.catId },
  );
  assert.deepEqual(
    await mutate({
      kind: 'delete',
      catId: request.input.catId,
      expectedRevision: before,
    }),
    { status: 'conflict' },
  );

  await install(previous);
  assert.equal((await manager.get(pluginId)).plugin.installedVersion, '1.0.0');
  const afterRollback = await scan();
  assert.equal(afterRollback.readiness.state, 'ready');
  assert.equal(afterRollback.candidates.find((candidate) => candidate.id === 'kimi')?.label, 'Kimi');
  const restored = await readCatalog();
  assert.equal(restored.breeds[0].displayName, 'Renamed during upgrade');
  await invoke('after rollback');
  assert.deepEqual(dispatched, ['a2a_task', 'a2a_task', 'a2a_task']);
  assert.deepEqual(
    await mutate({
      kind: 'delete',
      catId: request.input.catId,
      expectedRevision: roleConfigurationRevision(restored, request.input.catId),
    }),
    { status: 'committed', catId: request.input.catId },
  );
  assert.equal((await readCatalog()).breeds.length, 0);

  const call = (method, path, payload, headers = {}) =>
    app.inject({
      method,
      url: path,
      headers: { host: 'localhost:3004', origin: 'http://localhost:3003', ...headers },
      remoteAddress: '127.0.0.1',
      payload,
    });
  const directory = await call('GET', '/api/agent-access/v1/clients');
  assert.ok(directory.json().clients.some((client) => client.id === 'kimi'));
  const previousBindHost = process.env.API_SERVER_HOST;
  t.after(() => {
    if (previousBindHost === undefined) delete process.env.API_SERVER_HOST;
    else process.env.API_SERVER_HOST = previousBindHost;
  });
  process.env.API_SERVER_HOST = '0.0.0.0';
  const lanDetection = await call('POST', '/api/agent-access/v1/detect', { refresh: true });
  assert.equal(lanDetection.statusCode, 200, lanDetection.payload);
  assert.ok(lanDetection.json().candidates.some((client) => client.id === 'kimi'));
  const lanDirectory = await call('GET', '/api/agent-access/v1/clients');
  assert.equal(lanDirectory.statusCode, 200, lanDirectory.payload);
  assert.ok(lanDirectory.json().clients.some((client) => client.id === 'kimi'));
  const selectedProvider = 'plugin:local.agent-access-test/kimi';
  const declared = {
    clientId: 'acp',
    carrier: 'acp',
    acp: { command: 'plugin-agent', startupArgs: [], agentProvider: selectedProvider },
  };
  const unavailable = await call('POST', '/api/cats', { ...request.input, ...declared });
  assert.equal(unavailable.statusCode, 409, unavailable.payload);
  assert.equal(unavailable.json().code, 'agent_provider_unavailable');
  const unavailableTopLevel = await call('POST', '/api/cats', { ...request.input, agentProvider: selectedProvider });
  assert.equal(unavailableTopLevel.statusCode, 409, unavailableTopLevel.payload);
  assert.equal(unavailableTopLevel.json().code, 'agent_provider_unavailable');
  assert.equal((await readCatalog()).breeds.length, 0);
  const create = await call('POST', '/api/cats', request.input);
  assert.equal(create.statusCode, 201, create.payload);
  const createdRole = create.json().cat;
  assert.equal(createdRole.id, request.input.catId);
  const journey = randomUUID();
  const receipt = {
    'idempotency-key': `onboarding:${journey}:cat:${request.input.catId}`,
    'x-cat-cafe-onboarding-journey': journey,
  };
  const collidingCreate = { ...request.input, ...declared, mentionPatterns: ['@separate-receipt-member'] };
  const blockedCollision = await call('POST', '/api/cats', collidingCreate, receipt);
  assert.equal(blockedCollision.statusCode, 409, blockedCollision.payload);
  assert.equal(blockedCollision.json().code, 'agent_provider_unavailable');
  const inherited = await readCatalog();
  Object.assign(inherited.breeds[0], {
    teamStrengths: 'Template collaboration strength',
    caution: 'Template caution',
    restrictions: ['Template restriction'],
  });
  inherited.breeds[0].variants[0].acp = declared.acp;
  await writeFile(template, JSON.stringify(inherited));
  const roles = await call('GET', '/api/cats');
  const card = roles.json().cats.find((cat) => cat.id === createdRole.id);
  assert.deepEqual(card.client, { id: 'kimi', label: 'Kimi', type: 'legacy' });
  assert.equal(card.teamStrengths, 'Template collaboration strength');
  assert.equal(card.caution, 'Template caution');
  assert.deepEqual(card.restrictions, ['Template restriction']);
  const rolePath = '/api/cats/' + createdRole.id;
  const unavailableInherited = await call('PATCH', rolePath, {
    carrier: 'acp',
    expectedRevision: createdRole.configurationRevision,
  });
  assert.equal(unavailableInherited.statusCode, 409, unavailableInherited.payload);
  assert.equal(unavailableInherited.json().code, 'agent_provider_unavailable');
  const staleSelection = await call('PATCH', rolePath, {
    ...declared,
    expectedRevision: createdRole.configurationRevision,
  });
  assert.equal(staleSelection.statusCode, 409, staleSelection.payload);
  assert.equal(staleSelection.json().code, 'agent_provider_unavailable');
  availableProviders.add(selectedProvider);
  const enabledInherited = await call('PATCH', rolePath, {
    carrier: 'acp',
    expectedRevision: createdRole.configurationRevision,
  });
  assert.equal(enabledInherited.statusCode, 200, enabledInherited.payload);
  assert.equal(enabledInherited.json().cat.acp.agentProvider, selectedProvider);
  const distinctCreation = await call('POST', '/api/cats', collidingCreate, receipt);
  assert.equal(distinctCreation.statusCode, 201, distinctCreation.payload);
  const receiptRole = distinctCreation.json().cat;
  assert.notEqual(receiptRole.id, createdRole.id);
  assert.equal(receiptRole.acp.agentProvider, selectedProvider);
  availableProviders.delete(selectedProvider);
  const bound = await call('PATCH', rolePath, {
    ...declared,
    expectedRevision: enabledInherited.json().cat.configurationRevision,
  });
  assert.equal(bound.statusCode, 200, bound.payload);
  assert.equal(bound.json().cat.acp.agentProvider, selectedProvider);
  const edited = await call('PATCH', rolePath, {
    displayName: 'Changed using the member API',
    expectedRevision: bound.json().cat.configurationRevision,
  });
  assert.equal(edited.statusCode, 200, edited.payload);
  assert.equal(edited.json().cat.displayName, 'Changed using the member API');
  assert.equal(edited.json().cat.acp.agentProvider, selectedProvider);
  const deleted = await call('DELETE', rolePath, { expectedRevision: edited.json().cat.configurationRevision });
  assert.equal(deleted.statusCode, 200, deleted.payload);
  const replay = await call('POST', '/api/cats', collidingCreate, receipt);
  assert.equal(replay.statusCode, 200, replay.payload);
  assert.equal(replay.json().cat.id, receiptRole.id);
  const removedReplay = await call('DELETE', '/api/cats/' + receiptRole.id, {
    expectedRevision: replay.json().cat.configurationRevision,
  });
  assert.equal(removedReplay.statusCode, 200, removedReplay.payload);
  assert.equal((await readCatalog()).breeds.length, 0);
});
