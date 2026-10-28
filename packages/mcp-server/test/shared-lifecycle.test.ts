import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { materializeNativeMcpHttp } from '../src/managed-mcp-config.js';
import { createMemberGatewayHandler } from '../src/member-gateway.js';

test('an unknown write outcome is not replayed; gateway reconnect and closing one native connection preserve other owners', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-mcp-lifecycle-'));
  let apiUrl = '';
  let dropWriteResponse = false;
  let effects = 0;
  const peers: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];
  const handler = createMemberGatewayHandler({
    verify: async ({ invocationId, callbackToken }) => ({
      ok: true,
      context: {
        invocationId,
        callbackToken,
        catId: `cat-${invocationId}`,
        userId: 'fixture-user',
        threadId: `thread-${invocationId}`,
        apiBaseUrl: apiUrl,
        toolsetEnv: {},
        sharedContext: {
          v: 1,
          deploymentId: 'fixture',
          workspaceRoot: join(root, invocationId),
          dataDir: root,
          capabilityRoot: root,
          allowedWorkspaceDirs: [join(root, invocationId)],
          families: ['collab', 'memory'],
        },
      },
    }),
    resolveFamilies: () => ['collab', 'memory'],
  });
  const makeServer = () =>
    createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        if (req.url === '/api/callbacks/post-message') {
          effects++;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          return;
        }
        const body = raw ? JSON.parse(raw) : undefined;
        if (dropWriteResponse && body?.params?.name === 'cat_cafe_post_message') {
          dropWriteResponse = false;
          // The callback commits, but no MCP result reaches the client.
          res.end = (() => {
            res.destroy();
            return res;
          }) as typeof res.end;
        }
        void handler(req, res, body);
      });
    });
  let server = makeServer();
  const listen = (port: number) => new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };
  await listen(0);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  apiUrl = `http://127.0.0.1:${port}`;
  const connect = async (owner: string) => {
    const workspace = join(root, owner);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'document.txt'), `document ${owner}`);
    const credentialFile = join(workspace, 'credentials.json');
    writeFileSync(credentialFile, JSON.stringify({ invocationId: owner, callbackToken: `fixture-token-${owner}` }), {
      mode: 0o600,
    });
    const config = materializeNativeMcpHttp(
      { own: { command: process.execPath, args: [resolve('dist/index.js')] } },
      {
        CAT_CAFE_API_URL: apiUrl,
        CAT_CAFE_INVOCATION_ID: owner,
        CAT_CAFE_CREDENTIAL_FILE: credentialFile,
        CAT_CAFE_MCP_TRANSPORT: 'shared',
      },
    ).own;
    const client = new Client({ name: 'f333-lifecycle', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(String(config.url)), {
      requestInit: { headers: { ...(config.headers as Record<string, string>), Connection: 'close' } },
    });
    peers.push({ client, transport });
    await client.connect(transport);
    return { client, transport };
  };
  const read = (client: Client) =>
    client.callTool({ name: 'cat_cafe_read_file_slice', arguments: { path: 'document.txt', startLine: 1 } });
  try {
    const a = await connect('A');
    const b = await connect('B');
    dropWriteResponse = true;
    await assert.rejects(
      a.client.callTool({
        name: 'cat_cafe_post_message',
        arguments: { content: 'fixture private effect', clientMessageId: 'fixture-unknown-outcome' },
      }),
    );
    assert.equal(effects, 1);
    assert.ok(JSON.stringify(await read(b.client)).includes('document B'));
    const start = performance.now();
    await close();
    server = makeServer();
    await listen(port);
    const recoveredA = await connect('A');
    const recoveredB = await connect('B');
    assert.ok(JSON.stringify(await read(recoveredA.client)).includes('document A'));
    assert.ok(performance.now() - start < 5000, 'stateless transport reconnects within the fixed recovery budget');
    assert.equal(effects, 1, 'reconnect cannot replay the write whose result was lost');
    await recoveredA.transport.close();
    await a.client.close();
    assert.ok(
      JSON.stringify(await read(recoveredB.client)).includes('document B'),
      'another caller retains its legal session when A closes',
    );
    const replacement = await connect('A');
    assert.ok(JSON.stringify(await read(replacement.client)).includes('document A'));
    assert.equal(effects, 1);
  } finally {
    await Promise.allSettled(peers.map(({ client }) => client.close()));
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});
