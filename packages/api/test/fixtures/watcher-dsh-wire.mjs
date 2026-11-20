// Manual installed-carrier qualification. Uses a private loopback provider, no real model calls.
// Run after the API build; the invocation credentials must be cleared by with-test-home.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url)),
  load = async (path) => import(pathToFileURL(join(root, 'packages/api/dist', path)).href);
await import('node:fs/promises').then((fs) =>
  fs.mkdir(join(root, '.cat-cafe/evidence/f335-watcher-providers'), { recursive: true, mode: 0o700 }),
);
const { inspectDshNativeLaunch } = await load('config/native-accounts/dsh-installation.js');
const { readDshNativeAccount } = await load('config/native-accounts/dsh-account.js');
const { providerProfileAccountSnapshot } = await load(
  'domains/cats/services/agents/invocation/execution-account-binding.js',
);
const { invokeDshWatcher } = await load('domains/cats/services/agents/providers/acp/dsh/dsh-watcher-invocation.js');
const { watcherMcpToolMap } = await load('domains/cats/services/agents/providers/watcher-mcp-input.js');
const { watcherPanelToolPolicy } = await load('domains/concierge/watcher/panel/watcher-panel-policy.js');
const scratch = await mkdtemp(join(tmpdir(), 'f335-dsh-wire-')),
  home = join(scratch, 'source'),
  workspace = join(scratch, 'workspace'),
  profile = join(home, 'profiles/acp');
await mkdir(profile, { recursive: true });
await mkdir(workspace);
await writeFile(
  join(profile, 'package.json'),
  JSON.stringify({
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } },
  }),
);
const credential = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-only\n';
await writeFile(join(home, '.credentials.yaml'), credential, { mode: 0o600 });
await writeFile(join(workspace, 'read-proof.txt'), 'FILE-READ-PROOF');
const req = createRequire(join(root, 'packages/mcp-server/package.json'));
const sdk = pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href,
  transport = pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
const calls = join(scratch, 'calls.jsonl'),
  mcp = join(scratch, 'mcp.mjs');
await writeFile(
  mcp,
  `import {McpServer} from ${JSON.stringify(sdk)};import {StdioServerTransport} from ${JSON.stringify(transport)};import {appendFileSync,readFileSync} from 'node:fs';const s=new McpServer({name:'f335-fixture',version:'1'});for(const name of JSON.parse(process.env.FIXTURE_NAMES))s.registerTool(name,{description:'Offline watcher fixture',inputSchema:{}},async()=>{appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({name})+'\\n');return {content:[{type:'text',text:name==='cat_cafe_read_file_slice'?readFileSync(process.env.FIXTURE_FILE,'utf8'):name==='cat_cafe_get_thread_context'?'THREAD-READ-PROOF':'MEMORY-READ-PROOF'}]}});await s.connect(new StdioServerTransport());`,
);
const policy = watcherPanelToolPolicy(),
  toolMap = watcherMcpToolMap(policy.allowedToolNames),
  requests = [],
  messages = [];
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const i = requests.length;
  const tools = [
    'mcp__cat-cafe-memory__cat_cafe_read_file_slice',
    'mcp__cat-cafe-collab__cat_cafe_get_thread_context',
    'mcp__cat-cafe-memory__cat_cafe_read_memory',
    'bash',
    'mcp__foreign__write',
  ];
  const tool = tools[i - 1],
    block = tool
      ? {
          type: 'tool_use',
          id: 'f335-' + i,
          name: tool,
          input: tool === 'bash' ? { command: 'touch ' + join(scratch, 'FORBIDDEN') } : {},
        }
      : { type: 'text', text: 'WATCHER-FINISHED' };
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'f335-' + i,
        type: 'message',
        role: 'assistant',
        content: [],
        model: body.model,
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const abort = new AbortController(),
  timer = setTimeout(() => abort.abort(), 60000);
