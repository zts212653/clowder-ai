// Manual installed-carrier qualification. Uses a private loopback provider, no real model calls.
// Run after the API build; the invocation credentials must be cleared by with-test-home.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url)),
  load = async (p) => import(pathToFileURL(join(root, 'packages/api/dist', p)).href);
await import('node:fs/promises').then((fs) =>
  fs.mkdir(join(root, '.cat-cafe/evidence/f335-watcher-providers'), { recursive: true, mode: 0o700 }),
);
const { prepareAgyNativeLaunch } = await load('domains/cats/services/agents/providers/agy-native/agy-native-launch.js');
const { runAgyNativeInvocation } = await load(
  'domains/cats/services/agents/providers/agy-native/run/agy-native-invocation.js',
);
const { resolveCliCommand } = await load('utils/cli-resolve.js'),
  { spawnCli } = await load('utils/cli-spawn.js');
const { watcherPanelToolPolicy } = await load('domains/concierge/watcher/panel/watcher-panel-policy.js');
const { watcherMcpToolMap } = await load('domains/cats/services/agents/providers/watcher-mcp-input.js');
const scratch = mkdtempSync(join(tmpdir(), 'f335-agy-wire-')),
  workspace = join(scratch, 'workspace'),
  homeRoot = join(scratch, 'profiles'),
  home = join(homeRoot, 'fixture');
mkdirSync(workspace);
mkdirSync(join(home, '.gemini/antigravity-cli'), { recursive: true });
const settings = join(home, '.gemini/antigravity-cli/settings.json'),
  baseline = JSON.stringify({ modelProvider: 'gemini', model: 'gemini-4-carbon-high', trustedWorkspaces: [] });
