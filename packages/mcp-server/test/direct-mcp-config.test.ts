import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bindManagedMcpStdioConfig, materializeNativeMcpHttp } from '../src/managed-mcp-config.js';

const callback = {
  CAT_CAFE_API_URL: 'http://127.0.0.1:59999',
  CAT_CAFE_CREDENTIAL_FILE: '/tmp/direct-mcp-original-turn.json',
  CAT_CAFE_INVOCATION_ID: 'owned-original-turn',
  CAT_CAFE_CALLBACK_TOKEN: 'owned-fixture-callback',
  CAT_CAFE_MCP_TRANSPORT: 'stdio',
};

test('external stdio and HTTP remain direct and acquire no callback authority', () => {
  for (const original of [
    { command: 'owned-third-party', args: ['--stdio'], env: { EXPLICIT_SETTING: 'yes' }, cwd: '/tmp' },
    { url: 'https://owned-third-party.invalid/mcp', headers: { 'X-Explicit-Setting': 'yes' }, type: 'http' },
  ])
    assert.deepEqual(bindManagedMcpStdioConfig(original, callback), original);
});

test('genuine self stdio rollback launches its original backend with only the managed credential file', () => {
  const path = resolve('dist/memory.js');
  const result = bindManagedMcpStdioConfig({ command: process.execPath, args: [path] }, callback);
  assert.deepEqual(result.args, [path]);
  const env = result.env as Record<string, string>;
  assert.equal(env.CAT_CAFE_CREDENTIAL_FILE, callback.CAT_CAFE_CREDENTIAL_FILE);
  assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, undefined);
  assert.equal(env.CAT_CAFE_INVOCATION_ID, callback.CAT_CAFE_INVOCATION_ID);
  assert.equal(env.CAT_CAFE_SECRET_MCP_PROXY_SPEC, undefined);
});

test('managed stdio cannot adopt a replacement invocation from its original credential path', async () => {
  const { resolveInvocationCredentials } = await import('../src/tools/invocation-auth.js');
  const root = mkdtempSync(resolve(tmpdir(), 'f333-stdio-binding-'));
  const original = { ...process.env };
  try {
    const path = resolve(root, 'owned.json');
    process.env.CAT_CAFE_CREDENTIAL_FILE = path;
    process.env.CAT_CAFE_INVOCATION_ID = 'A';
    process.env.CAT_CAFE_MCP_TRANSPORT = 'stdio';
    delete process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    writeFileSync(path, JSON.stringify({ invocationId: 'A', callbackToken: 'owned-token-A' }));
    assert.equal(resolveInvocationCredentials().invocationId, 'A');
    writeFileSync(path, JSON.stringify({ invocationId: 'B', callbackToken: 'owned-token-B' }));
    assert.deepEqual(resolveInvocationCredentials(), { invocationId: undefined, callbackToken: undefined });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(root, { recursive: true, force: true });
  }
});

test('native HTTP pins the original turn once; refreshed B cannot relabel A and foreign entries remain direct', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'f333-native-binding-'));
  try {
    const path = resolve(root, 'owned.json');
    const tokenA = randomUUID(),
      tokenB = randomUUID();
    writeFileSync(path, JSON.stringify({ invocationId: 'A', callbackToken: tokenA }), { mode: 0o600 });
    const a = {
      ...callback,
      CAT_CAFE_INVOCATION_ID: 'A',
      CAT_CAFE_CALLBACK_TOKEN: tokenA,
      CAT_CAFE_CREDENTIAL_FILE: path,
      CAT_CAFE_MCP_TRANSPORT: 'shared',
    };
    const source = {
      'cat-cafe-memory': { command: process.execPath, args: [resolve('dist/memory.js')] },
      external: { command: 'owned-third-party', args: [] },
    };
    const configA = materializeNativeMcpHttp(source, a);
    assert.equal(configA['cat-cafe-memory'].type, 'http');
    assert.equal(configA['cat-cafe-memory'].command, undefined);
    assert.equal(new URL(String(configA['cat-cafe-memory'].url)).searchParams.get('family'), 'memory');
    assert.deepEqual(configA.external, source.external);
    writeFileSync(path, JSON.stringify({ invocationId: 'B', callbackToken: tokenB }), { mode: 0o600 });
    assert.throws(() => materializeNativeMcpHttp(source, a), /mismatch/);
    const configB = materializeNativeMcpHttp(source, {
      ...a,
      CAT_CAFE_INVOCATION_ID: 'B',
      CAT_CAFE_CALLBACK_TOKEN: tokenB,
    });
    const headersA = configA['cat-cafe-memory'].headers as Record<string, string>;
    const headersB = configB['cat-cafe-memory'].headers as Record<string, string>;
    assert.equal(headersA['x-invocation-id'], 'A');
    assert.equal(headersA['x-callback-token'], tokenA);
    assert.equal(headersB['x-callback-token'], tokenB);
    assert.notEqual(headersA['x-mcp-connection-id'], headersB['x-mcp-connection-id']);
    assert.deepEqual(materializeNativeMcpHttp(source, { ...a, CAT_CAFE_MCP_TRANSPORT: 'stdio' }), source);
    writeFileSync(path, 'owned-malformed-private-content');
    assert.throws(() => materializeNativeMcpHttp(source, a), {
      message: 'shared_mcp_launch_credentials_invalid',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct stdio rollback reads the admitted workspace, overriding stale ACP roots', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'f333-direct-stdio-workspace-'));
  const file = resolve(root, 'credentials.json');
  writeFileSync(file, JSON.stringify({ invocationId: 'fixture-A', callbackToken: 'owned-fixture-token-A' }), {
    mode: 0o600,
  });
  const document = resolve(root, 'document.txt');
  writeFileSync(document, 'admitted direct stdio workspace');
  const config = bindManagedMcpStdioConfig(
    {
      command: process.execPath,
      args: [resolve('dist/memory.js')],
      env: { ALLOWED_WORKSPACE_DIRS: '/fixture/stale-acp-config-root' },
    },
    { ...callback, CAT_CAFE_INVOCATION_ID: 'fixture-A', CAT_CAFE_CREDENTIAL_FILE: file, ALLOWED_WORKSPACE_DIRS: root },
  );
  const env = config.env as Record<string, string>;
  assert.equal(env.ALLOWED_WORKSPACE_DIRS, root);
  assert.equal(env.CAT_CAFE_INVOCATION_ID, 'fixture-A');
  assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, undefined);
  const client = new Client({ name: 'direct-stdio-workspace-contract', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({ command: String(config.command), args: config.args as string[], env, stderr: 'pipe' }),
    );
    const result = await client.callTool({
      name: 'cat_cafe_read_file_slice',
      arguments: { path: document, startLine: 1 },
    });
    assert.ok(!result.isError && JSON.stringify(result).includes('admitted direct stdio workspace'));
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
