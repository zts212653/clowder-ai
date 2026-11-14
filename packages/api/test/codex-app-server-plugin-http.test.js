import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { bindInvocationPluginMcpView } from '../dist/config/capabilities/invocation-plugin-mcp-view.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { codexConfigObjectFromArgs } from '../dist/domains/cats/services/agents/providers/codex-config-overrides.js';
import './helpers/setup-cat-registry.js';

const contributions = [
  ['fixture.github', 'tracking'],
  ['fixture.collective', 'normal'],
  ['fixture.collective', 'owner'],
  ['fixture.collective', 'work'],
  ['fixture.music', 'native'],
];

/** Only the external RPC peer is fake: configuration runs through the real service builder. */
class Wire {
  writes = [];
  values = [];
  closed = false;
  wake;
  async *read() {
    while (!this.closed || this.values.length) {
      if (this.values.length) yield this.values.shift();
      else
        await new Promise((resolve) => {
          this.wake = resolve;
        });
    }
  }
  push(value) {
    this.values.push(value);
    this.wake?.();
  }
  async write(message) {
    this.writes.push(message);
    if (message.id === undefined) return;
    const result =
      {
        'config/read': { config: { mcp_servers: {} } },
        'configRequirements/read': { requirements: null },
        'account/read': { account: { type: 'chatgpt' } },
        'thread/start': { thread: { id: 'plugin-thread', turns: [] } },
        'thread/resume': { thread: { id: 'plugin-thread', turns: [] } },
        'thread/turns/list': { data: [], nextCursor: null },
        'turn/start': { turn: { id: 'plugin-turn', status: 'inProgress' } },
      }[message.method] ?? {};
    this.push({ id: message.id, result });
    if (message.method === 'turn/start')
      this.push({
        method: 'turn/completed',
        params: {
          threadId: 'plugin-thread',
          turn: { id: 'plugin-turn', status: 'completed', items: [] },
        },
      });
  }
  async close() {
    this.closed = true;
    this.wake?.();
  }
}

function configuredCapability(entry, mode) {
  const cap = { ...entry.installationPolicy, mcpServer: entry.server };
  switch (mode) {
    case 'disabled':
      return { ...cap, enabled: false, globalEnabled: false };
    case 'blocked':
      return { ...cap, blockedCats: ['codex'] };
    case 'custom-command':
      return { ...cap, mcpServerOverride: { ...entry.server, command: 'fixture-custom-command' } };
    case 'custom-args':
      return { ...cap, mcpServerOverride: { ...entry.server, args: [...entry.server.args, '--custom'] } };
    case 'custom-token':
      return { ...cap, mcpServerOverride: { ...entry.server, env: { CLOWDER_PLUGIN_ACTION_TOKEN: 'custom-action' } } };
    default:
      return cap;
  }
}

