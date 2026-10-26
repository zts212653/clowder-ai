import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMemberGatewayHandler, type MemberGatewayDeps } from '../src/member-gateway.js';

test('shared gateway requires Host roots, narrows families, rechecks queued reads, and rejects browser origins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-gateway-'));
  writeFileSync(join(root, 'document.txt'), 'private fixture document');
  let hasContext = false;
  let revokeOnRecheck = false;
  let verifications = 0;
  const deps = {
    verify: async () => {
      verifications++;
      if (revokeOnRecheck && verifications > 1) return { ok: false, reason: 'revoked' };
      return {
        ok: true,
        context: {
          invocationId: 'fixture-invocation',
          callbackToken: 'fixture-token',
          catId: 'fixture-cat',
          threadId: 'fixture-thread',
          userId: 'fixture-user',
          apiBaseUrl: 'http://127.0.0.1:1',
          toolsetEnv: {},
          ...(hasContext
            ? {
                sharedContext: {
                  v: 1,
                  deploymentId: 'fixture',
                  workspaceRoot: root,
                  capabilityRoot: root,
                  dataDir: root,
                  allowedWorkspaceDirs: [root],
                  families: ['memory'],
                },
              }
            : {}),
        },
      };
    },
    resolveFamilies: async () => ['memory', 'audio'],
  } as MemberGatewayDeps;
  const handler = createMemberGatewayHandler(deps);
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      void handler(req, res, JSON.parse(raw));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const rpc = async (method: string, params: unknown, family = 'memory', headers = {}, shared = true) => {
    const result = await fetch(`http://127.0.0.1:${address.port}/mcp?${shared ? 'shared=1&' : ''}family=${family}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-invocation-id': 'fixture-invocation',
        'x-callback-token': 'fixture-token',
        'x-mcp-connection-id': 'fixture-connection',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: result.status, text: await result.text() };
  };
  try {
    assert.equal((await rpc('tools/list', {})).status, 401, 'no ambient roots when Host projection is absent');
    hasContext = true;
    assert.equal((await rpc('tools/list', {}, 'audio')).status, 403, 'query parameters only narrow Host authority');
    assert.equal((await rpc('tools/list', {}, 'memory', { origin: 'https://external.invalid' })).status, 403);
    const args = { name: 'cat_cafe_read_file_slice', arguments: { path: 'document.txt', startLine: 1 } };
    const normal = await rpc('tools/call', args);
    assert.equal(normal.status, 200);
    assert.ok(normal.text.includes('private fixture document'));
    assert.equal(
      (await rpc('tools/call', args, 'memory', {}, false)).status,
      403,
      'shared credentials cannot downgrade into an ambient stdio context',
    );
    verifications = 0;
    revokeOnRecheck = true;
    const revoked = await rpc('tools/call', args);
    assert.ok(!revoked.text.includes('private fixture document'));
    assert.ok(verifications >= 2, 'local readers recheck canonical currentness after queue/admission');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('authenticated cancellation stops a queued effect on its original connection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-gateway-cancel-'));
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let block = true;
  let effects = 0;
  let apiBaseUrl = '';
  const handler = createMemberGatewayHandler({
    verify: async () => ({
      ok: true,
      context: {
        invocationId: 'fixture-A',
        callbackToken: 'fixture-token-A',
        catId: 'fixture-cat',
        userId: 'fixture-user',
        threadId: 'fixture-thread',
        apiBaseUrl,
        toolsetEnv: {},
        sharedContext: {
          v: 1,
          deploymentId: 'fixture',
          workspaceRoot: root,
          dataDir: root,
          capabilityRoot: root,
          allowedWorkspaceDirs: [root],
          families: ['collab'],
        },
      },
    }),
    resolveFamilies: async () => {
      if (block) {
        block = false;
        entered();
        await gate;
      }
      return ['collab'];
    },
  });
  const server = createServer((req, res) => {
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
      void handler(req, res, raw ? JSON.parse(raw) : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  apiBaseUrl = `http://127.0.0.1:${address.port}`;
  const rpc = (body: unknown) =>
    fetch(`${apiBaseUrl}/mcp?shared=1&family=collab`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-invocation-id': 'fixture-A',
        'x-callback-token': 'fixture-token-A',
        'x-mcp-connection-id': 'fixture-connection',
      },
      body: JSON.stringify(body),
    });
  try {
    const pending = rpc({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: {
        name: 'cat_cafe_post_message',
        arguments: { content: 'fixture cancelled effect', clientMessageId: 'fixture-cancelled' },
      },
    });
    await started;
    const cancellation = await rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 41 } });
    assert.equal(cancellation.status, 202);
    release();
    const response = await pending;
    await response.text();
    assert.equal(effects, 0, 'cancelled queued work must not reach the existing callback effect');
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
