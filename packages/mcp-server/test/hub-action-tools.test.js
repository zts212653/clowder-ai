import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handlePreviewOpen, handleWorkspaceNavigate, hubActionTools } from '../dist/tools/hub-action-tools.js';

async function withCallbackServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, received: true }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.ok(address);

  const oldEnv = {
    apiUrl: process.env.CAT_CAFE_API_URL,
    invocationId: process.env.CAT_CAFE_INVOCATION_ID,
    callbackToken: process.env.CAT_CAFE_CALLBACK_TOKEN,
    agentKeySecret: process.env.CAT_CAFE_AGENT_KEY_SECRET,
    agentKeyFile: process.env.CAT_CAFE_AGENT_KEY_FILE,
    agentKeyFiles: process.env.CAT_CAFE_AGENT_KEY_FILES,
  };

  process.env.CAT_CAFE_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.CAT_CAFE_INVOCATION_ID = 'inv-f223';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-f223';
  delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
  delete process.env.CAT_CAFE_AGENT_KEY_FILE;
  delete process.env.CAT_CAFE_AGENT_KEY_FILES;

  try {
    return await handler(requests);
  } finally {
    if (oldEnv.apiUrl === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = oldEnv.apiUrl;
    if (oldEnv.invocationId === undefined) delete process.env.CAT_CAFE_INVOCATION_ID;
    else process.env.CAT_CAFE_INVOCATION_ID = oldEnv.invocationId;
    if (oldEnv.callbackToken === undefined) delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    else process.env.CAT_CAFE_CALLBACK_TOKEN = oldEnv.callbackToken;
    if (oldEnv.agentKeySecret === undefined) delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    else process.env.CAT_CAFE_AGENT_KEY_SECRET = oldEnv.agentKeySecret;
    if (oldEnv.agentKeyFile === undefined) delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    else process.env.CAT_CAFE_AGENT_KEY_FILE = oldEnv.agentKeyFile;
    if (oldEnv.agentKeyFiles === undefined) delete process.env.CAT_CAFE_AGENT_KEY_FILES;
    else process.env.CAT_CAFE_AGENT_KEY_FILES = oldEnv.agentKeyFiles;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('exports first-party Hub action tools in the MCP toolset', () => {
  assert.deepEqual(
    hubActionTools.map((tool) => tool.name),
    ['cat_cafe_workspace_navigate', 'cat_cafe_preview_open'],
  );
});

test('workspace navigate description distinguishes request acceptance from visible delivery', () => {
  const workspaceTool = hubActionTools.find((tool) => tool.name === 'cat_cafe_workspace_navigate');
  assert.match(workspaceTool.description, /deliveryStatus/);
  assert.match(workspaceTool.description, /applied.*queued.*blocked.*unconfirmed/);
  assert.match(workspaceTool.description, /ok:true.*not.*visible/i);
  assert.match(workspaceTool.description, /threadId.*required.*agent-key/i);
  assert.match(workspaceTool.inputSchema.threadId.description, /required.*agent-key/i);
  assert.match(workspaceTool.inputSchema.threadId.description, /omit.*invocation/i);
});

test('cat_cafe_workspace_navigate posts a typed workspace navigate request', async () => {
  await withCallbackServer(async (requests) => {
    const result = await handleWorkspaceNavigate({
      path: 'docs/features/F223-capability-surface-registry.md',
      action: 'open',
      worktreeId: 'cat-cafe',
      threadId: 'thread-f223',
      catId: 'codex',
      line: 140,
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /"ok":true/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/workspace/navigate');
    assert.equal(requests[0].headers['x-invocation-id'], 'inv-f223');
    assert.equal(requests[0].headers['x-callback-token'], 'token-f223');
    assert.deepEqual(requests[0].body, {
      path: 'docs/features/F223-capability-surface-registry.md',
      action: 'open',
      worktreeId: 'cat-cafe',
      threadId: 'thread-f223',
      catId: 'codex',
      line: 140,
    });
  });
});

test('cat_cafe_workspace_navigate accepts a Codex-native absolute path without a worktreeId hint', async () => {
  await withCallbackServer(async (requests) => {
    const result = await handleWorkspaceNavigate({
      path: '/home/user/cat-cafe/docs/VISION.md',
      action: 'open',
      threadId: 'thread-native-path',
      catId: 'codex-sol',
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(requests[0].body, {
      path: '/home/user/cat-cafe/docs/VISION.md',
      action: 'open',
      threadId: 'thread-native-path',
      catId: 'codex-sol',
    });
  });
});

test('cat_cafe_preview_open posts a typed preview auto-open request', async () => {
  await withCallbackServer(async (requests) => {
    const result = await handlePreviewOpen({
      port: 5173,
      path: '/dashboard',
      worktreeId: 'cat-cafe',
      threadId: 'thread-f223',
      catId: 'codex',
    });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /"ok":true/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/preview/auto-open');
    assert.deepEqual(requests[0].body, {
      port: 5173,
      path: '/dashboard',
      worktreeId: 'cat-cafe',
      threadId: 'thread-f223',
      catId: 'codex',
    });
  });
});

test('Hub action tools use variant-scoped agent-key credentials when requested', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-hub-action-agent-key-'));
  try {
    await withCallbackServer(async (requests) => {
      delete process.env.CAT_CAFE_INVOCATION_ID;
      delete process.env.CAT_CAFE_CALLBACK_TOKEN;
      const keyFile = join(tempDir, 'antig-opus.secret');
      writeFileSync(keyFile, 'agent-key-secret\n', { mode: 0o600 });
      process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ 'antig-opus': keyFile });

      const result = await handleWorkspaceNavigate({
        path: 'docs/features/F223-capability-surface-registry.md',
        action: 'open',
        worktreeId: 'cat-cafe',
        threadId: 'thread-f223',
        catId: 'antig-opus',
        agentKeyCatId: 'antig-opus',
      });

      assert.equal(result.isError, undefined);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].headers['x-agent-key-secret'], 'agent-key-secret');
      assert.equal(requests[0].headers['x-invocation-id'], undefined);
      assert.equal(requests[0].headers['x-callback-token'], undefined);
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('agent-key workspace navigation fails before HTTP when threadId is missing', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-hub-action-agent-key-thread-'));
  try {
    await withCallbackServer(async (requests) => {
      delete process.env.CAT_CAFE_INVOCATION_ID;
      delete process.env.CAT_CAFE_CALLBACK_TOKEN;
      const keyFile = join(tempDir, 'antig-opus.secret');
      writeFileSync(keyFile, 'agent-key-secret\n', { mode: 0o600 });
      process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ 'antig-opus': keyFile });

      const result = await handleWorkspaceNavigate({
        path: 'docs/features/F223-capability-surface-registry.md',
        action: 'open',
        worktreeId: 'cat-cafe',
        catId: 'antig-opus',
        agentKeyCatId: 'antig-opus',
      });

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /threadId.*required.*agent-key/i);
      assert.equal(requests.length, 0);
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('invocation-auth workspace navigation may omit threadId even when agentKeyCatId is present', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-hub-action-invocation-thread-'));
  try {
    await withCallbackServer(async (requests) => {
      const keyFile = join(tempDir, 'antig-opus.secret');
      writeFileSync(keyFile, 'agent-key-secret\n', { mode: 0o600 });
      process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ 'antig-opus': keyFile });

      const result = await handleWorkspaceNavigate({
        path: 'docs/features/F223-capability-surface-registry.md',
        action: 'open',
        worktreeId: 'cat-cafe',
        catId: 'codex-sol',
        agentKeyCatId: 'antig-opus',
      });

      assert.equal(result.isError, undefined);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].headers['x-invocation-id'], 'inv-f223');
      assert.equal(requests[0].headers['x-callback-token'], 'token-f223');
      assert.equal(requests[0].headers['x-agent-key-secret'], undefined);
      assert.equal(requests[0].body.threadId, undefined);
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
