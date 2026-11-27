import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { grantAgentAdapterClaudePrint } from '../dist/domains/plugin/declared/agent-adapter-claude-native-grant.js';
import { grantAgentAdapterNativeRuntime } from '../dist/domains/plugin/declared/agent-adapter-native-grant.js';
import { setup } from './helpers/agent-adapter-archive.js';

const archive = process.env.CLOWDER_CLAUDE_CANDIDATE_ARCHIVE;
const executable = process.env.CLOWDER_CLAUDE_CANDIDATE_EXECUTABLE;

function loopbackServer(handled) {
  return createServer(async (request, response) => {
    const chunks = await Array.fromAsync(request);
    if (request.url?.endsWith('/count_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 12 }));
      return;
    }
    if (!request.url?.includes('/v1/messages')) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    handled.push(body);
    const text = 'host-loopback-claude-reply-' + handled.length;
    const usage = { input_tokens: 12, output_tokens: 4 };
    const message = {
      id: 'msg_host_fixture_' + handled.length,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    };
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...message, stop_reason: 'end_turn', content: [{ type: 'text', text }] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage },
      { type: 'message_stop' },
    ]) {
      response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    }
    response.end();
  });
}

test(
  'the independent Claude Code archive detects, prints and resumes the same native session through the Host bridge',
  {
    skip: !archive || !executable,
    timeout: 60_000,
  },
  async (t) => {
    const ref = { pluginId: 'official.agent-claude-code', contributionId: 'claude-code' };
    const registry = new SessionImplementationRegistry();
    const { runtime, manager } = await setup(t, registry, (request) => grantAgentAdapterClaudePrint(request));
    const root = runtime.projectRoot;
    const home = await mkdtemp(join(tmpdir(), 'claude-host-loopback-'));
    t.after(async () => {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    });

    const handled = [];
    const server = loopbackServer(handled);
    server.listen({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    t.after(() => new Promise((done) => server.close(done)));

    const env = {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      PATH: [dirname(executable), process.env.PATH ?? ''].filter(Boolean).join(';'),
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      TEMP: home,
      TMP: home,
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      ANTHROPIC_API_KEY: 'test-only-not-a-provider-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
      NO_PROXY: '127.0.0.1',
    };
    const executionAccount = {
      accountRef: 'claude-fixture',
      displayName: 'Claude fixture',
      authType: 'api_key',
      accountRevision: '1',
      credentialVersion: 'v1',
    };

    await manager.install({ source: { kind: 'local-archive', path: archive } });
    const { plugin } = await manager.get(ref.pluginId);
    await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });

    const detection = await runtime.agentAdapters.detect(ref);
    assert.equal(detection.candidates[0]?.state.status, 'ready', JSON.stringify(detection.candidates[0]));
    assert.match(detection.candidates[0].state.version, /^\d+\.\d+\.\d+/);
    assert.equal(detection.binding.ref, 'plugin:official.agent-claude-code/claude-code');
    t.diagnostic(`Host detection saw Claude Code ${detection.candidates[0].state.version}`);

    const service = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
    const role = { instructions: 'CLAUDE_HOST_IDENTITY_FIXTURE', model: 'claude-sonnet-4-6' };
    const launches = [];
    const first = await Array.fromAsync(
      service.invoke('CLAUDE_HOST_FIRST_FIXTURE', {
        hostSessionId: 'claude-first-host',
        workingDirectory: root,
        systemPrompt: role.instructions,
        executionAccount,
        callbackEnv: env,
        invocationId: 'claude-first-turn',
        beforeProviderLaunch: async (prepared) => {
          launches.push(prepared);
        },
      }),
    );
    const firstText = first.find((item) => item.type === 'text')?.content;
    assert.equal(firstText, 'host-loopback-claude-reply-1', JSON.stringify(first));
    const nativeSessionId = first.at(-1)?.metadata.sessionId;
    assert.match(nativeSessionId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    assert.equal(first.at(-1)?.errorCode, undefined);

    await service.releaseAll('test_first_turn_complete');
    const resumedService = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
    const second = await Array.fromAsync(
      resumedService.invoke('CLAUDE_HOST_SECOND_FIXTURE', {
        hostSessionId: 'claude-resume-host',
        sessionId: nativeSessionId,
        workingDirectory: root,
        systemPrompt: role.instructions,
        executionAccount,
        callbackEnv: env,
        invocationId: 'claude-second-turn',
        beforeProviderLaunch: async (prepared) => {
          launches.push(prepared);
        },
      }),
    );
    assert.equal(second.find((item) => item.type === 'text')?.content, 'host-loopback-claude-reply-2', JSON.stringify(second));
    assert.equal(second.at(-1)?.metadata.sessionId, nativeSessionId);
    assert.equal(second.at(-1)?.errorCode, undefined);
    assert.equal(handled.length, 2);
    assert.equal(launches.length, 2);
    assert.equal(launches[0].message.body, 'CLAUDE_HOST_FIRST_FIXTURE');
    assert.equal(launches[0].nativeInstructions[0].body, role.instructions);
    assert.equal(launches[0].runtime.provider, 'anthropic');
    assert.equal(launches[0].runtime.carrier, 'print_sdk');
    assert.equal(launches[0].runtime.toolExecutionPolicy, 'read_only');
    assert.equal(launches[1].message.body, 'CLAUDE_HOST_SECOND_FIXTURE');
    assert.equal(launches[1].nativeInstructions[0].body, role.instructions);
    assert.match(JSON.stringify(handled[1].system), /CLAUDE_HOST_IDENTITY_FIXTURE/);
    assert.match(JSON.stringify(handled[1].messages), /CLAUDE_HOST_FIRST_FIXTURE/);
    assert.match(JSON.stringify(handled[1].messages), /host-loopback-claude-reply-1/);
    assert.match(JSON.stringify(handled[1].messages), /CLAUDE_HOST_SECOND_FIXTURE/);
  },
);

test('the default Host grant detects Claude Code but does not authorize its sessions', {
  skip: !executable,
  timeout: 20_000,
}, async (t) => {
  const signal = new AbortController().signal;
  const request = {
    pluginId: 'official.agent-claude-code',
    contributionId: 'claude-code',
    packageDigest: 'sha512-fixture',
    pluginInstanceId: 'fixture-instance',
    activationSignal: signal,
    packageProvenance: {
      kind: 'catalog',
      catalogId: 'agent-claude-code',
      packageName: '@clowder-ai/agent-claude-code',
    },
  };
  const detect = grantAgentAdapterNativeRuntime({ ...request, action: 'detect' });
  assert.ok(detect?.inspect);
  const state = await detect.inspect(signal);
  assert.equal(state.status, 'ready', JSON.stringify(state));
  assert.match(state.version, /^\d+\.\d+\.\d+/);
  t.diagnostic(`Default Host grant detected Claude Code ${state.version}`);
  for (const action of ['openSession', 'startTurn', 'release']) {
    assert.equal(
      grantAgentAdapterNativeRuntime({ ...request, action }),
      undefined,
      `default Host grant must not authorize Claude ${action}`,
    );
  }
});

test('the default Host detects a Claude catalog install but cannot start its first session', {
  skip: !archive || !executable,
  timeout: 60_000,
}, async (t) => {
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const { createPluginManagerRuntimeComposition } = await import('../dist/domains/plugin/index.js');
  const ref = { pluginId: 'official.agent-claude-code', contributionId: 'claude-code' };
  const registry = new SessionImplementationRegistry();
  const { runtime } = await setup(t, registry);
  const bytes = await readFile(archive);
  const entry = {
    catalogId: 'agent-claude-code',
    packageName: '@clowder-ai/agent-claude-code',
    version: '0.1.0-alpha.1',
    pluginId: ref.pluginId,
    distribution: 'registry',
    archiveUrl: 'https://registry.npmjs.org/@clowder-ai/agent-claude-code/-/agent-claude-code-0.1.0-alpha.1.tgz',
    packageDigest: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  };
  const { manager } = createPluginManagerRuntimeComposition({
    runtime,
    catalogManifests: [
      {
        pluginId: ref.pluginId,
        version: entry.version,
        contractVersion: '0.4.0-candidate.0',
        name: 'Claude Code',
        features: [{ id: 'claude-code', name: 'Claude Code', resources: [] }],
        runtime: { transport: 'builtin', entrypoint: 'src/index.mjs', dataDirectory: 'agent-claude-code' },
      },
    ],
    catalogProvider: { snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: 0 }) },
    fetchOfficialArchive: async () => bytes,
    threads: { get: () => null },
  });
  await manager.install({
    source: { kind: 'catalog', catalogId: entry.catalogId },
    expectedVersion: entry.version,
    expectedDigest: entry.packageDigest,
  });
  const { plugin } = await manager.get(ref.pluginId);
  await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });

  const detection = await runtime.agentAdapters.detect(ref);
  assert.equal(detection.candidates[0]?.state.status, 'ready', JSON.stringify(detection.candidates[0]));
  t.diagnostic(`Default Host detection saw Claude Code ${detection.candidates[0].state.version}`);

  const service = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
  const messages = await Array.fromAsync(
    service.invoke('default host must not start a Claude session', {
      hostSessionId: 'default-claude-host',
      workingDirectory: runtime.projectRoot,
      systemPrompt: 'DEFAULT_HOST_CLAUDE_IDENTITY',
      executionAccount: {
        accountRef: 'claude-fixture',
        displayName: 'Claude fixture',
        authType: 'api_key',
        accountRevision: '1',
        credentialVersion: 'v1',
      },
      invocationId: 'default-claude-turn',
    }),
  );
  const error = messages.find((item) => item.type === 'error');
  assert.ok(error, JSON.stringify(messages));
  assert.equal(error.errorCode, 'failed');
  assert.match(String(error.error), /native_runtime_port_unavailable|native runtime port/i);
  t.diagnostic('Default Host detection was ready; session open was denied before a Worker could run.');
});


