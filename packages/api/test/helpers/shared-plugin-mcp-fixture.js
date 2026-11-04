import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { McpServer } from '../../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { currentPluginCallContext } from '../../dist/domains/plugin/carrier/plugin-call-context.js';
import { NativeMcpLaunches } from '../../dist/domains/plugin/declared/native-mcp-launches.js';
import { NativePluginActions } from '../../dist/domains/plugin/declared/native-plugin-actions.js';
import { registerPluginSharedMcpRoutes } from '../../dist/routes/plugin-shared-mcp.js';
export async function sharedPluginFixture() {
  const root = await mkdtemp(join(tmpdir(), 'f333-shared-plugin-'));
  const projects = { a: join(root, 'a'), b: join(root, 'b') };
  const config = (blockedCats = []) => ({
    version: 2,
    capabilities: ['ordinary', 'owner'].map((id) => ({
      id: `plugin:fixture:${id}`,
      type: 'mcp',
      pluginId: 'fixture',
      source: 'plugin',
      enabled: true,
      blockedCats,
      mcpServer: { command: process.execPath, args: ['dist/mcp.js'] },
    })),
  });
  const setBlocked = async (project, cats = []) =>
    writeFile(join(projects[project], '.cat-cafe/capabilities.json'), JSON.stringify(config(cats)));
  for (const project of ['a', 'b']) {
    await mkdir(join(projects[project], '.cat-cafe'), { recursive: true });
    await setBlocked(project);
    if (!catRegistry.has(`f333-${project}`))
      catRegistry.register(`f333-${project}`, { clientId: 'openai', mcpSupport: true });
  }
  const records = Object.fromEntries(
    ['a', 'b'].map((project) => [
      project,
      {
        invocationId: `inv-${project}`,
        catId: `f333-${project}`,
        threadId: `thread-${project}`,
        userId: 'user',
        sharedMcpContext: {
          v: 1,
          deploymentId: 'test',
          workspaceRoot: projects[project],
          capabilityRoot: root,
          dataDir: root,
          allowedWorkspaceDirs: [projects[project]],
          families: [],
        },
      },
    ]),
  );
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
      packageState: 'installed',
      manifest: { contributions: ['ordinary', 'owner'].map((id) => ({ type: 'mcp', id })) },
    },
  };
  const actions = new NativePluginActions(async () => structuredClone(admission));
  const calls = [];
  const waits = new Map();
  const wait = (method, project) => {
    let entered = () => {};
    let release = () => {};
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const value = { entered, release, ready, gate };
    waits.set(`${method}:f333-${project}`, value);
    return value;
  };
  const activate = () =>
    actions.activate(admission, actions.generation('instance'), async (method) => {
      const context = currentPluginCallContext('instance');
      calls.push({ method, catId: context.catId, threadId: context.threadId });
      const pending = waits.get(`${method}:${context.catId}`);
      if (pending) {
        pending.entered();
        await pending.gate;
        await context.assertCurrent();
      }
      return {
        catId: context.catId,
        threadId: context.threadId,
        project: projects[context.catId.endsWith('a') ? 'a' : 'b'],
      };
    });
  activate();
  const launches = new NativeMcpLaunches(async () => structuredClone(admission), actions);
  const factory = (name) => (client) => {
    const server = new McpServer({ name, version: '1' });
    for (const tool of [name, `${name}_slow`])
      server.tool(tool, {}, async (_input, call) => ({
        content: [{ type: 'text', text: JSON.stringify(await client.invoke(tool, {}, call)) }],
      }));
    return server;
  };
  const refresh = () =>
    launches.activate(
      admission,
      actions.generation('instance'),
      ['ordinary', 'owner'].map((id) => ({
        contributionId: id,
        server: {
          name: id,
          command: process.execPath,
          args: ['dist/mcp.js'],
          env: actions.environment('instance', id),
          workingDirectory: root,
          transport: 'stdio',
        },
      })),
      new Map([
        ['ordinary', factory('ordinary')],
        ['owner', factory('owner')],
      ]),
    );
  refresh();
  const app = Fastify();
  const verify = async (id, token) => {
    const record = Object.values(records).find((r) => r.invocationId === id);
    return record && token === 'token' ? { ok: true, record } : { ok: false, reason: 'invalid_token' };
  };
  registerPluginSharedMcpRoutes(app, {
    actions,
    supervisor: {
      resolveSharedMcp: (...args) => launches.resolveShared(...args),
      resolveMemberMcpView: () => launches.memberView(root),
    },
    registry: { verify, verifyLatest: verify, isStartupRecoveryComplete: () => true },
    threadStore: {
      get: async (id) => ({ id, createdBy: 'user', projectPath: id.endsWith('a') ? projects.a : projects.b }),
    },
    sources: { messageStore: { getById: async () => null } },
    apiBaseUrl: 'http://127.0.0.1:1',
    deploymentId: 'test',
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const path = async (id = 'ordinary') =>
    (await launches.memberView()).entries.find((e) => e.capabilityId.endsWith(`:${id}`)).sharedHttpPath;
  const rpc = async (project, target, method = 'tools/list', params, id = 1) => {
    const response = await fetch(new URL(target, origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-invocation-id': `inv-${project}`,
        'x-callback-token': 'token',
        'x-mcp-connection-id': 'same-connection',
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  };
  return {
    root,
    projects,
    records,
    admission,
    actions,
    calls,
    wait,
    refresh,
    activate,
    setBlocked,
    path,
    rpc,
    close: async () => {
      for (const value of waits.values()) value.release();
      actions.deactivateAll();
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
