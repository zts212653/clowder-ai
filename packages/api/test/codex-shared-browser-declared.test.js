/**
 * F333 / #6888: through the real CodexAgentService, the shared browser reaches Codex as
 * `playwright_shared` with `playwright` kept as a disabled stdio stub, and the request evidence
 * names the server that actually provides the tools (Sol5.6 #6888 R1 P1).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { bindInvocationPluginMcpView } from '../dist/config/capabilities/invocation-plugin-mcp-view.js';
import { SHARED_BROWSER_HTTP_PATH } from '../dist/domains/browser/shared-browser-descriptor.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import './helpers/setup-cat-registry.js';

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
        await new Promise((done) => {
          this.wake = done;
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
        'thread/start': { thread: { id: 'browser-thread', turns: [] } },
        'turn/start': { turn: { id: 'browser-turn', status: 'inProgress' } },
      }[message.method] ?? {};
    this.push({ id: message.id, result });
    if (message.method === 'turn/start')
      this.push({
        method: 'turn/completed',
        params: { threadId: 'browser-thread', turn: { id: 'browser-turn', status: 'completed', items: [] } },
      });
  }
  async close() {
    this.closed = true;
    this.wake?.();
  }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-shared-browser-'));
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
  writeFileSync(
    join(root, '.cat-cafe/capabilities.json'),
    JSON.stringify({
      version: 2,
      capabilities: [
        {
          id: 'playwright',
          type: 'mcp',
          source: 'external',
          enabled: true,
          globalEnabled: true,
          mcpServer: { command: '', args: [], resolver: 'shared-browser' },
        },
      ],
    }),
  );
  const credentialFile = join(root, 'credentials/turn.json');
  writeFileSync(credentialFile, JSON.stringify({ invocationId: 'browser-invocation', callbackToken: 'cb' }), {
    mode: 0o600,
  });
  return {
    root,
    callback: {
      CAT_CAFE_CAT_ID: 'codex',
      CAT_CAFE_INVOCATION_ID: 'browser-invocation',
      CAT_CAFE_THREAD_ID: 'host-thread',
      CAT_CAFE_CALLBACK_TOKEN: 'cb',
      CAT_CAFE_CREDENTIAL_FILE: credentialFile,
      CAT_CAFE_MCP_TRANSPORT: 'shared',
      CAT_CAFE_API_URL: 'http://127.0.0.1:5712',
      CAT_CAFE_DATA_DIR: join(root, 'data'),
    },
  };
}

test('Codex registers the shared browser as playwright_shared, and the request evidence says so', async (t) => {
  const { root, callback } = fixture(t);
  const wire = new Wire();
  let prepared;
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
          agentCarrierSessionFactory: async () => wire,
          beforeProviderLaunch: async (request) => {
            prepared ??= request;
          },
        })
        [Symbol.asyncIterator](),
    { localCapabilityRoot: root, entries: [] },
    { kind: 'member', projectRoot: root, memberCatId: 'codex' },
  );
  const events = [];
  for (let step = await iterator.next(); !step.done; step = await iterator.next()) events.push(step.value);
  assert.deepEqual(
    events.filter((event) => event.type === 'error'),
    [],
  );

  const servers = wire.writes.find((message) => message.method === 'thread/start').params.config.mcp_servers;
  assert.equal(servers.playwright.enabled, false, 'the original name is a disabled stdio stub');
  assert.equal(servers.playwright.url, undefined, 'never a url next to a command');
  assert.equal(new URL(servers.playwright_shared.url).pathname, SHARED_BROWSER_HTTP_PATH);

  assert.ok(prepared, 'the prepared provider request was observed');
  const declared = prepared.tools.declaredServerNames;
  assert.ok(declared.includes('playwright_shared'), `declared: ${declared.join(',')}`);
  assert.ok(!declared.includes('playwright'), 'the disabled stub is not a declared tool server');
  assert.equal(prepared.tools.finalSurface, 'declared_only');
  const schemaText = JSON.stringify(prepared.tools.schemaDelivery);
  assert.ok(!/"playwright"/.test(schemaText), `schema delivery must not name the stub: ${schemaText.slice(0, 300)}`);
});