test('a failed beforeProviderLaunch registration prevents the Claude model request', {
  skip: !archive || !executable,
  timeout: 60_000,
}, async (t) => {
  const ref = { pluginId: 'official.agent-claude-code', contributionId: 'claude-code' };
  const registry = new SessionImplementationRegistry();
  const { runtime, manager } = await setup(t, registry, (request) => grantAgentAdapterClaudePrint(request));
  const root = runtime.projectRoot;
  const home = await mkdtemp(join(tmpdir(), 'claude-host-registration-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  });
  const handled = [];
  const server = loopbackServer(handled);
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));
  const env = {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    PATH: [dirname(executable), process.env.PATH ?? ''].filter(Boolean).join(';'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    TEMP: home,
    TMP: home,
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    ANTHROPIC_API_KEY: 'test-only-not-a-provider-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    NO_PROXY: '127.0.0.1',
  };
  await manager.install({ source: { kind: 'local-archive', path: archive } });
  const { plugin } = await manager.get(ref.pluginId);
  await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
  const service = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
  const messages = await Array.fromAsync(
    service.invoke('CLAUDE_REGISTRATION_FAILURE_FIXTURE', {
      hostSessionId: 'claude-registration-host',
      workingDirectory: root,
      systemPrompt: 'CLAUDE_REGISTRATION_IDENTITY',
      executionAccount: {
        accountRef: 'claude-fixture',
        displayName: 'Claude fixture',
        authType: 'api_key',
        accountRevision: '1',
        credentialVersion: 'v1',
      },
      callbackEnv: env,
      invocationId: 'claude-registration-turn',
      beforeProviderLaunch: async () => {
        throw new Error('registration_failed_before_spawn');
      },
    }),
  );
  const error = messages.find((item) => item.type === 'error');
  assert.ok(error, JSON.stringify(messages));
  assert.match(String(error.error), /registration_failed_before_spawn/);
  assert.equal(handled.length, 0);
  t.diagnostic('Registration failure produced no Claude model request.');
});

