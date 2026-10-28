import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  callbackEnvDiagnostic,
  materializeSessionMcpServers,
} from '../../dist/domains/cats/services/agents/providers/acp/acp-session-env.js';

const callback = {
  CAT_CAFE_API_URL: 'http://127.0.0.1:59999',
  CAT_CAFE_INVOCATION_ID: 'A',
  CAT_CAFE_CALLBACK_TOKEN: 'owned-A',
  CAT_CAFE_CAT_ID: 'gemini',
  CAT_CAFE_THREAD_ID: 'thread',
};
const own = (name) => ({
  name: `cat-cafe-${name}`,
  command: process.execPath,
  args: [fileURLToPath(new URL(`../../../mcp-server/dist/${name}.js`, import.meta.url))],
  env: [],
});
const environment = (server) => Object.fromEntries(server.env.map(({ name, value }) => [name, value]));

test('ACP preserves direct third-party transports, including a colliding first-party name', () => {
  const servers = [
    { name: 'cat-cafe-collab', command: 'foreign', args: ['collab.js'], env: [{ name: 'EXPLICIT', value: 'keep' }] },
    {
      name: 'remote',
      type: 'sse',
      url: 'https://example.invalid/events',
      headers: [{ name: 'Authorization', value: 'explicit' }],
    },
  ];
  assert.deepEqual(materializeSessionMcpServers(servers, callback), servers);
  assert.deepEqual(materializeSessionMcpServers(servers), servers);
});
test('ACP binds only genuine installed first-party entrypoints and never mutates the source', () => {
  const servers = [own('collab'), own('memory')],
    before = structuredClone(servers);
  const bound = materializeSessionMcpServers(servers, { ...callback, RANDOM: 'exclude' });
  assert.equal(environment(bound[0]).CAT_CAFE_INVOCATION_ID, 'A');
  assert.equal(environment(bound[1]).CAT_CAFE_CAT_ID, 'gemini');
  assert.equal(environment(bound[0]).RANDOM, undefined);
  assert.deepEqual(bound[0].args, servers[0].args);
  assert.deepEqual(servers, before);
});
test('ACP native HTTP keeps six original names and pins private headers from the original turn', () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-native-http-'));
  try {
    const file = join(root, 'turn.json');
    writeFileSync(file, JSON.stringify({ invocationId: 'A', callbackToken: 'owned-A' }), { mode: 0o600 });
    const source = ['collab', 'memory', 'signals', 'limb', 'audio', 'finance'].map(own);
    const env = { ...callback, CAT_CAFE_CREDENTIAL_FILE: file, CAT_CAFE_MCP_TRANSPORT: 'shared' };
    const http = materializeSessionMcpServers(source, env, true);
    assert.deepEqual(
      http.map((x) => x.name),
      source.map((x) => x.name),
    );
    for (const server of http) {
      assert.equal(server.type, 'http');
      assert.equal(server.command, undefined);
      assert.equal(
        Object.fromEntries(server.headers.map(({ name, value }) => [name, value]))['x-callback-token'],
        'owned-A',
      );
    }
    writeFileSync(file, JSON.stringify({ invocationId: 'B', callbackToken: 'owned-B' }));
    assert.throws(() => materializeSessionMcpServers(source, env, true), /mismatch/);
    assert.equal(Object.fromEntries(http[0].headers.map(({ name, value }) => [name, value]))['x-invocation-id'], 'A');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('foreign MCP cannot obtain callback authority by configuring an action-token field', () => {
  const server = {
    name: 'external',
    command: 'foreign',
    args: [],
    env: [{ name: 'CLOWDER_PLUGIN_ACTION_TOKEN', value: 'forged' }],
  };
  assert.deepEqual(materializeSessionMcpServers([server], callback), [server]);
});

test('ACP diagnostics expose presence only', () => {
  assert.equal(callbackEnvDiagnostic(callback).hasInvocationId, true);
  assert.equal(callbackEnvDiagnostic().hasCallbackToken, false);
  assert.ok(!JSON.stringify(callbackEnvDiagnostic(callback)).includes('owned-A'));
});
