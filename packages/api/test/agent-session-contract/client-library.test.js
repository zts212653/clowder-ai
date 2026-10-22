import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { projectSessionEvent } from '../../dist/domains/cats/services/agents/session-contract/event-projection.js';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import * as library from '../../dist/domains/cats/services/agents/session-contract/plugin-agent-provider.js';
import { RegisteredSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';

test('a data-only client library references one configuration field', () => {
  assert.deepEqual(library.parseAgentProviderDeclaration({ configurationKey: 'clients' }, { packageRoot: '/pkg' }), {
    ok: true,
    declaration: { configurationKey: 'clients' },
  });
});

test('owner configured client profiles retain argv boundaries and reject duplicates and package executables', () => {
  const root = resolve('client-library-fixture');
  const packageRoot = join(root, 'plugin');
  const raw = JSON.stringify([
    {
      id: 'dsh',
      name: 'DeepSeek Harness',
      command: join(root, 'Program Files', 'DSH', 'dsh.exe'),
      startupArgs: ['--profile', 'acp'],
    },
  ]);
  const parsed = library.parseAgentClientProfiles(raw, { packageRoot });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.profiles[0].acp.startupArgs, ['--profile', 'acp']);
  for (const invalid of [
    raw.replace('dsh.exe', 'dsh.exe\u0000'),
    JSON.stringify([JSON.parse(raw)[0], JSON.parse(raw)[0]]),
    JSON.stringify([{ id: 'evil', name: 'x', command: join(packageRoot, 'evil.exe'), startupArgs: [] }]),
    JSON.stringify([{ id: 'x', name: 'x', command: 'node', startupArgs: [], env: { TOKEN: 'not-allowed' } }]),
    '[]'.repeat(40000),
  ])
    assert.equal(library.parseAgentClientProfiles(invalid, { packageRoot }).ok, false);
});

test('persistent plugin reference is strict and never becomes an executable fallback', () => {
  assert.deepEqual(library.parsePluginAgentRef('plugin:official.acp-clients/dsh'), {
    pluginId: 'official.acp-clients',
    contributionId: 'dsh',
  });
  for (const ref of ['', 'builtin:acp', 'plugin:../../escape/x', 'plugin:p/x/y'])
    assert.equal(library.parsePluginAgentRef(ref), undefined);
});

test('saved member choices override legacy bindings and malformed choices fail closed', async () => {
  const legacy = { pluginId: 'legacy', contributionId: 'client' };
  assert.deepEqual(library.resolveMemberSessionRef('plugin:official.acp-clients/dsh', legacy), {
    pluginId: 'official.acp-clients',
    contributionId: 'dsh',
  });
  assert.deepEqual(library.resolveMemberSessionRef(undefined, legacy), legacy);
  assert.equal(library.resolveMemberSessionRef(null, legacy, 'plugin:old/nested'), undefined);
  assert.deepEqual(library.resolveMemberSessionRef(undefined, legacy, 'plugin:old/nested'), {
    pluginId: 'old',
    contributionId: 'nested',
  });
  const registry = new SessionImplementationRegistry();
  registry.register(legacy, () => assert.fail('fell back to the legacy binding'));
  registry.register({ pluginId: 'invalid', contributionId: 'invalid' }, () =>
    assert.fail('used a valid plugin coordinate for invalid data'),
  );
  const service = new RegisteredSessionAgentService({
    catId: 'codex',
    registry,
    ref: library.resolveMemberSessionRef('malformed', legacy),
  });
  const messages = [];
  for await (const message of service.invoke('x', { hostSessionId: 'host' })) messages.push(message);
  assert.equal(messages[0].errorCode, 'session_implementation_unavailable');
});

test('a disabled client tells the owner how to recover while retaining the machine error code', async () => {
  const service = new RegisteredSessionAgentService({
    catId: 'codex',
    registry: new SessionImplementationRegistry(),
    ref: { pluginId: 'official.acp-clients', contributionId: 'dsh' },
  });
  const messages = [];
  for await (const message of service.invoke('x', { hostSessionId: 'host' })) messages.push(message);
  assert.equal(messages[0].errorCode, 'session_implementation_unavailable');
  assert.match(messages[0].error, /插件.*启用/);
});

test('the plugin bridge preserves failed and unknown ACP tool result statuses', async () => {
  const provider = new AcpSessionProvider({
    catId: 'codex',
    service: {
      async *invoke() {
        for (const status of ['error', 'ok', undefined])
          yield {
            type: 'tool_result',
            toolName: 'read',
            toolUseId: 'call',
            toolResultStatus: status,
            toolInput: { path: 'missing.txt' },
            toolRawPayload: { status: 'failed' },
            content: 'result',
            catId: 'codex',
            timestamp: 1,
          };
      },
    },
  });
  await provider.openSession({ sessionId: 'host' });
  const started = await provider.startTurn(
    'host',
    { invocation: { invocationId: 'inv', callbackEnv: {}, mcpServers: [] }, prompt: { kind: 'frozen', text: 'x' } },
    new AbortController().signal,
  );
  const messages = [];
  for await (const event of started.events)
    messages.push(...projectSessionEvent(event, { catId: 'codex', metadata: { provider: 'acp', model: 'test' } }));
  assert.deepEqual(
    messages.filter((message) => message.type === 'tool_result').map((message) => message.toolResultStatus),
    ['error', 'ok', 'unknown'],
  );
  assert.deepEqual(messages[0].toolInput, { path: 'missing.txt' });
  assert.deepEqual(messages[0].toolRawPayload, { status: 'failed' });
});
