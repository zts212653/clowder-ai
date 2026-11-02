import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withOpenCodeSecretGuard } from '../src/secret-opencode-config.js';

interface LocalServer {
  type: string;
  command: string[];
  environment?: Record<string, string>;
}

function nativeConfig(script: string, callbackEnv: Record<string, string>, environment: Record<string, string> = {}) {
  // The host writes the configuration first; OpenCode's native plugin adds
  // this turn's callback environment only after the user/project merge.
  const config = withOpenCodeSecretGuard({
    mcp: { 'cat-cafe-collab': { type: 'local', command: [process.execPath, script], environment } as LocalServer },
  });
  return withOpenCodeSecretGuard(config, callbackEnv).mcp['cat-cafe-collab'];
}

function connect(server: LocalServer, home: string) {
  const client = new Client({ name: 'native-callback-fixture', version: '1' });
  const transport = new StdioClientTransport({
    command: server.command[0],
    args: server.command.slice(1),
    env: { HOME: home, USERPROFILE: home, ALLOWED_WORKSPACE_DIRS: home, ...server.environment },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  return { client, transport };
}

for (const auth of ['inline', 'refresh-file'] as const)
  test(`OpenCode's guarded first-party MCP retains current ${auth} callback authentication`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'secret-mcp-callback-'));
    const requests: Array<{ invocation: string | string[] | undefined; authenticated: boolean }> = [];
    let expectedInvocation = 'fixture-native-current';
    let expectedToken = ['fixture-native', 'auth-current'].join('-');
    const api = createServer((request, response) => {
      requests.push({
        invocation: request.headers['x-invocation-id'],
        authenticated: request.headers['x-callback-token'] === expectedToken,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ threadId: 'fixture-thread', messages: [], hasMore: false }));
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const address = api.address();
    assert.ok(address && typeof address !== 'string');
    const callbackEnv: Record<string, string> = { CAT_CAFE_API_URL: `http://127.0.0.1:${address.port}` };
    const credentialFile = join(root, 'credentials.json');
    const updateFile = () =>
      writeFile(credentialFile, JSON.stringify({ invocationId: expectedInvocation, callbackToken: expectedToken }), {
        mode: 0o600,
      });
    if (auth === 'refresh-file') {
      await updateFile();
      callbackEnv.CAT_CAFE_CREDENTIAL_FILE = credentialFile;
    } else {
      callbackEnv.CAT_CAFE_INVOCATION_ID = expectedInvocation;
      callbackEnv.CAT_CAFE_CALLBACK_TOKEN = expectedToken;
    }
    const script = fileURLToPath(new URL('../dist/collab.js', import.meta.url));
    const { client, transport } = connect(nativeConfig(script, callbackEnv), root);
    try {
      await client.connect(transport);
      const read = () =>
        client.callTool({ name: 'cat_cafe_get_thread_context', arguments: { threadId: 'fixture-thread' } });
      assert.notEqual((await read()).isError, true, 'the real first-party handler must authenticate successfully');
      assert.deepEqual(requests, [{ invocation: expectedInvocation, authenticated: true }]);
      if (auth === 'refresh-file') {
        expectedInvocation = 'fixture-native-replacement';
        expectedToken = ['fixture-native', 'auth-replacement'].join('-');
        await updateFile();
        assert.notEqual((await read()).isError, true);
        assert.deepEqual(requests[1], { invocation: expectedInvocation, authenticated: true });
      }
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { recursive: true, force: true });
    }
  });

test('a foreign MCP with a first-party name and path suffix never inherits host callback authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secret-mcp-foreign-'));
  const script = join(root, 'packages/mcp-server/dist/collab.js');
  await mkdir(dirname(script), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    script,
    `import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
const server = new McpServer({name:'foreign-fixture',version:'1'});
server.registerTool('auth_scope',{},async()=>({content:[{type:'text',text:JSON.stringify({
  inherited: Object.keys(process.env).filter(key=>key.startsWith('CAT_CAFE_'))
})}]}));
await server.connect(new StdioServerTransport());`,
  );
  const server = nativeConfig(script, {
    CAT_CAFE_API_URL: 'https://fixture.invalid',
    CAT_CAFE_INVOCATION_ID: 'fixture-native-current',
    CAT_CAFE_CALLBACK_TOKEN: ['fixture-native', 'auth-current'].join('-'),
    CAT_CAFE_CREDENTIAL_FILE: join(root, 'host-only-credentials.json'),
  });
  const { client, transport } = connect(server, root);
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'auth_scope', arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: '{"inherited":[]}' }]);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('upstream preload code cannot execute inside the privileged proxy or inherit its callback authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secret-mcp-preload-'));
  const preload = join(root, 'preload.mjs');
  const receipt = join(root, 'receipt.jsonl');
  await writeFile(
    preload,
    `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(receipt)},JSON.stringify({
  callback: Boolean(process.env.CAT_CAFE_CALLBACK_TOKEN || process.env.CAT_CAFE_CREDENTIAL_FILE)
})+'\\n');`,
  );
  const entry = fileURLToPath(new URL('../dist/collab.js', import.meta.url));
  const server = nativeConfig(
    entry,
    {
      CAT_CAFE_API_URL: 'https://fixture.invalid',
      CAT_CAFE_INVOCATION_ID: 'fixture-native-current',
      CAT_CAFE_CALLBACK_TOKEN: ['fixture-native', 'auth-current'].join('-'),
    },
    { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
  );
  const { client, transport } = connect(server, root);
  try {
    await client.connect(transport);
    const observations = (await readFile(receipt, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(observations, [{ callback: false }], 'only the unprivileged upstream may run its preload');
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
