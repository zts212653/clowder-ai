import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { prepareInvocationExecutionBinding } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';

for (const source of [
  'capabilities',
  'project-mcp',
  'registered-plugin',
  'plugin-mcp',
  'member-off',
  'member-on',
  'member-implicit-on',
]) {
  test(`actual ACP session uses admitted ${source} settings after a lease wait`, async (t) => {
    const artifacts = join(process.cwd(), 'artifacts', 'role-agent-refactor', 'acp-mcp-freeze');
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, 'fixture-'));
    const host = join(root, 'host');
    const project = join(root, 'project');
    mkdirSync(join(host, '.cat-cafe'), { recursive: true });
    mkdirSync(project);
    t.diagnostic(`retained isolated MCP fixture: ${root}`);
    const all = catRegistry.getAllConfigs();
    const id = 'acp-mcp-freeze';
    const pluginId = 'fixture-plugin';
    const capabilityId = source === 'plugin-mcp' ? `plugin:${pluginId}:native` : 'fixture-server';
    catRegistry.register(id, {
      ...all.codex,
      id,
      clientId: 'acp',
      configurationSource: 'managed_account',
      accountRef: undefined,
      defaultModel: 'fixture-model',
      mcpSupport: source === 'member-implicit-on' ? undefined : source !== 'member-off',
    });
    const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_PROJECT_ALLOWED_ROOTS'];
    const old = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CAT_CAFE_CONFIG_ROOT = host;
    process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = root;
    t.after(() => {
      old.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    });
    let viewMarker = 'before';
    const writeConfig = (marker) => {
      viewMarker = marker;
      const server = { command: process.execPath, args: [`--fixture=${marker}`], env: { FIXTURE_SCOPE: marker } };
      writeFileSync(
        join(host, '.cat-cafe', 'capabilities.json'),
        JSON.stringify({
          version: source === 'plugin-mcp' ? 2 : 1,
          capabilities:
            source !== 'project-mcp'
              ? [
                  {
                    id: capabilityId,
                    type: 'mcp',
                    enabled: true,
                    globalEnabled: true,
                    ...(source === 'plugin-mcp' ? { source: 'plugin', pluginId } : {}),
                    mcpServer: source === 'plugin-mcp' ? { ...server, args: ['--fixture=formal-unselected'] } : server,
                  },
                ]
              : [],
        }),
      );
      if (source === 'project-mcp' || source === 'member-off')
        writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'fixture-server': server } }));
    };
    writeConfig('before');
    let enter, release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    let sentServers;
    const client = {
      async newSession(_cwd, servers) {
        sentServers = servers;
        return { sessionId: 'mcp-frozen-session' };
      },
      async *promptStream() {
        yield {
          sessionId: 'mcp-frozen-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
        };
        return 'end_turn';
      },
      onCapacity() {},
      offCapacity() {},
      clearRecentCapacitySignal() {},
    };
    const service = new AcpAgentService({
      catId: id,
      projectRoot: host,
      mcpWhitelist: source !== 'project-mcp' ? [capabilityId] : [],
      mcpSupport: !['member-on', 'member-implicit-on'].includes(source),
      poolKey: { projectPath: host, providerProfile: id },
      pool: {
        async releaseSession() {},
        async acquire() {
          enter();
          await gate;
          return { client, release() {} };
        },
      },
    });
    let invocationService = service;
    if (source === 'registered-plugin') {
      const implementationRegistry = new SessionImplementationRegistry();
      const ref = { pluginId: 'fixture-plugin', contributionId: 'fixture-acp' };
      const provider = new AcpSessionProvider({ catId: id, service });
      Object.assign(provider, { hostService: () => service, bindHostService: () => provider });
      implementationRegistry.register(ref, () => provider);
      const registered = new RegisteredSessionAgentService({ catId: id, ref, registry: implementationRegistry });
      invocationService = registered.forInvocation();
      t.after(() => registered.releaseAll('owned_test_complete'));
    }
    const deps = {
      apiUrl: 'http://127.0.0.1:13004',
      ...(source === 'plugin-mcp'
        ? {
            resolveInvocationPluginMcpView: async () => ({
              entries: [
                {
                  capabilityId,
                  pluginId,
                  isCurrent: () => true,
                  server: {
                    command: process.execPath,
                    args: [`--fixture=${viewMarker}`],
                    env: { FIXTURE_SCOPE: viewMarker },
                    transport: 'stdio',
                    workingDir: host,
                  },
                },
              ],
            }),
          }
        : {}),
      threadStore:
        source === 'project-mcp' || source === 'member-off'
          ? { get: () => ({ id: 'thread', projectPath: project, createdBy: 'owner' }) }
          : null,
    };
    const binding = await prepareInvocationExecutionBinding(deps, {
      catId: id,
      threadId: 'thread',
      userId: 'owner',
      service: invocationService,
    });
    assert.ok(binding.providerOptions?.frozenAcpMcpServers, 'admission lost the concrete provider capture hook');
    assert.ok(Object.isFrozen(binding.providerOptions.frozenAcpMcpServers));
    if (source.startsWith('member-')) {
      const changed = catRegistry.getAllConfigs();
      catRegistry.reset();
      Object.entries(changed).forEach(([key, config]) =>
        catRegistry.register(key, key === id ? { ...config, mcpSupport: source === 'member-off' } : config),
      );
    }
    writeConfig('queued-after');
    const pending = Array.fromAsync(
      invocationService.invoke('isolated task', {
        ...binding.providerOptions,
        invocationId: 'mcp-fixture-invocation',
        ...(source === 'registered-plugin' ? { hostSessionId: 'logical-host-session' } : {}),
        workingDirectory: binding.workspace.workingDirectory,
      }),
    );
    await Promise.race([
      entered,
      pending.then((messages) => assert.fail(`provider ended before acquiring its lease: ${JSON.stringify(messages)}`)),
    ]);
    writeConfig('after');
    release();
    const messages = await pending;
    assert.deepEqual(
      messages.filter((message) => message.type === 'error'),
      [],
    );
    assert.equal(sentServers.length, source === 'member-off' ? 0 : 1);
    if (source === 'member-off') return;
    assert.deepEqual(sentServers[0].args, ['--fixture=before']);
    assert.equal(sentServers[0].env.find(({ name }) => name === 'FIXTURE_SCOPE')?.value, 'before');
  });
}
