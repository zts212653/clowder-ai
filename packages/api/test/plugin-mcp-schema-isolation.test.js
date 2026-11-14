import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  invocationPluginMcpIssues,
  withInvocationPluginMcpView,
} from '../dist/config/capabilities/invocation-plugin-mcp-view.js';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import {
  resolveAcpMcpServers,
  resolveDisabledServerIds,
} from '../dist/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';
import { inspectPluginMcpSchema } from '../dist/domains/plugin/declared/mcp-schema-admission.js';
import { NativeMcpLaunches } from '../dist/domains/plugin/declared/native-mcp-launches.js';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';
import { fixture, policy } from './helpers/native-plugin-launch-fixture.js';

test('a malformed optional MCP contribution cannot enter either member transport or poison normal Host tools', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-schema-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const admission = {
    instance: {
      pluginInstanceId: 'instance',
      pluginId: 'fixture',
      packageDigest: 'digest',
      activationState: 'enabled',
      lifecycleState: 'installed',
      configReadiness: 'ready',
    },
    packageRecord: {
      packageDigest: 'digest',
      packageState: 'installed',
      manifest: {
        runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
        contributions: ['broken', 'healthy'].map((id) => ({
          type: 'mcp',
          id,
          runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
          sharedFactory: { module: 'dist/server.js', export: 'create' },
        })),
      },
    },
  };
  const read = async () => structuredClone(admission);
  const actions = new NativePluginActions(read);
  t.after(() => actions.deactivateAll());
  actions.activate(admission, 0, async () => ({}));
  const launches = new NativeMcpLaunches(read, actions);
  launches.activate(
    admission,
    0,
    ['broken', 'healthy'].map((contributionId) => ({
      contributionId,
      server: {
        name: `plugin__fixture__${contributionId}`,
        command: process.execPath,
        args: ['dist/mcp.js'],
        env: actions.environment('instance', contributionId),
        workingDirectory: root,
        transport: 'stdio',
      },
    })),
    new Map([['healthy', () => ({ connect: async () => {}, close: async () => {} })]]),
    new Map([['broken', 'tool_schema_invalid']]),
  );
  const config = {
    version: 2,
    capabilities: [
      {
        id: 'cat-cafe-memory',
        type: 'mcp',
        source: 'cat-cafe',
        enabled: true,
        mcpServer: { command: process.execPath, args: ['memory.js'] },
      },
      ...['broken', 'healthy'].map((id) => ({
        id: `plugin:fixture:${id}`,
        type: 'mcp',
        source: 'plugin',
        pluginId: 'fixture',
        enabled: true,
        mcpServer: { command: process.execPath, args: ['dist/mcp.js'] },
      })),
    ],
  };
  const view = await launches.memberView(root);
  const sources = await withInvocationPluginMcpView(
    async () => {
      const servers = await resolveAcpMcpServers(root, [], undefined, {
        mcpSupport: true,
        disabledServerIds: resolveDisabledServerIds(root, 'member', config),
        catId: 'member',
        capabilitiesConfig: config,
        configSourceRoot: root,
      });
      assert.deepEqual(
        invocationPluginMcpIssues(),
        [{ pluginId: 'fixture', capabilityId: 'plugin:fixture:broken', reasonCode: 'tool_schema_invalid' }],
        'the real disabled-policy → server-resolution sequence must retain the rejection diagnosis',
      );
      return servers;
    },
    view,
    { kind: 'member', projectRoot: root, memberCatId: 'member' },
  );
  assert.ok(sources.some(({ name }) => name === 'cat-cafe-memory'));
  assert.ok(sources.some(({ name }) => name === 'plugin__fixture__healthy'));
  assert.ok(
    !sources.some(({ name }) => name === 'plugin__fixture__broken'),
    'bad optional schema must not reach a basic prompt',
  );
  await assert.rejects(
    launches.resolve({ mode: 'plugin_native', pluginInstanceId: 'instance', contributionId: 'broken' }),
    /schema|工具定义/i,
    'the direct stdio capability path must report why it is unavailable',
  );
  const broken = view.entries.find(({ capabilityId }) => capabilityId.endsWith(':broken'));
  assert.equal(broken?.sharedHttpUnavailableReason, 'tool_schema_invalid');
  await assert.rejects(launches.resolveShared('instance', 'broken', 'guessed'), /schema|工具定义/i);
  let sentPrompt = '';
  let mounted = [];
  const client = {
    newSession: async (_cwd, servers) => {
      mounted = servers;
      return { sessionId: 'same-member-session' };
    },
    setSessionConfigOption: async () => {},
    async *promptStream(sessionId, prompt) {
      sentPrompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
      yield {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi works' } },
      };
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    recentCapacitySignal: null,
  };
  const service = new AcpAgentService({
    catId: 'codex',
    projectRoot: root,
    mcpServers: sources,
    mcpSupport: true,
    modelName: 'fixture',
    poolKey: { projectPath: root, providerProfile: 'fixture' },
    pool: {
      acquire: async (poolKey) => ({ client, poolKey, release() {}, closeTurn: async () => {} }),
      rememberSession() {},
    },
  });
  const frozen = await withInvocationPluginMcpView(
    async () => {
      await resolveAcpMcpServers(root, [], undefined, {
        mcpSupport: true,
        catId: 'codex',
        capabilitiesConfig: config,
        configSourceRoot: root,
      });
      return service.captureInvocationOptions({});
    },
    view,
    { kind: 'member', projectRoot: root, memberCatId: 'codex' },
  );
  assert.equal(frozen.frozenAcpMcpIssues[0].capabilityId, 'plugin:fixture:broken');
  const messages = await withInvocationPluginMcpView(
    async () => {
      const events = [];
      for await (const message of service.invoke('hi', frozen)) events.push(message);
      return events;
    },
    view,
    { kind: 'member', projectRoot: root, memberCatId: 'codex' },
  );
  assert.ok(messages.some((message) => message.type === 'system_info' && message.content.includes('暂不可用')));
  assert.ok(messages.some((message) => message.type === 'text' && message.content.includes('hi works')));
  assert.ok(
    sentPrompt.includes('plugin:fixture:broken'),
    'the model must know which optional capability is unavailable',
  );
  assert.ok(
    mounted.some(({ name }) => name === 'cat-cafe-memory'),
    'a basic reply still has real Host tool definitions',
  );
  assert.ok(!mounted.some(({ name }) => name === 'plugin__fixture__broken'));
  const unrelated = await withInvocationPluginMcpView(
    async () => {
      await resolveAcpMcpServers(root, ['cat-cafe-memory'], undefined, {
        mcpSupport: true,
        disabledServerIds: resolveDisabledServerIds(root, 'member', config),
        catId: 'member',
        capabilitiesConfig: config,
        configSourceRoot: root,
      });
      return invocationPluginMcpIssues(['cat-cafe-memory']);
    },
    view,
    { kind: 'member', projectRoot: root, memberCatId: 'member' },
  );
  assert.deepEqual(unrelated, [], 'a tool not selected by the member must not produce an unrelated warning');
  const blocked = await withInvocationPluginMcpView(
    async () => {
      const blockedConfig = {
        ...config,
        capabilities: config.capabilities.map((capability) =>
          capability.id === 'plugin:fixture:broken' ? { ...capability, blockedCats: ['member'] } : capability,
        ),
      };
      await resolveAcpMcpServers(root, [], undefined, {
        mcpSupport: true,
        disabledServerIds: resolveDisabledServerIds(root, 'member', blockedConfig),
        catId: 'member',
        configSourceRoot: root,
        capabilitiesConfig: blockedConfig,
      });
      return invocationPluginMcpIssues();
    },
    view,
    { kind: 'member', projectRoot: root, memberCatId: 'member' },
  );
  assert.deepEqual(blocked, [], 'a disabled optional capability must not produce a connection warning');
});

