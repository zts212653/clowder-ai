import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mock, type TestContext, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KimiAgentService } from '../src/domains/cats/services/agents/providers/KimiAgentService.js';
import { prepareKimiMcpConfig } from '../src/domains/cats/services/agents/providers/kimi-mcp-config.js';
import { buildChildEnv } from '../src/utils/cli-spawn.js';
import { directMcpContract } from './helpers/direct-mcp-contract.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'kimi-mcp-injection-'));
  const config = join(root, 'instance');
  const workspace = join(root, 'project');
  const dist = join(root, 'binary/packages/mcp-server/dist');
  for (const path of [join(config, '.cat-cafe'), join(workspace, '.kimi-code'), dist]) {
    await mkdir(path, { recursive: true });
  }
  const env = { CAT_CAFE_CONFIG_ROOT: config, CAT_CAFE_RUNTIME_ROOT: join(root, 'binary') };
  const before = { ...process.env };
  Object.assign(process.env, env);
  t.after(async () => {
    for (const key of Object.keys(env)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(dist, 'collab.js'), '// never executed');
  await writeFile(
    join(config, '.cat-cafe/capabilities.json'),
    JSON.stringify({
      version: 2,
      capabilities: [
        {
          id: 'cat-cafe-collab',
          type: 'mcp',
          source: 'cat-cafe',
          globalEnabled: true,
          mcpServer: { command: 'node', args: [join(dist, 'collab.js')] },
        },
      ],
    }),
  );
  const service = new KimiAgentService({
    model: '',
    mcpServerPath: join(dist, 'index.js'),
    l0CompilerFn: async () => 'TEST IDENTITY',
  });
  const file = join(workspace, '.kimi-code/mcp.json');
  const invoke = async (inspect: (options: { env?: Record<string, string | null> }) => Promise<void>) => {
    const messages = [];
    for await (const message of service.invoke('hello', {
      workingDirectory: workspace,
      callbackEnv: {
        KIMI_CODE_HOME: join(root, 'native'),
        CAT_CAFE_CAT_ID: 'kimi',
        CAT_CAFE_THREAD_ID: 'thread-kimi-mcp',
        CAT_CAFE_MCP_TRANSPORT: 'stdio',
        CAT_CAFE_INVOCATION_ID: 'inv-kimi-mcp',
        CAT_CAFE_API_URL: 'http://127.0.0.1:1',
        CAT_CAFE_CALLBACK_TOKEN: 'test-secret',
      },
      spawnCliOverride: async function* (options) {
        await inspect(options);
        yield { role: 'meta', type: 'session.resume_hint', session_id: 'test-kimi-mcp' };
        yield { role: 'assistant', content: 'ok' };
      },
    }))
      messages.push(message);
    return messages;
  };
  const lease = () =>
    prepareKimiMcpConfig({
      workingDirectory: workspace,
      callbackEnv: { CAT_CAFE_CAT_ID: 'kimi', KIMI_CODE_HOME: join(root, 'native') },
    });
  return { root, file, invoke, lease, workspace };
}

test('Kimi receives effective MCP config during invocation and restores native project bytes', async (t) => {
  const { root, file, invoke, workspace } = await fixture(t);
  await writeFile(
    join(root, 'binary/packages/mcp-server/dist/collab.js'),
    `import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { resolveInvocationCredentials } from ${JSON.stringify(new URL('../../mcp-server/dist/tools/invocation-auth.js', import.meta.url).href)};
const server = new McpServer({name:'kimi-auth-fixture',version:'1'});
server.registerTool('auth_scope', {inputSchema:{}}, async () => {
  const auth = resolveInvocationCredentials();
  return {content:[{type:'text',text:JSON.stringify({
    currentInvocation:auth.invocationId==='inv-kimi-mcp',
    currentCallback:auth.callbackToken==='test-secret',
    noInlineInvocation:process.env.CAT_CAFE_INVOCATION_ID===undefined,
    noInlineCallback:process.env.CAT_CAFE_CALLBACK_TOKEN===undefined
  })}]};
});
await server.connect(new StdioServerTransport());`,
  );
  const original = '{ "mcpServers": { "user-tool": { "url": "https://example.test/mcp" } }, "owner": "user" }\n';
  await writeFile(file, original);
  let inspected = false;
  let credentialFile = '';
  const messages = await invoke(async (launch) => {
    inspected = true;
    const raw = await readFile(file, 'utf8');
    const config = JSON.parse(raw);
    assert.ok(config.mcpServers['cat-cafe-collab'], 'managed MCP must be materialized for native Kimi');
    assert.ok(!raw.includes('test-secret'), 'callback secrets must stay in the child environment');
    assert.ok(!raw.includes('inv-kimi-mcp'), 'project config must not freeze an invocation identity');
    const { upstream, launchEnv } = directMcpContract(config.mcpServers['cat-cafe-collab']);
    credentialFile = upstream.env.CAT_CAFE_CREDENTIAL_FILE;
    assert.equal(credentialFile, launch.env?.CAT_CAFE_CREDENTIAL_FILE);
    assert.equal(launchEnv.CAT_CAFE_CREDENTIAL_FILE, credentialFile);
    assert.ok(!credentialFile.startsWith(root), 'the credential lease must be outside the project and native HOME');
    const credentials = JSON.parse(await readFile(credentialFile, 'utf8'));
    assert.equal(credentials.invocationId, 'inv-kimi-mcp');
    assert.equal(credentials.callbackToken, 'test-secret');
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(credentialFile)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(dirname(credentialFile))).mode & 0o777, 0o700);
    }
    assert.equal(launch.env?.KIMI_CODE_HOME, join(root, 'native'), 'native login/history root stays unchanged');
    assert.equal(launch.env?.KIMI_CODE_TRUST_WORKSPACE, '1');
    const relay = config.mcpServers['cat-cafe-collab'];
    const client = new Client({ name: 'kimi-auth-consumer', version: '1' });
    const env = buildChildEnv(launch.env, { workingDirectory: workspace });
    const transport = new StdioClientTransport({
      command: relay.command,
      args: relay.args,
      env: { ...(env as Record<string, string>), ...relay.env },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'auth_scope', arguments: {} });
      assert.deepEqual(result.content, [
        {
          type: 'text',
          text: JSON.stringify({
            currentInvocation: true,
            currentCallback: true,
            noInlineInvocation: false,
            noInlineCallback: true,
          }),
        },
      ]);
    } finally {
      await client.close();
    }
  });
  assert.ok(inspected);
  assert.ok(!messages.some((m) => m.type === 'error'), JSON.stringify(messages));
  assert.equal(await readFile(file, 'utf8'), original);
  await assert.rejects(readFile(credentialFile), { code: 'ENOENT' });
});

