// Manual installed-carrier qualification. Uses a private loopback provider, no real model calls.
// Run after the API build; the invocation credentials must be cleared by with-test-home.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url)),
  load = async (path) => import(pathToFileURL(join(root, 'packages/api/dist', path)).href);
await import('node:fs/promises').then((fs) =>
  fs.mkdir(join(root, '.cat-cafe/evidence/f335-watcher-providers'), { recursive: true, mode: 0o700 }),
);
const { ClaudeAgentService } = await load('domains/cats/services/agents/providers/ClaudeAgentService.js');
const { ClaudeSdkAgentService } = await load('domains/cats/services/agents/providers/ClaudeSdkAgentService.js');
const { watcherPanelToolPolicy } = await load('domains/concierge/watcher/panel/watcher-panel-policy.js');
const { watcherMcpToolMap } = await load('domains/cats/services/agents/providers/watcher-mcp-input.js');
const workspace = await mkdtemp(join(tmpdir(), 'f335-claude-wire-')),
  requests = [],
  policy = watcherPanelToolPolicy(),
  toolMap = watcherMcpToolMap(policy.allowedToolNames),
  proofs = [],
  diagnostics = [];
await writeFile(join(workspace, 'proof.txt'), 'ACTUAL-FILE-PROOF');
let activeCalls = 0;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {}
  if (!body?.messages) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url?.includes('models') ? { data: [] } : { ok: true }));
    return;
  }
  requests.push({ path: req.url, body });
  const tool = activeCalls++ === 0;
  const id = 'msg_' + randomUUID().replaceAll('-', ''),
    message = {
      id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'F335-NATIVE-OK' }],
      model: body.model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 4 },
    };
  if (!body.stream) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(message));
    return;
  }
  const events = [
    {
      type: 'message_start',
      message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: tool
        ? { type: 'tool_use', id: 'file-proof', name: 'mcp__cat-cafe-memory__cat_cafe_read_file_slice', input: {} }
        : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: tool
        ? {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ path: join(workspace, 'proof.txt'), startLine: 1, endLine: 1 }),
          }
        : { type: 'text_delta', text: 'F335-NATIVE-OK' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const controller = new AbortController(),
  timer = setTimeout(() => controller.abort(), 90000);
try {
  for (const [carrier, Service] of [
    ['cli', ClaudeAgentService],
    ['sdk', ClaudeSdkAgentService],
  ]) {
    activeCalls = 0;
    const beforeRequests = requests.length;
    const raw = [],
      service = new Service({
        catId: 'sonnet',
        model: 'claude-sonnet-5-5',
        mcpServerPath: join(root, 'packages/mcp-server/dist/index.js'),
        rawArchive: {
          append: async (_id, event) => {
            raw.push(event);
          },
        },
        l0CompilerFn: async (input) => {
          if (input.outPath) await writeFile(input.outPath, 'F335-WATCHER-IDENTITY');
          return 'F335-WATCHER-IDENTITY';
        },
      });
    const servers = Object.fromEntries(
      Object.keys(toolMap).map((name) => [
        name,
        {
          command: process.execPath,
          args: [join(root, 'packages/mcp-server/dist', name.replace('cat-cafe-', '') + '.js')],
          env: { ALLOWED_WORKSPACE_DIRS: workspace },
        },
      ]),
    );
    const options = {
      invocationId: randomUUID(),
      hostSessionId: 'offline-' + carrier,
      workingDirectory: workspace,
      signal: controller.signal,
      toolExecutionPolicy: policy,
      callbackEnv: {
        CAT_CAFE_DATA_DIR: workspace,
        CAT_CAFE_API_URL: 'http://127.0.0.1:9',
        CAT_CAFE_INVOCATION_ID: 'offline-' + carrier,
        CAT_CAFE_CALLBACK_TOKEN: 'fixture-only',
        CAT_CAFE_THREAD_ID: 'fixture-thread',
        CAT_CAFE_CAT_ID: 'sonnet',
        CAT_CAFE_USER_ID: 'fixture-owner',
        CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'api_key',
        CAT_CAFE_ANTHROPIC_API_KEY: 'private-synthetic-key',
        CAT_CAFE_ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
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
      for await (const row of service.invoke('Reply F335-NATIVE-OK after checking the read-only tool set.', {
        ...options,
        ...extra,
      }))
        rows.push(row);
      const error = rows.find((row) => row.type === 'error');
      assert.equal(error, undefined, JSON.stringify(rows));
      assert.ok(
        rows.some((row) => row.content?.includes('F335-NATIVE-OK')),
        JSON.stringify(rows),
      );
      return rows.find((row) => row.type === 'session_init')?.sessionId;
    };
    const session = await run({});
    diagnostics.push({ carrier, init: raw.filter((event) => event.type === 'system' && event.subtype === 'init') });
    assert.match(
      JSON.stringify(requests.slice(beforeRequests)),
      /ACTUAL-FILE-PROOF/,
      'real MCP file reader must execute',
    );
    assert.ok(session);
    const resumed = await run({ sessionId: session });
    assert.equal(resumed, session);
    const init = raw.find((e) => e.type === 'system' && e.subtype === 'init');
    assert.ok(init, carrier + ' actual init');
    const names = init.tools ?? [],
      mcp = names.filter((name) => name.startsWith('mcp__')).sort(),
      expected = Object.entries(toolMap)
        .flatMap(([family, names]) => names.map((name) => 'mcp__' + family + '__' + name))
        .sort();
    assert.deepEqual(mcp, expected);
    for (const name of ['Bash', 'Edit', 'Write', 'Computer', 'Skill', 'WebFetch', 'WebSearch'])
      assert.ok(!names.includes(name), 'unexpected native ' + name);
    assert.deepEqual(
      init.mcp_servers.map((s) => ({ name: s.name, status: s.status })).sort((a, b) => a.name.localeCompare(b.name)),
      Object.keys(toolMap)
        .sort()
        .map((name) => ({ name, status: 'connected' })),
    );
    proofs.push({
      carrier,
      realModelRequests: 0,
      exactMcpToolCount: mcp.length,
      nativeTools: names.filter((name) => !name.startsWith('mcp__')),
      resumedSameSession: true,
      actualFileRead: true,
      servers: init.mcp_servers,
    });
  }
  await writeFile(
    join(root, '.cat-cafe/evidence/f335-watcher-providers/claude-installed-proof.json'),
    JSON.stringify({ proofs, localProviderRequests: requests.length }, null, 2),
  );
  console.log(JSON.stringify({ proofs, localProviderRequests: requests.length }));
} catch (error) {
  await writeFile(
    join(root, '.cat-cafe/evidence/f335-watcher-providers/claude-installed-failure.json'),
    JSON.stringify({ error: String(error), requests, diagnostics }, null, 2),
  );
  throw error;
} finally {
  clearTimeout(timer);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(workspace, { recursive: true, force: true });
}