test('the activation boundary reads later pages and rejects the actual attachment escapes without executing actions', async () => {
  for (const pattern of ['^collective\\-attachment\\:', '^collective-attachment:']) {
    const cursors = [];
    let executed = 0;
    let closed = 0;
    const issue = await inspectPluginMcpSchema(() => {
      const server = new Server({ name: 'original-plugin-factory', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
        cursors.push(params?.cursor);
        return params?.cursor
          ? {
              tools: [
                {
                  name: 'reply',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      contentRef: { type: 'string', pattern },
                      mediaType: { type: 'string', pattern: '^[a-z0-9.+-]+\\/[a-z0-9.+-]+$' },
                    },
                  },
                },
              ],
            }
          : { tools: [{ name: 'read', inputSchema: { type: 'object' } }], nextCursor: 'second' };
      });
      server.setRequestHandler(CallToolRequestSchema, async () => {
        executed++;
        return { content: [{ type: 'text', text: 'must not execute' }] };
      });
      return {
        connect: server.connect.bind(server),
        close: async () => {
          closed++;
          await server.close();
        },
      };
    });
    assert.deepEqual(cursors, [undefined, 'second']);
    assert.equal(issue, pattern.includes('\\') ? 'tool_schema_invalid' : undefined);
    assert.equal(executed, 0);
    assert.equal(closed, 1);
  }
});

