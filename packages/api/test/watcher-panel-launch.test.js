import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { watcherPanelToolPolicy } from '../dist/domains/concierge/watcher/panel/watcher-panel-policy.js';
import { createMockArchive } from './helpers/provider-archive-test-helpers.js';

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
        'config/read': {
          config: {
            mcp_servers: {
              inherited: { command: 'unsafe-tool-server' },
              'cat-cafe-audio': { command: 'unsafe-audio' },
            },
          },
        },
        'thread/turns/list': { data: [], nextCursor: null },
        'configRequirements/read': { requirements: null },
        'account/read': { account: { type: 'chatgpt' } },
        'thread/start': { thread: { id: 'watcher-native', turns: [] } },
        'thread/resume': { thread: { id: 'watcher-native', turns: [] } },
        'thread/read': { thread: { id: 'watcher-native', cwd: process.cwd(), turns: [] } },
        'turn/start': { turn: { id: 'turn-1', status: 'inProgress' } },
      }[message.method] ?? {};
    this.push({ id: message.id, result });
    if (message.method === 'turn/start')
      this.push({
        method: 'turn/completed',
        params: { threadId: 'watcher-native', turn: { id: 'turn-1', status: 'completed', items: [] } },
      });
  }
  async close() {
    this.closed = true;
    this.wake?.();
  }
}
for (const resume of [false, true])
  test(`actual watcher carrier removes inherited and external MCP on ${resume ? 'resume' : 'start'}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'watcher-launch-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const credentialFile = join(root, 'credentials.json');
    writeFileSync(credentialFile, JSON.stringify({ invocationId: 'watcher-inv', callbackToken: 'fixture' }));
    const policy = watcherPanelToolPolicy();
    const wire = new Wire();
    let launch;
    const service = new CodexAgentService({
      catId: 'codex',
      model: 'fixture',
      carrierMode: 'app_server',
      cliCommand: process.execPath,
      rawArchive: createMockArchive(),
      l0CompilerFn: async () => 'Ordinary watcher identity',
    });
    const events = await Array.fromAsync(
      service.invoke('No real model request', {
        invocationId: 'watcher-inv',
        ...(resume ? { sessionId: 'watcher-native' } : {}),
        workingDirectory: root,
        toolExecutionPolicy: policy,
        callbackEnv: {
          CAT_CAFE_CAT_ID: 'codex',
          CAT_CAFE_API_URL: 'http://127.0.0.1:9',
          CAT_CAFE_INVOCATION_ID: 'watcher-inv',
          CAT_CAFE_CALLBACK_TOKEN: 'fixture',
          CAT_CAFE_CREDENTIAL_FILE: credentialFile,
          CAT_CAFE_MCP_TRANSPORT: 'shared',
        },
        frozenCodexMcpInput: {
          available: true,
          resolved: true,
          allowedWorkspaceDirs: root,
          servers: [
            ...['collab', 'memory', 'audio'].map((family) => ({
              name: `cat-cafe-${family}`,
              enabled: true,
              catCafe: true,
              plugin: false,
              source: 'cat-cafe',
              command: process.execPath,
              args: [resolve(`../mcp-server/dist/${family}.js`)],
            })),
            {
              name: 'external',
              enabled: true,
              catCafe: false,
              plugin: false,
              source: 'external',
              command: 'forbidden-external',
            },
          ],
        },
        cliConfigArgs: ['--config sandbox_mode="danger-full-access"', '--enable multi_agent'],
        agentCarrierSessionFactory: async (options) => {
          launch = options;
          return wire;
        },
      }),
    );
    assert.deepEqual(
      events.filter((e) => e.type === 'error'),
      [],
      JSON.stringify(wire.writes.map((m) => m.method)),
    );
    const request = wire.writes.find((m) => m.method === (resume ? 'thread/resume' : 'thread/start'));
    assert.ok(request, 'ordinary session persistence/resume remains supported');
    const servers = request.params.config.mcp_servers;
    assert.equal(servers.inherited.enabled, false);
    assert.equal(servers['cat-cafe-audio'].enabled, false);
    assert.equal(servers.external, undefined);
    for (const family of ['collab', 'memory']) {
      const server = servers[`cat-cafe-${family}`];
      assert.deepEqual(JSON.parse(server.env.CAT_CAFE_ALLOWED_TOOL_NAMES), policy.allowedToolNames);
      assert.equal(server.env.CAT_CAFE_WATCHER_TOOL_NAMES, undefined);
      assert.equal(server.url, undefined, 'selected MCP runs behind the named process fence');
    }
    assert.equal(request.params.sandbox, 'read-only');
    assert.equal(request.params.approvalPolicy, 'never');
    const args = launch.args.join(' ');
    assert.match(args, /--disable shell_tool/);
    assert.match(args, /--disable unified_exec/);
    assert.match(args, /--disable multi_agent/);
    assert.match(args, /--disable hooks/);
    assert.doesNotMatch(args, /danger-full-access|--enable multi_agent|fixture.*CAT_CAFE_CALLBACK_TOKEN/);
    assert.equal(
      wire.writes.some((m) => m.method === 'thread/revert'),
      false,
      'ordinary context never takes the bounded revert lane',
    );
    assert.equal(
      wire.writes.some((m) => m.method === 'turn/start'),
      true,
    );
  });