try {
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    JSON.stringify([
      {
        id: 'llm-deepseek',
        config: { baseURL: `http://127.0.0.1:${server.address().port}`, thinking: 'disabled', maxTokens: 64 },
      },
    ]),
  );
  const native = inspectDshNativeLaunch({
    command: 'dsh',
    args: ['--profile', 'acp'],
    env: { DSH_HOME: home },
    projectRoot: scratch,
  });
  assert.ok(native, 'qualified installed DSH required');
  const modelSelection = '["deepseek-official","deepseek-flash"]',
    account = await readDshNativeAccount(native, modelSelection, workspace);
  const servers = Object.fromEntries(
    Object.entries(toolMap).map(([name, names]) => [
      name,
      {
        command: process.execPath,
        args: [mcp],
        env: {
          FIXTURE_NAMES: JSON.stringify(names),
          FIXTURE_CALLS: calls,
          FIXTURE_FILE: join(workspace, 'read-proof.txt'),
        },
      },
    ]),
  );
  const options = {
    workingDirectory: workspace,
    hostSessionId: 'host-watcher-session',
    signal: abort.signal,
    executionAccount: providerProfileAccountSnapshot('acp', account.profile),
    toolExecutionPolicy: policy,
    callbackEnv: {
      CAT_CAFE_DATA_DIR: join(scratch, 'data'),
      CAT_CAFE_CAT_ID: 'deepseek-flash',
      CAT_CAFE_API_URL: 'http://127.0.0.1:9',
      CAT_CAFE_INVOCATION_ID: 'offline',
      CAT_CAFE_CALLBACK_TOKEN: 'offline',
    },
    frozenNativeMcpConfig: {
      source: 'fallback',
      servers,
      catCafeMcpServerNames: Object.keys(servers),
      pluginMcpServerNames: [],
    },
  };
  const run = async (extra) => {
    const rows = [];
    for await (const row of invokeDshWatcher({
      catId: 'deepseek-flash',
      modelSelection,
      native,
      prompt: 'Read files, thread and memory; stay read-only.',
      compile: async () => 'F335-WATCHER-IDENTITY',
      options: { ...options, ...extra },
    })) {
      rows.push(row);
      messages.push(row);
    }
    assert.equal(
      rows.find((row) => row.type === 'error'),
      undefined,
      JSON.stringify(rows),
    );
    return rows.find((row) => row.type === 'session_init')?.sessionId;
  };
  const sessionId = await run({});
  assert.ok(sessionId);
  const firstRequests = requests.length;
  assert.ok(firstRequests >= 6);
  const secondSession = await run({ sessionId });
  assert.equal(secondSession, sessionId);
  const actual = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .map((row) => row.name);
  assert.deepEqual(actual, ['cat_cafe_read_file_slice', 'cat_cafe_get_thread_context', 'cat_cafe_read_memory']);
  const expected = Object.entries(toolMap)
    .flatMap(([family, names]) => names.map((name) => 'mcp__' + family + '__' + name))
    .sort();
  for (const body of requests) assert.deepEqual(body.tools.map((tool) => tool.name).sort(), expected);
  assert.match(
    JSON.stringify(requests[firstRequests].messages),
    /FILE-READ-PROOF/,
    'native load retains the first turn',
  );
  const errors = requests
    .flatMap((r) => r.messages ?? [])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === 'tool_result' && b.is_error);
  assert.ok(errors.some((b) => b.tool_use_id === 'f335-4'));
  assert.ok(errors.some((b) => b.tool_use_id === 'f335-5'));
  await assert.rejects(access(join(scratch, 'FORBIDDEN')));
  assert.equal(await readFile(join(home, '.credentials.yaml'), 'utf8'), credential);
  const proof = {
    claim: 'installed-dsh-watcher-wire',
    realModelRequests: 0,
    localProviderRequests: requests.length,
    readers: actual,
    toolCount: expected.length,
    resumedSameSession: true,
    nativeAndForeignWritersDenied: true,
    credentialSourceUnchanged: true,
  };
  await writeFile(
    join(root, '.cat-cafe/evidence/f335-watcher-providers/dsh-installed-proof.json'),
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof));
} catch (error) {
  await writeFile(
    join(root, '.cat-cafe/evidence/f335-watcher-providers/dsh-installed-failure.json'),
    JSON.stringify({ error: String(error), messages, requests }, null, 2),
  );
  throw error;
} finally {
  clearTimeout(timer);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(scratch, { recursive: true, force: true });
}