for (const pattern of ['^collective\\-attachment\\:', '^collective-attachment:']) {
  test(`the actual Host contribution registration admits only usable schemas: ${pattern}`, async (t) => {
    const factory = () => {
      const server = new Server({ name: 'activation-fixture', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: 'reply', inputSchema: { type: 'object', properties: { contentRef: { type: 'string', pattern } } } },
        ],
      }));
      return server;
    };
    const f = await fixture(t, { factory });
    await f.router.start('instance-a');
    const view = await f.router.resolveMemberMcpView();
    const entry = view.entries[0];
    assert.ok(entry);
    if (pattern.includes('\\')) {
      assert.equal(entry.isCurrent(), true, 'the activation is current; only this tool capability is unavailable');
      assert.equal(entry.sharedHttpUnavailableReason, 'tool_schema_invalid');
      await assert.rejects(f.router.resolveNativeMcpLaunch(policy()), /schema/i);
    } else {
      assert.equal(entry.isCurrent(), true);
      assert.ok(entry.sharedHttpPath);
      assert.equal(
        (await f.router.resolveNativeMcpLaunch(policy())).name,
        'plugin__dev.clowder.native-launch-fixture__native',
      );
    }
  });
}

for (const [label, brokenTool] of [
  ['non-object root inputSchema', { name: 'broken', inputSchema: { type: 'string' } }],
  ['malformed required list on inputSchema', { name: 'broken', inputSchema: { type: 'object', required: 'bad' } }],
  [
    'invalid regex pattern in outputSchema',
    {
      name: 'broken',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { value: { type: 'string', pattern: '[' } } },
    },
  ],
]) {
  test(`protocol-level tools/list and outputSchema violations isolate both transports: ${label}`, async (t) => {
    const f = await fixture(t, {
      factory: () => {
        const server = new Server({ name: 'protocol-invalid-fixture', version: '1' }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [brokenTool] }));
        return server;
      },
    });
    await f.router.start('instance-a');
    const view = await f.router.resolveMemberMcpView();
    assert.equal(view.entries[0]?.isCurrent(), true);
    assert.equal(view.entries[0]?.sharedHttpUnavailableReason, 'tool_schema_invalid');
    await assert.rejects(f.router.resolveNativeMcpLaunch(policy()), /schema/i);

    const baseConfig = f.config();
    const memoryCap = {
      id: 'cat-cafe-memory',
      type: 'mcp',
      source: 'cat-cafe',
      enabled: true,
      mcpServer: { command: process.execPath, args: ['memory.js'] },
    };
    const config = { ...baseConfig, capabilities: [memoryCap, ...baseConfig.capabilities] };
    const root = view.localCapabilityRoot;
    const servers = await withInvocationPluginMcpView(
      async () => {
        const resolved = await resolveAcpMcpServers(root, [], undefined, {
          mcpSupport: true,
          disabledServerIds: resolveDisabledServerIds(root, 'member', config),
          catId: 'member',
          capabilitiesConfig: config,
          configSourceRoot: root,
        });
        assert.deepEqual(invocationPluginMcpIssues(), [
          {
            pluginId: 'dev.clowder.native-launch-fixture',
            capabilityId: 'plugin:dev.clowder.native-launch-fixture:native',
            reasonCode: 'tool_schema_invalid',
          },
        ]);
        return resolved;
      },
      view,
      { kind: 'member', projectRoot: root, memberCatId: 'member' },
    );
    assert.ok(servers.some(({ name }) => name === 'cat-cafe-memory'));
    assert.ok(!servers.some(({ name }) => name === 'plugin__dev.clowder.native-launch-fixture__native'));
  });
}

for (const [label, brokenFactory] of [
  [
    'factory construction throw',
    () => {
      throw new Error('shared factory module failed');
    },
  ],
  [
    'tools/list handler runtime throw',
    () => {
      const server = new Server({ name: 'runtime-throw-fixture', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        throw new Error('unexpected runtime failure during listTools');
      });
      return server;
    },
  ],
]) {
  test(`genuine sharedFactory runtime failure keeps shared_factory_load_failed and stdio fallback: ${label}`, async (t) => {
    const f = await fixture(t, { factory: brokenFactory });
    await f.router.start('instance-a');
    const view = await f.router.resolveMemberMcpView();
    assert.equal(view.entries[0]?.sharedHttpUnavailableReason, 'shared_factory_load_failed');
    assert.equal(
      (await f.router.resolveNativeMcpLaunch(policy())).name,
      'plugin__dev.clowder.native-launch-fixture__native',
    );
  });
}