function fixture(t, mode = 'shared') {
  const root = mkdtempSync(join(tmpdir(), 'codex-plugin-http-'));
  for (const name of ['.cat-cafe', 'credentials', 'data', 'tmp', 'program-data']) mkdirSync(join(root, name));
  const env = {
    CAT_CAFE_CONFIG_ROOT: root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_CAFE_WORKSPACE_ROOT: root,
    CAT_CAFE_RUNTIME_ROOT: resolve('../..'),
    CAT_CAFE_DATA_DIR: join(root, 'data'),
    CAT_CAFE_MCP_CREDS_DIR: join(root, 'credentials'),
    ProgramData: join(root, 'program-data'),
    TMPDIR: join(root, 'tmp'),
  };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const entries = contributions.map(([pluginId, contributionId], index) => {
    const capabilityId = `plugin:${pluginId}:${contributionId}`;
    const child = join(root, `never-started-${index}.mjs`);
    writeFileSync(child, 'throw new Error("No diagnostic forwarder may run");\n');
    return {
      capabilityId,
      pluginId,
      installationPolicy: {
        id: capabilityId,
        type: 'mcp',
        source: 'plugin',
        pluginId,
        enabled: true,
        globalEnabled: true,
      },
      policySourceRef: `plugin-activation:${pluginId}:1`,
      sharedHttpPath: `/api/plugin-mcp/instance-${index}/${contributionId}?shared=1&activation=fixture-${index}`,
      server: {
        command: process.execPath,
        args: [child],
        env: { CLOWDER_PLUGIN_ACTION_TOKEN: `action-secret-${index}` },
        transport: 'stdio',
        workingDir: root,
      },
      isCurrent: () => mode !== 'stale',
    };
  });
  if (mode === 'nonshared') for (const entry of entries) delete entry.sharedHttpPath;
  const capabilities = entries.map((entry) => configuredCapability(entry, mode));
  writeFileSync(join(root, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 2, capabilities }));
  const credentialFile = join(root, 'credentials/turn.json');
  writeFileSync(
    credentialFile,
    JSON.stringify({ invocationId: 'plugin-invocation', callbackToken: 'callback-secret' }),
    { mode: 0o600 },
  );
  const callback = {
    CAT_CAFE_CAT_ID: 'codex',
    CAT_CAFE_INVOCATION_ID: 'plugin-invocation',
    CAT_CAFE_THREAD_ID: 'host-thread',
    CAT_CAFE_CALLBACK_TOKEN: 'callback-secret',
    CAT_CAFE_CREDENTIAL_FILE: credentialFile,
    CAT_CAFE_MCP_TRANSPORT: mode === 'stdio' ? 'stdio' : 'shared',
    CAT_CAFE_API_URL: 'http://127.0.0.1:5712',
    CAT_CAFE_DATA_DIR: join(root, 'data'),
  };
  const view = { localCapabilityRoot: root, entries: mode === 'missing' ? [] : entries };
  const scope = { kind: 'member', projectRoot: root, memberCatId: 'codex' };
  return {
    root,
    entries,
    callback,
    async run(resume = false, accountEnv) {
      const wire = new Wire();
      let launch;
      const service = new CodexAgentService({
        catId: 'codex',
        carrierMode: 'app_server',
        cliCommand: process.execPath,
        l0CompilerFn: async () => 'Local in-memory protocol test.',
        model: 'gpt-6.1-sol',
      });
      const iterator = bindInvocationPluginMcpView(
        () =>
          service
            .invoke('No provider request', {
              invocationId: callback.CAT_CAFE_INVOCATION_ID,
              workingDirectory: root,
              callbackEnv: callback,
              ...(accountEnv ? { accountEnv } : {}),
              ...(resume ? { sessionId: 'plugin-thread' } : {}),
              agentCarrierSessionFactory: async (options) => {
                launch = options;
                return wire;
              },
            })
            [Symbol.asyncIterator](),
        view,
        scope,
      );
      const events = [];
      for (let step = await iterator.next(); !step.done; step = await iterator.next()) events.push(step.value);
      assert.deepEqual(
        events.filter((event) => event.type === 'error'),
        [],
        'the real builder must reach the RPC peer',
      );
      const method = resume ? 'thread/resume' : 'thread/start';
      const request = wire.writes.find((message) => message.method === method);
      assert.ok(request, `${method} must actually be sent`);
      const config =
        callback.CAT_CAFE_MCP_TRANSPORT === 'shared' ? request.params.config : codexConfigObjectFromArgs(launch.args);
      return {
        servers: config.mcp_servers,
        launch,
        wire,
        wrappers: readdirSync(join(root, 'tmp')).filter((name) => name.startsWith('cat-cafe-codex-mcp-')),
      };
    },
  };
}

for (const resume of [false, true])
  test(`ordinary Codex ${resume ? 'resume' : 'start'} sends all five current Host contributions as private HTTP`, async (t) => {
    const f = fixture(t);
    const { servers, launch, wrappers } = await f.run(resume);
    for (const entry of f.entries) {
      const server = servers[entry.capabilityId.replaceAll(':', '__')];
      assert.ok(server?.url, `${entry.capabilityId} must use HTTP after the real builder`);
      assert.equal(server.url, new URL(entry.sharedHttpPath, f.callback.CAT_CAFE_API_URL).href);
      assert.equal(server.http_headers['x-invocation-id'], 'plugin-invocation');
      assert.equal(server.http_headers['x-callback-token'], 'callback-secret');
      assert.ok(server.http_headers['x-mcp-connection-id']);
      for (const key of ['command', 'args', 'env', 'cwd']) assert.equal(server[key], undefined);
    }
    assert.deepEqual(wrappers, [], 'HTTP contributions must never create even an unused env-wrapper');
    assert.equal(JSON.stringify(servers).includes('action-secret-'), false);
    assert.doesNotMatch(JSON.stringify(launch.args), /action-secret-|callback-secret|mcp-env-wrapper/);
  });

