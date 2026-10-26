import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMemberGatewayHandler } from '../src/member-gateway.js';
import { guardMcpConfig } from '../src/secret-mcp-config.js';

test('stdio rollback reads the admitted workspace instead of the ACP configuration directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stdio-workspace-'));
  const file = join(root, 'credentials.json');
  writeFileSync(file, JSON.stringify({ invocationId: 'fixture-A', callbackToken: 'fixture-token-A' }), { mode: 0o600 });
  const document = join(root, 'document.txt');
  writeFileSync(document, 'admitted stdio workspace');
  const config = guardMcpConfig(
    {
      command: process.execPath,
      args: [resolve('dist/memory.js')],
      env: { ALLOWED_WORKSPACE_DIRS: '/fixture/stale-acp-config-root' },
    },
    {
      CAT_CAFE_CREDENTIAL_FILE: file,
      CAT_CAFE_MCP_TRANSPORT: 'stdio',
      ALLOWED_WORKSPACE_DIRS: root,
    },
  );
  const client = new Client({ name: 'stdio-workspace-contract', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: String(config.command),
        args: config.args as string[],
        env: config.env as Record<string, string>,
        stderr: 'pipe',
      }),
    );
    const result = await client.callTool({
      name: 'cat_cafe_read_file_slice',
      arguments: { path: document, startLine: 1 },
    });
    assert.ok(!result.isError && JSON.stringify(result).includes('admitted stdio workspace'));
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing protection proxy shares a backend with immutable launch credentials; A cannot acquire refreshed B', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-proxy-'));
  const file = join(root, 'credentials.json');
  writeFileSync(file, JSON.stringify({ invocationId: 'fixture-A', callbackToken: 'fixture-token-A' }), { mode: 0o600 });
  writeFileSync(join(root, 'document.txt'), 'shared proxy fixture document');
  const observed: string[] = [];
  const handler = createMemberGatewayHandler({
    verify: async ({ invocationId }) => {
      observed.push(invocationId);
      return {
        ok: true,
        context: {
          invocationId,
          callbackToken: `fixture-token-${invocationId.slice(-1)}`,
          catId: 'fixture-cat',
          userId: 'fixture-user',
          threadId: 'fixture-thread',
          apiBaseUrl: 'http://127.0.0.1:1',
          toolsetEnv: {},
          sharedContext: {
            v: 1,
            deploymentId: 'fixture',
            workspaceRoot: root,
            dataDir: root,
            capabilityRoot: root,
            allowedWorkspaceDirs: [root],
            families: ['memory'],
          },
        },
      };
    },
    resolveFamilies: () => ['memory'],
  });
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      void handler(req, res, raw ? JSON.parse(raw) : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = guardMcpConfig(
    { command: process.execPath, args: [resolve('dist/memory.js')] },
    {
      CAT_CAFE_API_URL: `http://127.0.0.1:${address.port}`,
      CAT_CAFE_CREDENTIAL_FILE: file,
      CAT_CAFE_MCP_TRANSPORT: 'shared',
    },
  );
  let client: Client | undefined;
  try {
    const env = config.env as Record<string, string>;
    const spec = JSON.parse(env.CAT_CAFE_SECRET_MCP_PROXY_SPEC);
    assert.equal(spec.shared, true);
    assert.equal(spec.command, undefined, 'the protection process does not launch a backend child');
    assert.ok(!JSON.stringify(config).includes('fixture-token-A'));
    client = new Client({ name: 'shared-proxy-contract', version: '1' });
    await client.connect(
      new StdioClientTransport({ command: String(config.command), args: config.args as string[], env, stderr: 'pipe' }),
    );
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'cat_cafe_read_file_slice'));
    writeFileSync(file, JSON.stringify({ invocationId: 'fixture-B', callbackToken: 'fixture-token-B' }), {
      mode: 0o600,
    });
    const result = await client.callTool({
      name: 'cat_cafe_read_file_slice',
      arguments: { path: 'document.txt', startLine: 1 },
    });
    assert.ok(JSON.stringify(result).includes('shared proxy fixture document'));
    assert.ok(observed.length >= 3);
    assert.ok(
      observed.every((id) => id === 'fixture-A'),
      'no implicit latest credential read on resumed/late requests',
    );
  } finally {
    await client?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancelling one HTTP request releases its connection without closing a concurrent request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-proxy-cancel-'));
  const file = join(root, 'credentials.json');
  writeFileSync(file, JSON.stringify({ invocationId: 'fixture-A', callbackToken: 'fixture-token-A' }), { mode: 0o600 });
  writeFileSync(join(root, 'document.txt'), 'cancellation fixture document');
  let block = false;
  let entered!: () => void;
  let release!: () => void;
  let observedClose!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    observedClose = resolve;
  });
  const handler = createMemberGatewayHandler({
    verify: async () => ({
      ok: true,
      context: {
        invocationId: 'fixture-A',
        callbackToken: 'fixture-token-A',
        catId: 'fixture-cat',
        userId: 'fixture-user',
        threadId: 'fixture-thread',
        apiBaseUrl: 'http://127.0.0.1:1',
        toolsetEnv: {},
        sharedContext: {
          v: 1,
          deploymentId: 'fixture',
          workspaceRoot: root,
          dataDir: root,
          capabilityRoot: root,
          allowedWorkspaceDirs: [root],
          families: ['memory'],
        },
      },
    }),
    resolveFamilies: async () => {
      if (block) {
        block = false;
        entered();
        await gate;
      }
      return ['memory'];
    },
  });
  let observeNext = false;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      if (observeNext && body?.method === 'tools/call') {
        observeNext = false;
        res.on('close', observedClose);
      }
      void handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = guardMcpConfig(
    { command: process.execPath, args: [resolve('dist/memory.js')] },
    {
      CAT_CAFE_API_URL: `http://127.0.0.1:${address.port}`,
      CAT_CAFE_CREDENTIAL_FILE: file,
      CAT_CAFE_MCP_TRANSPORT: 'shared',
    },
  );
  const client = new Client({ name: 'shared-cancel-contract', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: String(config.command),
        args: config.args as string[],
        env: config.env as Record<string, string>,
        stderr: 'pipe',
      }),
    );
    block = true;
    observeNext = true;
    const controller = new AbortController();
    const args = { name: 'cat_cafe_read_file_slice', arguments: { path: 'document.txt', startLine: 1 } };
    const first = client.callTool(args, undefined, { signal: controller.signal });
    const rejected = assert.rejects(first);
    await started;
    controller.abort();
    await rejected;
    assert.equal(
      await Promise.race([closed.then(() => true), pause(1000).then(() => false)]),
      true,
      'cancelled HTTP request must be closed before the blocked work is released',
    );
    const second = await client.callTool(args);
    assert.ok(JSON.stringify(second).includes('cancellation fixture document'));
  } finally {
    release();
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
