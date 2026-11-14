import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isInstalledManagedMcpServer } from '@cat-cafe/mcp-server/dist/managed-mcp-config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  bindSessionCredentialFile,
  prepareSessionCredentialFile,
} from '../../dist/domains/cats/services/agents/providers/acp/acp-credential-file.js';
import { resolveBuiltinCatCafeServer } from '../../dist/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';
import { materializeSessionMcpServers } from '../../dist/domains/cats/services/agents/providers/acp/acp-session-env.js';
import { captureCodexMcpInput } from '../../dist/domains/cats/services/agents/providers/codex-mcp-input.js';
import { buildOpenCodeMcpSync } from '../../dist/domains/cats/services/agents/providers/opencode-mcp-injection.js';
import { withOpenCodeSecretGuard } from '../../dist/domains/cats/services/agents/providers/opencode-secret-config.js';
import { resolveProviderMcpConfig } from '../../dist/domains/cats/services/agents/providers/provider-mcp-config.js';

test('packaged first-party entrypoints retain callback binding across two ACP sessions and a resume', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'packaged MCP separate copies '));
  const copy = join(root, 'packages/mcp-server/dist');
  mkdirSync(copy, { recursive: true });
  mkdirSync(join(root, '.cat-cafe'));
  const names = ['collab', 'memory', 'signals', 'limb', 'audio', 'finance'];
  for (const name of names)
    copyFileSync(
      fileURLToPath(new URL(`../../../mcp-server/dist/${name}.js`, import.meta.url)),
      join(copy, `${name}.js`),
    );
  const original = {
    runtimeRoot: process.env.CAT_CAFE_RUNTIME_ROOT,
    credentialDir: process.env.CAT_CAFE_MCP_CREDS_DIR,
  };
  process.env.CAT_CAFE_RUNTIME_ROOT = root;
  process.env.CAT_CAFE_MCP_CREDS_DIR = join(root, 'credentials');
  t.after(() => {
    for (const [key, value] of [
      ['CAT_CAFE_RUNTIME_ROOT', original.runtimeRoot],
      ['CAT_CAFE_MCP_CREDS_DIR', original.credentialDir],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const requests = [];
  const api = createServer((request, response) => {
    const invocation = request.headers['x-invocation-id'];
    requests.push({ invocation, token: request.headers['x-callback-token'] });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ threadId: invocation.startsWith('A') ? 'thread-A' : 'thread-B', messages: [], hasMore: false }),
    );
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const callbackFor = (invocation) => ({
    CAT_CAFE_API_URL: `http://127.0.0.1:${api.address().port}`,
    CAT_CAFE_THREAD_ID: invocation.startsWith('A') ? 'thread-A' : 'thread-B',
    CAT_CAFE_CAT_ID: 'codex',
    CAT_CAFE_USER_ID: 'test-owner',
    CAT_CAFE_INVOCATION_ID: invocation,
    CAT_CAFE_CALLBACK_TOKEN: `synthetic-${invocation}`,
  });
  const descriptor = resolveBuiltinCatCafeServer(root, 'cat-cafe-collab');
  assert.ok(descriptor);
  assert.notEqual(
    realpathSync(join(copy, 'collab.js')),
    realpathSync(fileURLToPath(new URL('../../../mcp-server/dist/collab.js', import.meta.url))),
    'the packaged runtime has a physical copy distinct from the API-imported MCP package',
  );
  const foreignCopy = { ...descriptor, args: [join(copy, 'collab.js')], env: [] };
  assert.equal(
    isInstalledManagedMcpServer(foreignCopy),
    false,
    'matching content and name do not grant callback authority',
  );
  assert.deepEqual(materializeSessionMcpServers([foreignCopy], callbackFor('A'))[0], foreignCopy);

  const a = prepareSessionCredentialFile(callbackFor('A'));
  const b = prepareSessionCredentialFile(callbackFor('B'));
  bindSessionCredentialFile('session-A', a.path);
  bindSessionCredentialFile('session-B', b.path);
  const launchA = materializeSessionMcpServers([descriptor], a.env)[0];
  const launchB = materializeSessionMcpServers([descriptor], b.env)[0];
  assert.equal(
    Object.fromEntries(launchA.env.map(({ name, value }) => [name, value])).CAT_CAFE_CREDENTIAL_FILE,
    a.path,
    'the API-generated first-party entrypoint must acquire its own session callback binding',
  );
  const clients = [new Client({ name: 'packaged-A', version: '1' }), new Client({ name: 'packaged-B', version: '1' })];
  try {
    for (const [index, launch] of [launchA, launchB].entries()) {
      const transport = new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        env: Object.fromEntries(launch.env.map(({ name, value }) => [name, value])),
        stderr: 'pipe',
      });
      transport.stderr?.on('data', () => {});
      await clients[index].connect(transport);
    }
    for (const [index, invocation] of [
      [0, 'A'],
      [1, 'B'],
      [0, 'A-resumed'],
      [1, 'B'],
    ]) {
      if (invocation === 'A-resumed') {
        const resumed = prepareSessionCredentialFile(callbackFor(invocation), 'session-A');
        assert.equal(resumed.path, a.path);
        assert.notEqual(resumed.path, b.path);
      }
      const result = await clients[index].callTool({ name: 'cat_cafe_get_thread_context', arguments: {} });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.equal(JSON.parse(result.content[0].text).threadId, invocation.startsWith('A') ? 'thread-A' : 'thread-B');
      assert.deepEqual(requests.at(-1), { invocation, token: `synthetic-${invocation}` });
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});

for (const provider of ['native', 'codex', 'opencode']) {
  test(`${provider} resolves trusted packaged MCP from the same package as the callback binder`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'packaged MCP provider '));
    const copy = join(root, 'packages/mcp-server/dist');
    mkdirSync(copy, { recursive: true });
    for (const name of ['index', 'collab'])
      copyFileSync(
        fileURLToPath(new URL(`../../../mcp-server/dist/${name}.js`, import.meta.url)),
        join(copy, `${name}.js`),
      );
    mkdirSync(join(root, '.cat-cafe'));
    writeFileSync(
      join(root, '.cat-cafe/capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: [
          {
            id: 'cat-cafe-collab',
            type: 'mcp',
            enabled: true,
            globalEnabled: true,
            source: 'cat-cafe',
            mcpServer: { command: process.execPath, args: [join(copy, 'collab.js')] },
          },
        ],
      }),
    );
    const previous = process.env.CAT_CAFE_RUNTIME_ROOT;
    process.env.CAT_CAFE_RUNTIME_ROOT = root;
    t.after(() => {
      if (previous === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    });
    if (provider === 'opencode') {
      const mcp = buildOpenCodeMcpSync(join(copy, 'index.js'), 'codex', root, root);
      const config = withOpenCodeSecretGuard({ mcp }, { CAT_CAFE_INVOCATION_ID: 'opencode-A' });
      assert.equal(
        config.mcp['cat-cafe-collab'].environment?.CAT_CAFE_INVOCATION_ID,
        'opencode-A',
        'the OpenCode launch must bind callbacks to the API-imported package',
      );
      return;
    }
    if (provider === 'codex') {
      const plan = await captureCodexMcpInput('codex', root);
      const server = plan.servers.find((entry) => entry.name === 'cat-cafe-collab');
      assert.ok(server);
      assert.equal(
        isInstalledManagedMcpServer({ command: server.command, args: server.args, env: {} }),
        true,
        'the Codex capture must select the exact trusted package rather than a same-content runtime copy',
      );
      return;
    }
    const credential = join(root, 'turn.json');
    writeFileSync(credential, JSON.stringify({ invocationId: 'native-A', callbackToken: 'synthetic-native-A' }));
    const servers = await resolveProviderMcpConfig({
      mcpServerPath: join(copy, 'index.js'),
      provider: 'claude',
      workingDirectory: root,
      callbackEnv: {
        CAT_CAFE_API_URL: 'http://127.0.0.1:59999',
        CAT_CAFE_CAT_ID: 'codex',
        CAT_CAFE_INVOCATION_ID: 'native-A',
        CAT_CAFE_CALLBACK_TOKEN: 'synthetic-native-A',
        CAT_CAFE_CREDENTIAL_FILE: credential,
        CAT_CAFE_MCP_TRANSPORT: 'shared',
      },
    });
    assert.equal(
      servers['cat-cafe-collab'].type,
      'http',
      'a trusted packaged native server must materialize onto the invocation-scoped shared gateway',
    );
    assert.equal(servers['cat-cafe-collab'].headers['x-invocation-id'], 'native-A');
  });
}