writeFileSync(settings, baseline);
const req = createRequire(join(root, 'packages/mcp-server/package.json')),
  sdk = pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href,
  transport = pathToFileURL(req.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
const policy = watcherPanelToolPolicy(),
  toolMap = watcherMcpToolMap(policy.allowedToolNames),
  log = join(scratch, 'calls.jsonl'),
  mcp = join(scratch, 'mcp.mjs'),
  requests = [],
  events = [],
  raw = [];
writeFileSync(join(workspace, 'proof.txt'), 'F335-AGY-FILE');
writeFileSync(
  mcp,
  `import {McpServer} from ${JSON.stringify(sdk)};import {StdioServerTransport} from ${JSON.stringify(transport)};import {appendFileSync,readFileSync} from 'node:fs';const s=new McpServer({name:'watcher-fixture',version:'1'});for(const name of JSON.parse(process.env.FIXTURE_NAMES))s.registerTool(name,{description:'Offline native watcher read',inputSchema:{}},async()=>{appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({name})+'\\n');return {content:[{type:'text',text:name==='cat_cafe_read_file_slice'?readFileSync(process.env.FIXTURE_FILE,'utf8'):name==='cat_cafe_get_thread_context'?'F335-AGY-THREAD':'F335-AGY-MEMORY'}]}});await s.connect(new StdioServerTransport());`,
);
let count = 0;
const server = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : {};
  if (req.method === 'GET') {
    res.end(JSON.stringify({ models: [] }));
    return;
  }
  requests.push(body);
  let parts = [{ text: 'F335-AGY-DONE' }];
  if (body.tools) {
    count++;
    const readers = [
      ['cat-cafe-memory', 'cat_cafe_read_file_slice'],
      ['cat-cafe-collab', 'cat_cafe_get_thread_context'],
      ['cat-cafe-memory', 'cat_cafe_read_memory'],
    ];
    const reader = readers[count - 1];
    if (reader)
      parts = [
        {
          functionCall: { name: 'call_mcp_tool', args: { ServerName: reader[0], ToolName: reader[1], Arguments: {} } },
        },
      ];
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } })}\n\n`,
  );
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const controller = new AbortController(),
  timer = setTimeout(() => controller.abort(), 90000),
  binary = resolveCliCommand('agy');
let plan;
try {
  assert.ok(binary);
  const servers = Object.fromEntries(
    Object.entries(toolMap).map(([name, names]) => [
      name,
      {
        command: process.execPath,
        args: [mcp],
        env: { FIXTURE_NAMES: JSON.stringify(names), FIXTURE_LOG: log, FIXTURE_FILE: join(workspace, 'proof.txt') },
      },
    ]),
  );
  const options = {
    workingDirectory: workspace,
    signal: controller.signal,
    toolExecutionPolicy: policy,
    callbackEnv: {
      CAT_CAFE_API_URL: 'http://127.0.0.1:9',
      CAT_CAFE_CAT_ID: 'gemini-carbon',
      CAT_CAFE_THREAD_ID: 'fixture',
      CAT_CAFE_INVOCATION_ID: 'fixture',
      CAT_CAFE_CALLBACK_TOKEN: 'fixture',
    },
    frozenNativeMcpConfig: {
      source: 'fallback',
      servers,
      catCafeMcpServerNames: Object.keys(servers),
      pluginMcpServerNames: [],
    },
    spawnCliOverride: async function* (launch) {
      for await (const event of spawnCli({
        ...launch,
        timeoutMs: 30000,
        env: {
          ...launch.env,
          GEMINI_API_KEY: 'fixture-only',
          GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          HTTP_PROXY: 'http://127.0.0.1:9',
          HTTPS_PROXY: 'http://127.0.0.1:9',
          ALL_PROXY: 'http://127.0.0.1:9',
          NO_PROXY: '127.0.0.1,localhost',
        },
      })) {
        raw.push(event);
        yield event;
      }
    },
  };
  const run = async (extra) => {
    const current = { ...options, ...extra },
      rows = [];
    plan = await prepareAgyNativeLaunch({
      catId: 'gemini-carbon',
      model: 'gemini-4-carbon-high',
      command: binary,
      profileConfig: {
        enabled: true,
        profileId: 'fixture',
        homeRoot,
        autoApprove: true,
        model: 'gemini-4-carbon-high',
      },
      workspace,
      prompt: 'Read the settled work.',
      body: '# Identity\nF335-WATCHER-IDENTITY',
      options: current,
    });
    // Offline transport only: the isolated app-data view uses the fake Gemini endpoint.
    // Production keeps the ordinary native OAuth provider; no account source is edited.
    const gemini = plan.cliOptions.args.find((arg) => arg.startsWith('--gemini_dir=')).slice('--gemini_dir='.length);
    const data = plan.cliOptions.args.find((arg) => arg.startsWith('--app_data_dir=')).slice('--app_data_dir='.length);
    writeFileSync(resolve(gemini, data, 'settings.json'), JSON.stringify({ modelProvider: 'gemini' }));
    for await (const row of runAgyNativeInvocation({
      catId: 'gemini-carbon',
      model: 'gemini-4-carbon-high',
      prompt: 'Read the settled work.',
      launch: plan,
      metadata: { provider: 'google', model: 'gemini-4-carbon-high' },
      rawArchive: { append: async () => {} },
      spawnCliFn: spawnCli,
      options: current,
      compactionRequested: false,
    })) {
      rows.push(row);
      events.push(row);
    }
    await plan.disposeCredentials?.();
    plan = undefined;
    assert.equal(
      rows.find((row) => row.type === 'error'),
      undefined,
      JSON.stringify(rows),
    );
    const init = rows.find((row) => row.type === 'session_init');
    assert.ok(init?.sessionId);
    return init;
  };
  const first = await run({}),
    before = requests.length;
  const second = await run({ sessionId: first.sessionId, nativeSessionBinding: first.nativeSessionBinding });
  assert.equal(second.sessionId, first.sessionId);
  const calls = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .map((x) => x.name);
  assert.deepEqual(calls, ['cat_cafe_read_file_slice', 'cat_cafe_get_thread_context', 'cat_cafe_read_memory']);
  assert.match(JSON.stringify(requests.slice(before)), /F335-AGY-FILE/);
  const toolNames = [
    ...new Set(
      requests.flatMap((r) => r.tools?.flatMap((t) => t.functionDeclarations?.map((x) => x.name) ?? []) ?? []),
    ),
  ];
  for (const name of toolNames)
    assert.ok(['call_mcp_tool', 'list_resources', 'read_resource', 'manage_task'].includes(name), name);
  assert.equal(readFileSync(settings, 'utf8'), baseline);
  const proof = {
    claim: 'installed-agy-watcher-wire',
    realModelRequests: 0,
    localProviderRequests: requests.length,
    readers: calls,
    toolNames,
    resumedSameSession: true,
    accountSettingsUnchanged: true,
  };
  writeFileSync(
    join(root, '.cat-cafe/evidence/f335-watcher-providers/agy-installed-proof.json'),
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof));
} catch (error) {
  writeFileSync(
    join(root, '.cat-cafe/evidence/f335-watcher-providers/agy-installed-failure.json'),
    JSON.stringify({ error: String(error), events, raw, requests }, null, 2),
  );
  throw error;
} finally {
  clearTimeout(timer);
  await plan?.disposeCredentials?.();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(scratch, { recursive: true, force: true });
}