test('Kimi preserves a credential file owned by its caller', async (t) => {
  const { root, file, workspace } = await fixture(t);
  const credentialFile = join(root, 'owner-credentials.json');
  const original = JSON.stringify({ invocationId: 'current-invocation', callbackToken: 'current-callback' });
  await writeFile(credentialFile, original, { mode: 0o600 });
  const lease = await prepareKimiMcpConfig({
    workingDirectory: workspace,
    callbackEnv: { CAT_CAFE_CAT_ID: 'kimi', CAT_CAFE_CREDENTIAL_FILE: credentialFile },
  });
  try {
    const config = JSON.parse(await readFile(file, 'utf8'));
    const { upstream, launchEnv } = directMcpContract(config.mcpServers['cat-cafe-collab']);
    assert.equal(upstream.env.CAT_CAFE_CREDENTIAL_FILE, credentialFile);
    assert.equal(launchEnv.CAT_CAFE_CREDENTIAL_FILE, credentialFile);
    assert.equal(lease.env.CAT_CAFE_CREDENTIAL_FILE, credentialFile);
  } finally {
    await lease.dispose();
  }
  assert.equal(await readFile(credentialFile, 'utf8'), original, 'only the caller owns this credential lifetime');
});

test('Kimi removes its private credentials when MCP installation fails and restores user bytes', async (t) => {
  const { file, invoke } = await fixture(t);
  const original = '{"owner":"user"}\n';
  await writeFile(file, original);
  let credentialFile = '';
  const actualWrite = fs.writeFile;
  const writeMock = mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === file && typeof args[1] === 'string') {
      const config = JSON.parse(args[1]);
      const { upstream } = directMcpContract(config.mcpServers['cat-cafe-collab']);
      credentialFile = upstream.env.CAT_CAFE_CREDENTIAL_FILE;
      assert.equal(JSON.parse(await readFile(credentialFile, 'utf8')).callbackToken, 'test-secret');
      throw new Error('injected MCP installation failure');
    }
    return actualWrite(...args);
  });
  syncBuiltinESMExports();
  let messages: Awaited<ReturnType<typeof invoke>>;
  try {
    messages = await invoke(async () => assert.fail('the CLI must not start after an installation failure'));
  } finally {
    writeMock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(
    messages.some((message) => message.type === 'error' && /injected MCP installation failure/.test(message.error)),
  );
  assert.equal(await readFile(file, 'utf8'), original);
  await assert.rejects(readFile(credentialFile), { code: 'ENOENT' });
});

