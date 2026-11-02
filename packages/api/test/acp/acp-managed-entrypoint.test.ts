import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isInstalledManagedMcpServer } from '@cat-cafe/mcp-server/dist/managed-mcp-config.js';
import { resolveBuiltinCatCafeServer } from '../../src/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';
import { materializeSessionMcpServers } from '../../src/domains/cats/services/agents/providers/acp/acp-session-env.js';
import { piMcpServers } from '../../src/domains/cats/services/agents/providers/pi/pi-session-mcp.js';

test('a stdio-only ACP client retains authenticated stdio instead of receiving an unsupported HTTP server', (t) => {
  const server = resolveBuiltinCatCafeServer(join(tmpdir(), 'unrelated-workspace'), 'cat-cafe-collab');
  assert.ok(server);
  const directory = mkdtempSync(join(tmpdir(), 'acp-stdio-capability-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentialFile = join(directory, 'credentials.json');
  writeFileSync(credentialFile, JSON.stringify({ invocationId: 'test-invocation', callbackToken: 'test-token' }));
  const materialized = materializeSessionMcpServers(
    [server],
    {
      CAT_CAFE_API_URL: 'http://127.0.0.1:1',
      CAT_CAFE_INVOCATION_ID: 'test-invocation',
      CAT_CAFE_CALLBACK_TOKEN: 'test-token',
      CAT_CAFE_CREDENTIAL_FILE: credentialFile,
      CAT_CAFE_MCP_TRANSPORT: 'shared',
    },
    false,
    false,
  );
  const [accepted] = piMcpServers(materialized);
  assert.ok(accepted);
  assert.equal(accepted.env.find(({ name }) => name === 'CAT_CAFE_MCP_TRANSPORT')?.value, 'stdio');
  assert.equal(accepted.env.find(({ name }) => name === 'CAT_CAFE_CREDENTIAL_FILE')?.value, credentialFile);
  assert.equal(accepted.env.find(({ name }) => name === 'CAT_CAFE_INVOCATION_ID')?.value, 'test-invocation');
  assert.equal(
    accepted.env.find(({ name }) => name === 'CAT_CAFE_CALLBACK_TOKEN'),
    undefined,
  );
});

test('ACP builtins use the loaded MCP package identity even when the workspace has a mirrored package tree', (t) => {
  const server = resolveBuiltinCatCafeServer(join(tmpdir(), 'unrelated-workspace'), 'cat-cafe-collab');
  assert.ok(server);
  const entry = fileURLToPath(import.meta.resolve('@cat-cafe/mcp-server/dist/collab.js'));
  assert.equal(server.args[0], entry);
  assert.equal(isInstalledManagedMcpServer({ command: server.command, args: server.args, env: {} }), true);
  const [bound] = materializeSessionMcpServers([server], {
    CAT_CAFE_API_URL: 'http://127.0.0.1:1',
    CAT_CAFE_INVOCATION_ID: 'test-invocation',
    CAT_CAFE_CALLBACK_TOKEN: 'test-token',
  });
  assert.ok(bound && 'command' in bound);
  assert.equal(bound.env.find(({ name }) => name === 'CAT_CAFE_INVOCATION_ID')?.value, 'test-invocation');
  assert.equal(bound.env.find(({ name }) => name === 'CAT_CAFE_CALLBACK_TOKEN')?.value, 'test-token');
  const directory = mkdtempSync(join(tmpdir(), 'acp-managed-binding-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentialFile = join(directory, 'credentials.json');
  writeFileSync(credentialFile, JSON.stringify({ invocationId: 'test-invocation', callbackToken: 'test-token' }));
  const [shared] = materializeSessionMcpServers([server], {
    CAT_CAFE_API_URL: 'http://127.0.0.1:1',
    CAT_CAFE_INVOCATION_ID: 'test-invocation',
    CAT_CAFE_CREDENTIAL_FILE: credentialFile,
    CAT_CAFE_MCP_TRANSPORT: 'shared',
  });
  assert.ok(shared && 'url' in shared);
  assert.equal(shared.url, 'http://127.0.0.1:1/api/member-mcp/mcp?shared=1&family=collab');
  assert.equal(shared.headers.find(({ name }) => name === 'x-callback-token')?.value, 'test-token');
});

test('an external MCP cannot acquire callback authority by copying a first-party name or filename', () => {
  const server = {
    name: 'cat-cafe-collab',
    command: process.execPath,
    args: [join(tmpdir(), 'foreign', 'collab.js')],
    env: [],
  };
  const [bound] = materializeSessionMcpServers([server], {
    CAT_CAFE_API_URL: 'http://127.0.0.1:1',
    CAT_CAFE_INVOCATION_ID: 'test-invocation',
    CAT_CAFE_CALLBACK_TOKEN: 'test-token',
  });
  assert.ok(bound && 'command' in bound);
  assert.deepEqual(bound.env, []);
});