for (const resume of [false, true])
  test(`shared HTTP ${resume ? 'resume' : 'start'} bypasses loopback after account environment overrides`, async (t) => {
    const f = fixture(t);
    f.callback.NO_PROXY = 'callback-only.example';
    const accountEnv = {
      NO_PROXY: 'account.example,LOCALHOST',
      no_proxy: 'lower.example,10.0.0.0/8',
      HTTP_PROXY: 'http://outbound.example:8080',
      https_proxy: 'http://secure-outbound.example:8081',
      ALL_PROXY: 'socks5://outbound.example:8082',
    };
    const { launch } = await f.run(resume, accountEnv);
    for (const key of process.platform === 'win32' ? ['NO_PROXY'] : ['NO_PROXY', 'no_proxy']) {
      const excluded = (launch.env[key] ?? '')
        .toLowerCase()
        .split(',')
        .map((host) => host.trim());
      for (const host of ['127.0.0.1', '::1', 'localhost', 'account.example', 'lower.example', '10.0.0.0/8'])
        assert.ok(excluded.includes(host), `${key} must preserve ${host} in the actual provider launch`);
      assert.equal(excluded.includes('callback-only.example'), false, 'final account precedence remains intact');
      assert.equal(excluded.includes('*'), false, 'loopback bypass must not disable outbound proxies');
    }
    for (const key of ['HTTP_PROXY', 'https_proxy', 'ALL_PROXY']) assert.equal(launch.env[key], accountEnv[key]);
    assert.doesNotMatch(JSON.stringify(launch.args), /outbound\.example|account\.example|lower\.example/);
  });

test('explicit stdio preserves outbound proxies while receiving the final loopback projection', async (t) => {
  const f = fixture(t, 'stdio');
  const accountEnv = {
    NO_PROXY: 'stdio.example',
    no_proxy: 'lower.stdio.example',
    HTTP_PROXY: 'http://proxy.example:8080',
  };
  const { launch } = await f.run(false, accountEnv);
  assert.equal(launch.env.HTTP_PROXY, accountEnv.HTTP_PROXY);
  assert.deepEqual(
    new Set(launch.env.NO_PROXY.split(',')),
    new Set(['stdio.example', 'lower.stdio.example', 'localhost', '127.0.0.1', '::1']),
  );
  assert.equal(launch.env.no_proxy, process.platform === 'win32' ? undefined : launch.env.NO_PROXY);
  assert.equal(launch.inheritParentEnv, false);
});

for (const platform of ['darwin', 'win32'])
  test(`shared HTTP keeps deterministic loopback after deleted proxy aliases on ${platform}`, async (t) => {
    const f = fixture(t);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const previous = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
    Object.assign(process.env, { NO_PROXY: 'deleted-upper.example', no_proxy: 'deleted-lower.example' });
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    t.after(() => {
      Object.defineProperty(process, 'platform', descriptor);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const { launch } = await f.run(false, { NO_PROXY: null, no_proxy: '', HTTP_PROXY: 'http://proxy.example:8080' });
    assert.deepEqual(new Set(launch.env.NO_PROXY.split(',')), new Set(['localhost', '127.0.0.1', '::1']));
    assert.equal(launch.env.HTTP_PROXY, 'http://proxy.example:8080');
    assert.equal(launch.inheritParentEnv, false);
  });

for (const mode of ['stdio', 'nonshared', 'custom-command', 'custom-args', 'custom-token'])
  test(`ordinary Codex preserves ${mode} plugin stdio without granting shared HTTP`, async (t) => {
    const f = fixture(t, mode);
    const { servers, launch } = await f.run();
    for (const entry of f.entries) {
      const server = servers[entry.capabilityId.replaceAll(':', '__')];
      assert.equal(server.url, undefined);
      assert.ok(server.command);
      if (mode.startsWith('custom')) {
        assert.equal(server.command, mode === 'custom-command' ? 'fixture-custom-command' : entry.server.command);
        assert.deepEqual(server.args, [...entry.server.args, ...(mode === 'custom-args' ? ['--custom'] : [])]);
        assert.equal(
          server.env.CLOWDER_PLUGIN_ACTION_TOKEN,
          mode === 'custom-token' ? 'custom-action' : entry.server.env.CLOWDER_PLUGIN_ACTION_TOKEN,
        );
      }
    }
    assert.doesNotMatch(JSON.stringify(launch.args), /action-secret-|callback-secret|custom-action/);
  });

for (const mode of ['disabled', 'blocked', 'missing', 'stale'])
  test(`ordinary Codex cannot revive a ${mode} plugin activation`, async (t) => {
    const f = fixture(t, mode);
    const { servers, wrappers } = await f.run();
    for (const entry of f.entries) {
      const server = servers[entry.capabilityId.replaceAll(':', '__')];
      assert.ok(!server || server.enabled === false);
      assert.equal(server?.url, undefined);
    }
    assert.deepEqual(wrappers, []);
  });

test('private HTTP preparation rejects mismatched credentials rather than falling back to plugin stdio', async (t) => {
  const f = fixture(t);
  f.callback.CAT_CAFE_CALLBACK_TOKEN = 'wrong-callback';
  await assert.rejects(f.run(), /shared_mcp_launch_credentials_mismatch/);
});