test('Kimi removes only its temporary MCP file when the project had none', async (t) => {
  const { file, invoke } = await fixture(t);
  const messages = await invoke(async () => {
    assert.ok(existsSync(file), 'native MCP file must exist while the client runs');
  });
  assert.ok(!messages.some((m) => m.type === 'error'), JSON.stringify(messages));
  assert.equal(existsSync(file), false);
});

test('Kimi restores the original MCP configuration when the client fails', async (t) => {
  const { file, invoke } = await fixture(t);
  const original = '{"mcpServers":{},"preserved":true}\n';
  await writeFile(file, original);
  const messages = await invoke(async () => {
    assert.ok(JSON.parse(await readFile(file, 'utf8')).mcpServers['cat-cafe-collab']);
    throw new Error('simulated client failure');
  });
  assert.ok(messages.some((m) => m.type === 'error' && m.error?.includes('simulated client failure')));
  assert.equal(await readFile(file, 'utf8'), original);
});

test('Kimi refuses concurrent replacement and preserves externally edited configuration', async (t) => {
  const { file, lease } = await fixture(t);
  const original = '{"original":true}';
  await writeFile(file, original);
  const active = await lease();
  await assert.rejects(lease(), /workspace is in use or requires recovery/);
  await writeFile(file, '{"external-edit":true}');
  await assert.rejects(active.dispose(), /original preserved at/);
  assert.equal(await readFile(file, 'utf8'), '{"external-edit":true}');
});

test('native-only MCP entries are blocked in the temporary surface without editing native HOME', async (t) => {
  const { root, file, invoke } = await fixture(t);
  const native = join(root, 'native/mcp.json');
  await mkdir(join(root, 'native'));
  const original = '{"mcpServers":{"native-only":{"command":"never-run"}}}';
  await writeFile(native, original);
  const messages = await invoke(async () => {
    const config = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(config.mcpServers['native-only'].enabled, false);
    assert.equal(config.mcpServers['native-only'].command, 'never-run');
    assert.ok(config.mcpServers['cat-cafe-collab']);
  });
  assert.ok(!messages.some((m) => m.type === 'error'), JSON.stringify(messages));
  assert.equal(await readFile(native, 'utf8'), original);
});

test('Kimi refuses a project target that is the native HOME MCP configuration', async (t) => {
  const { file, workspace } = await fixture(t);
  const original = '{"mcpServers":{},"native-home":true}\n';
  await writeFile(file, original);
  await assert.rejects(
    prepareKimiMcpConfig({
      workingDirectory: workspace,
      callbackEnv: { CAT_CAFE_CAT_ID: 'kimi', KIMI_CODE_HOME: join(workspace, '.kimi-code') },
    }),
    /native HOME/i,
  );
  assert.equal(await readFile(file, 'utf8'), original);
});

test('Kimi refuses a native HOME alias before its MCP directory exists', async (t) => {
  const { file, workspace } = await fixture(t);
  await rm(join(workspace, '.kimi-code'), { recursive: true });
  const alias = `${workspace}-alias`;
  await fs.symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    prepareKimiMcpConfig({
      workingDirectory: alias,
      callbackEnv: { CAT_CAFE_CAT_ID: 'kimi', KIMI_CODE_HOME: join(workspace, '.kimi-code') },
    }),
    /native HOME/i,
  );
  assert.equal(existsSync(file), false);
});

test('an external atomic save during cleanup is preserved rather than replaced by the pre-invocation file', async (t) => {
  const { file, lease } = await fixture(t);
  await writeFile(file, '{"original":true}');
  const active = await lease();
  const external = '{"external-save-during-cleanup":true}';
  const actualRead = fs.readFile;
  let injected = false;
  const readMock = mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const value = await actualRead(...args);
    if (!injected && String(args[0]).startsWith(join(file, '..')) && String(args[0]).endsWith('.json')) {
      injected = true;
      const staged = join(file, '..', 'external-save.json');
      await writeFile(staged, external);
      await fs.rename(staged, file);
    }
    return value;
  });
  syncBuiltinESMExports();
  try {
    await active.dispose().catch(() => {});
  } finally {
    readMock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(injected);
  assert.equal(await readFile(file, 'utf8'), external);
});
