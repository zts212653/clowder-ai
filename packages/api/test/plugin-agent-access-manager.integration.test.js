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
import {
  AGENT_ACCESS_ACP_SESSION_ACTION,
  AGENT_ACCESS_OPERATIONS,
  OFFICIAL_AGENT_ACCESS_OPERATIONS,
} from '@clowder-ai/agent-contract';
import { validateManifest } from '@clowder-ai/plugin-contract';
import Fastify from 'fastify';
import { A2AAgentService } from '../dist/domains/cats/services/agents/providers/A2AAgentService.js';
import { observeAgyNativeTurn } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js';
import { ClaudeSdkAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { transformCodexEvent } from '../dist/domains/cats/services/agents/providers/codex-event-transform.js';
import { sessionImplementationKey } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createAgentAccessA2ARunner } from '../dist/domains/plugin/agent-access/a2a.js';
import { createAgentAccessAcpModelSelection } from '../dist/domains/plugin/agent-access/acp.js';
import { createAgentAccessAcpProcess } from '../dist/domains/plugin/agent-access/acp-process.js';
import { AgentAccessAcpRuntimeClient } from '../dist/domains/plugin/agent-access/acp-runtime-client.js';
import { createAgentAccessAgyOutput } from '../dist/domains/plugin/agent-access/agy.js';
import { createAgentAccessCatAgentOutput } from '../dist/domains/plugin/agent-access/catagent.js';
import { createAgentAccessClaudeBatch } from '../dist/domains/plugin/agent-access/claude-batch.js';
import { createAgentAccessCodexExecLaunchPlanner } from '../dist/domains/plugin/agent-access/codex.js';
import { createAgentAccessCodexAppServerNotificationProjection } from '../dist/domains/plugin/agent-access/codex-appserver.js';
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
    .replace(/(id:\s*["']kimi["'],\s*label:\s*)(["'])Kimi\2/g, '$1$2Kimi vNext$2')
    .replace(
      /(reasoningParts:\s*["']summary["'],\s*reasoningText:\s*\[)(["'])text\2,\s*(["'])content\3/,
      '$1$2content$2, $3text$3',
    )
    .replace('remoteControl/status/changed', 'transport/debug/ignored');
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
  const loadNotificationProjection = createAgentAccessCodexAppServerNotificationProjection(
    runtime.inventoryStore,
    runtime.supervisor,
  );
  const firstProjection = await loadNotificationProjection();
  assert.ok(firstProjection?.ignoredMethods.has('remoteControl/status/changed'));
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

  const hookEvidencePath = '/isolated/receipt.txt';
  const openClaudeBatch = createAgentAccessClaudeBatch(runtime.inventoryStore, {
    nativeActions: runtime.supervisor.nativeActions,
    async invoke(instanceId, method, input) {
      assert.equal(method, 'projectClaudeBatch');
      assert.equal(JSON.stringify(input).includes(hookEvidencePath), false);
      return runtime.supervisor.invoke(instanceId, method, input);
    },
  });
  const transcript = await openClaudeBatch('transcript', 'opus');
  const transcriptFrame = await transcript.project([
    { type: 'system', subtype: 'turn_duration' },
    { type: 'assistant', message: { id: 'fixture-message', content: [{ type: 'text', text: 'background text' }] } },
  ]);
  assert.deepEqual(
    transcriptFrame.messages.map(({ type, content }) => [type, content]),
    [['text', 'background text']],
  );
  assert.equal(transcriptFrame.lastTextMessageId, 'fixture-message');
  const hooks = await openClaudeBatch('hook', 'opus');
  const hookFrame = await hooks.project([
    { hook_event_name: 'PreToolUse', tool_name: 'Write' },
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: {},
      tool_use_id: 'fixture-tool',
      tool_response: { filePath: hookEvidencePath },
    },
    { hook_event_name: 'Stop', last_assistant_message: 'interactive text' },
  ]);
  assert.deepEqual(
    hookFrame.messages.map(({ type }) => type),
    ['tool_use', 'text'],
  );
  assert.equal(hookFrame.messages[0].toolUseId, 'fixture-tool');
  assert.equal(hookFrame.messages[0].fileResultEvidence.absolutePath, hookEvidencePath);
  assert.equal(hookFrame.messages[1].content, 'interactive text');

  const catAgentCredential = 'fixture-catagent-isolated-credential';
  const openCatAgentOutput = createAgentAccessCatAgentOutput(runtime.inventoryStore, runtime.supervisor);
  const catAgentOutput = await openCatAgentOutput(undefined, [catAgentCredential]);
  const providerEvents = [
    { type: 'message_start', message: { usage: { input_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'direct API ' + catAgentCredential.slice(0, 17) },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: catAgentCredential.slice(17) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'fixture-read', name: 'read' } },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"query":"\\u0066' + catAgentCredential.slice(1, 17) },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: catAgentCredential.slice(17) + '","name":"preserved"}' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  const providerBody = new Response(providerEvents.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  const catAgentEvents = await Array.fromAsync(catAgentOutput.read(providerBody.body));
  assert.deepEqual(
    catAgentEvents.map(({ type }) => type),
    [
      'usage_update',
      'text_delta',
      'text_delta',
      'content_block_complete',
      'content_block_complete',
      'usage_update',
      'stop',
    ],
  );
  assert.equal(catAgentEvents[0].inputUsage.input_tokens, 4);
  assert.match(catAgentEvents[1].text, /^direct API /);
  assert.equal(JSON.stringify(catAgentEvents).includes(catAgentCredential), false);
  assert.equal(catAgentEvents[3].block.text, 'direct API [credential redacted]');
  assert.deepEqual(catAgentEvents[4].block.input, { query: '[credential redacted]', name: 'preserved' });
  assert.equal(catAgentEvents[6].stopReason, 'end_turn');

  const openAgyOutput = createAgentAccessAgyOutput(runtime.inventoryStore, runtime.supervisor);
  const agy = await openAgyOutput();
  const nativeAgyCapture = process.env.AGENT_ACCESS_TEST_AGY_CAPTURE;
  const agyRecorded = (
    await readFile(
      nativeAgyCapture ?? new URL('./fixtures/agy-stream-json/followup-default.ndjson', import.meta.url),
      'utf8',
    )
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((event) => event.event);
  const agyInit = agyRecorded[0].init;
  const agyExpected = {
    agentName: agyInit.agent,
    spawnCwd: agyInit.cwd,
    model: agyInit.model,
    permissionMode: agyInit.permission_mode,
  };
  const agyEvents = () =>
    (async function* () {
      yield* agyRecorded;
    })();
  const observedAgy = await Array.fromAsync(observeAgyNativeTurn(agyEvents(), agyExpected, undefined, true, agy));
  const agyTurns = observedAgy.filter(({ kind }) => kind === 'result').map(({ observed }) => observed.turn);
  assert.deepEqual(
    agyTurns.map(({ outcome }) => outcome),
    ['ok', 'ok'],
  );
  assert.match(agyTurns[0].finalText, nativeAgyCapture ? /AGY_LOOPBACK_FIRST/ : /A_DONE NONE/);
  assert.match(agyTurns[1].finalText, nativeAgyCapture ? /AGY_LOOPBACK_SECOND/ : /A_DONE PAPAYA/);
  assert.equal(agyTurns[1].toolCalls.length, 0);
  await assert.rejects(
    Array.fromAsync(
      observeAgyNativeTurn(agyEvents(), { ...agyExpected, sessionId: 'different-id' }, undefined, true, agy),
    ),
    /replaced the requested conversation/,
  );
  let forgeTerminal = false;
  const forgedAgy = await createAgentAccessAgyOutput(runtime.inventoryStore, {
    nativeActions: runtime.supervisor.nativeActions,
    async invoke(instanceId, method, input) {
      const output = await runtime.supervisor.invoke(instanceId, method, input);
      if (forgeTerminal) {
        return method === 'summarizeAgyTurn' ? { ...output, outcome: 'ok', upstreamStatus: 'SUCCESS' } : output;
      }
      if (method !== 'projectAgyOutput') return output;
      return (async function* () {
        for await (const frame of output) {
          yield frame.step?.stepType === 'agent_response'
            ? { ...frame, step: { ...frame.step, stepType: 'user_input' } }
            : frame;
        }
      })();
    },
  })();
  await assert.rejects(
    Array.fromAsync(observeAgyNativeTurn(agyEvents(), agyExpected, undefined, true, forgedAgy)),
    /invalid_agy_step_evidence/,
  );
  forgeTerminal = true;
  await assert.rejects(
    Array.fromAsync(
      observeAgyNativeTurn(
        (async function* () {
          for (const event of agyRecorded) {
            if (event.event !== 'result') yield event;
            else {
              yield { ...event, result: { ...event.result, status: 'ERROR' } };
              return;
            }
          }
        })(),
        agyExpected,
        undefined,
        true,
        forgedAgy,
      ),
    ),
    /invalid_agy_native_terminal_evidence/,
  );

  const acpCommands = [];
  const mcpSecret = 'fixture-host-held-mcp-value';
  const privatePrompt = 'Host-approved fixture prompt';
  const privateDshInput = 'Host-approved DSH follow-up';
  const heldWrite = Promise.withResolvers();
  const finishWrite = Promise.withResolvers();
  const heldIdleWrite = Promise.withResolvers();
  const finishIdleWrite = Promise.withResolvers();
  const heldPromptAdmission = Promise.withResolvers();
  const finishPromptAdmission = Promise.withResolvers();
  const earlyCancelReturned = Promise.withResolvers();
  const workerCancelReturned = Promise.withResolvers();
  const explicitCancelReceived = Promise.withResolvers();
  const idleCancelReceived = Promise.withResolvers();
  const attachAcp = createAgentAccessAcpProcess(runtime.inventoryStore, {
    nativeActions: runtime.supervisor.nativeActions,
    async invoke(instanceId, method, input) {
      if (method === 'acpDshTurn') {
        assert.equal(JSON.stringify(input).includes(privateDshInput), false);
        if (input.deliveryId === 'fabricated') {
          return {
            ok: true,
            result:
              input.operation === 'steer'
                ? { accepted: true, deliveryId: input.deliveryId, nativeTurnId: 12 }
                : { state: 'read', nativeTurnId: 12 },
          };
        }
      }
      if (method === AGENT_ACCESS_ACP_SESSION_ACTION) {
        acpCommands.push(input.operation);
        const crossing = JSON.stringify(input);
        assert.equal(crossing.includes(mcpSecret), false);
        assert.equal(crossing.includes(privatePrompt), false);
        if (input.operation === 'prompt' && input.sessionId === 'fixture-early-stop') {
          heldPromptAdmission.resolve();
          await finishPromptAdmission.promise;
        }
      }
      const result = await runtime.supervisor.invoke(instanceId, method, input);
      if (method === AGENT_ACCESS_ACP_SESSION_ACTION && input.operation === 'cancel') workerCancelReturned.resolve();
      if (
        method === AGENT_ACCESS_ACP_SESSION_ACTION &&
        input.operation === 'cancel' &&
        input.sessionId === 'fixture-early-stop'
      ) {
        earlyCancelReturned.resolve();
      }
      return result;
    },
  });
  const acp = new AgentAccessAcpRuntimeClient(
    {
      command: process.execPath,
      cwd: projectRoot,
      spawnFn(command, args, options) {
        const child = spawn(command, args, options);
        const write = child.stdin.write.bind(child.stdin);
        child.stderr.on('data', (chunk) => {
          const diagnostics = chunk.toString();
          if (diagnostics.includes('fixture-native-explicit-cancel')) explicitCancelReceived.resolve();
          if (diagnostics.includes('fixture-native-idle-cancel')) idleCancelReceived.resolve();
        });
        child.stdin.write = (line, callback) => {
          if (line.includes('fixture-idle-probe')) {
            return write(line, (error) => {
              heldIdleWrite.resolve();
              void finishIdleWrite.promise.then(() => callback(error));
            });
          }
          if (!line.includes('fixture-cancel-probe')) return write(line, callback);
          return write(line, (error) => {
            heldWrite.resolve();
            void finishWrite.promise.then(() => callback(error));
          });
        };
        return child;
      },
      args: [
        '-e',
        `
        let permissionPending;
        let peer;
        require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
          const { id, method, params, result } = JSON.parse(line);
          const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
          if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: {} } } });
          if (method === '_clowder/hello') {
            if (params.protocol !== 1) process.exit(6);
            send({ id, result: { protocol: 1, bridge: 'cat-cafe-dsh-turn', steer: true, nativeTurns: true } });
          }
          if (method === '_clowder/turn/steer') {
            if (params.text !== '${privateDshInput}' || params.expectedTurn !== 12) process.exit(7);
            const event = { sessionId: params.sessionId, deliveryId: params.deliveryId, nativeTurnId: 12 };
            send({ method: '_clowder/turn', params: { ...event, type: 'input_read' } });
            send({ id, result: { accepted: true, deliveryId: params.deliveryId, nativeTurnId: 12 } });
          }
          if (method === '_clowder/turn/status') send({ id, result: { state: 'read', nativeTurnId: 12 } });
          if (method === 'session/new' || method === 'session/resume') {
            if (params.mcpServers[0].env[0].value !== '${mcpSecret}') process.exit(2);
            send({ id, result: { sessionId: params.sessionId ?? 'same-acp-native' } });
          }
          if (method === 'session/prompt') {
            if (params.sessionId === 'fixture-early-stop') process.exit(4);
            if (['fixture-cancel-probe', 'fixture-idle-probe'].includes(params.prompt[0].text)) return;
            if (params.prompt[0].text === 'fixture-peer-probe') {
              peer = { id, sessionId: params.sessionId };
              send({ method: 'session/update', params: { sessionId: peer.sessionId, update: {
                sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'peer started' },
              } } });
              return;
            }
            if (params.prompt[0].text !== '${privatePrompt}') process.exit(2);
            permissionPending = { id, sessionId: params.sessionId };
            send({ id: 0, method: 'session/request_permission', params: { sessionId: params.sessionId } });
          }
          if (id === 0 && permissionPending) {
            if (result?.outcome?.optionId !== 'fixture-approved') process.exit(2);
            send({ method: 'session/update', params: { sessionId: permissionPending.sessionId, update: {
              sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'duplex ACP reply' },
            } } });
            send({ id: permissionPending.id, result: { stopReason: 'end_turn' } });
            permissionPending = undefined;
          }
          if (method === 'session/cancel') {
            if (params.sessionId === 'fixture-early-stop') process.exit(5);
            console.error(params.sessionId === 'fixture-watchdog' ? 'fixture-native-idle-cancel' : 'fixture-native-explicit-cancel');
            if (peer) {
              if (params.sessionId === peer.sessionId) process.exit(3);
              send({ id: peer.id, result: { stopReason: 'end_turn' } });
              peer = undefined;
            }
          }
        });
      `,
      ],
    },
    attachAcp,
  );
  try {
    assert.deepEqual(await acp.initialize(), {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: {} },
    });
    const mcp = [
      {
        name: 'cat-cafe-fixture',
        command: 'fixture',
        args: [],
        env: [
          { name: 'TOKEN', value: mcpSecret },
          { name: 'CAT_CAFE_CREDENTIAL_FILE', value: join(projectRoot, 'fixture.json') },
          { name: 'CAT_CAFE_CALLBACK_TOKEN', value: 'fixture-first-turn' },
          { name: 'CAT_CAFE_INVOCATION_ID', value: 'fixture-first-invocation' },
        ],
      },
    ];
    const { sessionId } = await acp.newSession(projectRoot, mcp);
    assert.equal(sessionId, 'same-acp-native');
    const historyId = 'fixture-existing-native-id-from-history';
    assert.equal((await acp.loadSession(historyId, projectRoot, mcp)).sessionId, historyId);
    const refreshedMcp = mcp.map((server) => ({
      ...server,
      env: server.env.map(({ name, value }) => ({
        name,
        value: ['CAT_CAFE_CALLBACK_TOKEN', 'CAT_CAFE_INVOCATION_ID'].includes(name) ? value + '-next' : value,
      })),
    }));
    const unsupported = { type: 'http', name: 'unsupported-http', url: 'http://127.0.0.1:1/mcp', headers: [] };
    assert.equal((await acp.loadSession(historyId, projectRoot, [unsupported, ...refreshedMcp])).sessionId, historyId);
    acp.setSessionPermissionHandler(historyId, (request, respond) => {
      assert.equal(request.id, 0);
      respond({ optionId: 'fixture-approved' });
    });
    const turn = acp.promptStream(historyId, privatePrompt);
    assert.deepEqual((await turn.next()).value.update.content, { type: 'text', text: 'duplex ACP reply' });
    assert.deepEqual(await turn.next(), { done: true, value: 'end_turn' });
    assert.equal(acp.hasPromptFinalResponse(historyId), true);
    assert.equal(acp.isSessionSafeForReuse(historyId), true);
    assert.deepEqual(acpCommands, ['newSession', 'loadSession', 'loadSession', 'prompt']);
    assert.deepEqual(await acp.probeTurnBridge(), {
      protocol: 1,
      bridge: 'cat-cafe-dsh-turn',
      steer: true,
      nativeTurns: true,
    });
    const dshReceipts = [];
    const unsubscribeDsh = acp.onTurnBridgeEvent((event) => dshReceipts.push(event));
    assert.deepEqual(
      await acp.steerTurn({ sessionId: historyId, deliveryId: 'follow-up', text: privateDshInput, expectedTurn: 12 }),
      { accepted: true, deliveryId: 'follow-up', nativeTurnId: 12 },
    );
    assert.deepEqual(dshReceipts, [
      { sessionId: historyId, deliveryId: 'follow-up', nativeTurnId: 12, type: 'input_read' },
    ]);
    assert.deepEqual(await acp.inspectTurnInput(historyId, 'follow-up'), { state: 'read', nativeTurnId: 12 });
    await assert.rejects(
      acp.steerTurn({ sessionId: historyId, deliveryId: 'fabricated', text: privateDshInput, expectedTurn: 12 }),
      /disagrees with native receipt/,
    );
    await assert.rejects(acp.inspectTurnInput(historyId, 'fabricated'), /disagrees with native receipt/);
    unsubscribeDsh();
    const peer = acp.promptStream(sessionId, 'fixture-peer-probe');
    assert.equal((await peer.next()).value.update.content.text, 'peer started');
    const peerDone = peer.next();
    void peerDone.catch(() => {});
    const parkedTurn = acp.promptStream(historyId, 'fixture-cancel-probe');
    const parkedOutcome = parkedTurn.next().catch((error) => error);
    await heldWrite.promise;
    acp.cancelSession(historyId);
    await workerCancelReturned.promise;
    finishWrite.resolve();
    await Promise.race([
      explicitCancelReceived.promise,
      wait(2_000).then(() => assert.fail('native cancel was not written')),
    ]);
    assert.equal((await parkedOutcome).name, 'AcpSessionCancelledError');
    assert.deepEqual(await peerDone, { done: true, value: 'end_turn' });
    const watchdogId = 'fixture-watchdog';
    assert.equal((await acp.loadSession(watchdogId, projectRoot, mcp)).sessionId, watchdogId);
    const idle = acp.promptStream(watchdogId, 'fixture-idle-probe', { idleWarningMs: 25, idleStallMs: 100 });
    const idleFailure = assert.rejects(
      async () => {
        for await (const _ of idle) {
          // The idle warning can precede the terminal.
        }
      },
      { name: 'AcpStreamIdleError' },
    );
    await heldIdleWrite.promise;
    await idleFailure;
    acp.cancelSession(watchdogId);
    finishIdleWrite.resolve();
    await Promise.race([
      idleCancelReceived.promise,
      wait(2_000).then(() => assert.fail('idle cancel was not written')),
    ]);
    assert.equal(acp.isAlive, true);
    assert.equal((await acp.newSession(projectRoot, mcp)).sessionId, sessionId);
    const earlyId = 'fixture-early-stop';
    assert.equal((await acp.loadSession(earlyId, projectRoot, mcp)).sessionId, earlyId);
    const early = acp.promptStream(earlyId, 'fixture must not reach stdin');
    const earlyFailure = assert.rejects(early.next(), { name: 'AcpSessionCancelledError' });
    await heldPromptAdmission.promise;
    acp.cancelSession(earlyId);
    await earlyCancelReturned.promise;
    finishPromptAdmission.resolve();
    await earlyFailure;
    assert.equal(acp.hasUnconfirmedPrompt(earlyId), false);
    assert.equal(acp.isSessionSafeForReuse(earlyId), true);
    assert.equal(acp.isAlive, true);
    assert.equal((await acp.newSession(projectRoot, mcp)).sessionId, sessionId);
  } finally {
    finishWrite.resolve();
    finishIdleWrite.resolve();
    finishPromptAdmission.resolve();
    await acp.close();
  }

  const httpAcp = new AgentAccessAcpRuntimeClient(
    {
      command: process.execPath,
      cwd: projectRoot,
      args: [
        '-e',
        `
        let session = 0;
        let unrelatedResponseId;
        let parked;
        const server = require('node:http').createServer(async (req, res) => {
          const parts = [];
          for await (const part of req) parts.push(part);
          const { method, id, params } = JSON.parse(Buffer.concat(parts).toString('utf8'));
          const reply = (data) => JSON.stringify({ jsonrpc: '2.0', ...data }) + '\\n';
          if (!method && id === 'fixture-http-permission') return res.writeHead(500).end();
          if (method === 'initialize') return res.end(reply({ id, result: { protocolVersion: 1 } }));
          if (method === 'session/new') return res.end(reply({ id, result: { sessionId: 'loopback-http-' + (++session) } }));
          if (method === 'session/cancel') return res.end();
          if (method !== 'session/prompt') return res.writeHead(404).end();
          res.write(reply({
            method: 'session/update', params: { sessionId: params.sessionId, update: {
              sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'loopback ACP HTTP response' },
            } },
          }));
          if (params.prompt[0].text === 'permission callback fails') {
            res.write(reply({
              method: 'session/request_permission', id: 'fixture-http-permission',
              params: { sessionId: params.sessionId, toolCall: { toolCallId: 'http-fixture' },
                options: [{ optionId: 'deny', kind: 'reject_once', name: 'Deny' }] },
            }));
            res.end(reply({ id, result: { stopReason: 'end_turn' } }));
            return;
          }
          if (params.prompt[0].text === 'close without final response') {
            unrelatedResponseId = id;
            parked = res;
            return;
          }
          if (params.prompt[0].text === 'completed') {
            const inject = () => {
              if (!parked) return setTimeout(inject, 5);
              res.write(reply({ id: unrelatedResponseId, result: { stopReason: 'end_turn' } }));
              res.write(reply({ method: 'session/update', params: {
                sessionId: 'loopback-http-2', update: {
                  sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'unrelated stream injection' },
                },
              } }));
              parked.end();
            };
            inject();
          }
          setTimeout(() => res.end(reply({ id, result: { stopReason: 'end_turn' } })), 100);
        });
        server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
      `,
      ],
    },
    attachAcp,
    'httpstream',
  );
  try {
    assert.equal((await httpAcp.initialize()).protocolVersion, 1);
    const { sessionId: goodId } = await httpAcp.newSession();
    const { sessionId: failedId } = await httpAcp.newSession();
    const good = httpAcp.promptStream(goodId, 'completed');
    const failed = httpAcp.promptStream(failedId, 'close without final response');
    const [goodText, failedText] = await Promise.all([good.next(), failed.next()]);
    assert.equal(goodText.value.update.content.text, 'loopback ACP HTTP response');
    assert.equal(failedText.value.update.content.text, 'loopback ACP HTTP response');
    await assert.rejects(failed.next(), /ACP HTTP stream closed before the final prompt response/);
    assert.equal(httpAcp.hasPromptFinalResponse(failedId), false);
    assert.equal(httpAcp.isSessionSafeForReuse(failedId), false);
    assert.deepEqual(await good.next(), { done: true, value: 'end_turn' });
    assert.equal(httpAcp.hasPromptFinalResponse(goodId), true);
    const rejectPermission = httpAcp.promptStream(failedId, 'permission callback fails');
    const unaffected = httpAcp.promptStream(goodId, 'second concurrent success');
    assert.equal((await rejectPermission.next()).value.update.content.text, 'loopback ACP HTTP response');
    assert.equal((await unaffected.next()).value.update.content.text, 'loopback ACP HTTP response');
    assert.equal((await rejectPermission.next()).value.update.sessionUpdate, 'permission_pending');
    await assert.rejects(rejectPermission.next(), /ACP HTTP returned status 500/);
    assert.deepEqual(await unaffected.next(), { done: true, value: 'end_turn' });
    assert.equal(httpAcp.isAlive, true);
  } finally {
    await httpAcp.close();
  }

  const selectModel = createAgentAccessAcpModelSelection(runtime.inventoryStore, runtime.supervisor);
  const planCodexExec = createAgentAccessCodexExecLaunchPlanner(runtime.inventoryStore, runtime.supervisor);
  const codexRequest = { sessionId: 'codex-history', readOnly: true, groups: { sandbox: 'opaque-sandbox-group' } };
  const codexLaunch = await planCodexExec(codexRequest);
  assert.deepEqual(codexLaunch.args, ['exec', 'resume', 'codex-history', '--json', 'opaque-sandbox-group', '--', '-']);
  const reasoning = {
    type: 'item.completed',
    item: { type: 'reasoning', text: 'legacy summary', content: 'new summary' },
  };
  assert.equal(
    JSON.parse(transformCodexEvent(reasoning, 'codex', undefined, { execOutput: codexLaunch.output }).content).text,
    'legacy summary',
  );
  assert.deepEqual(await runtime.supervisor.invoke(installed.pluginInstanceId, 'planCodexLogin', {}), [
    '-c',
    'cli_auth_credentials_store="file"',
    'login',
  ]);
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
  const previousAcpWire = await archive(
    '1.0.6',
    1,
    OFFICIAL_AGENT_ACCESS_OPERATIONS.map((method) =>
      method === AGENT_ACCESS_ACP_SESSION_ACTION ? 'acpSession' : method,
    ),
  );
  await assert.rejects(install(previousAcpWire), /missing operations .*acpSessionV2/);
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
  await assert.rejects(codexLaunch.assertCurrent(), /session_implementation_unavailable/);
  assert.equal(latest.pluginInstanceId, installed.pluginInstanceId);
  const afterUpdate = await scan();
  assert.equal(afterUpdate.readiness.state, 'ready');
  assert.equal(afterUpdate.candidates.find((candidate) => candidate.id === 'kimi')?.label, 'Kimi vNext');
  await assert.rejects(() => firstProjection.assertCurrent(), /session_implementation_unavailable/);
  const updatedProjection = await loadNotificationProjection();
  assert.ok(updatedProjection?.ignoredMethods.has('transport/debug/ignored'));
  assert.equal(updatedProjection?.ignoredMethods.has('remoteControl/status/changed'), false);
  const updatedCodexLaunch = await planCodexExec(codexRequest);
  assert.deepEqual(updatedCodexLaunch.args, codexLaunch.args);
  assert.equal(
    JSON.parse(transformCodexEvent(reasoning, 'codex', undefined, { execOutput: updatedCodexLaunch.output }).content)
      .text,
    'new summary',
  );
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
  assert.equal(transcript.signal.aborted, true);
  await assert.rejects(transcript.project([]));
  await assert.rejects(Array.fromAsync(catAgentOutput.read(new Response('').body)));

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
  assert.ok((await loadNotificationProjection())?.ignoredMethods.has('remoteControl/status/changed'));
  const restoredCodexLaunch = await planCodexExec(codexRequest);
  assert.deepEqual(restoredCodexLaunch.output, codexLaunch.output);
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
