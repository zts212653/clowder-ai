// Manual installed-carrier qualification; local fake provider, zero real model/auth copies.
// Build the API first. Run this file with plain Node; --import tsx leaks into MCP children.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { prepareAgyNativeLaunch } from '../../dist/domains/cats/services/agents/providers/agy-native/agy-native-launch.js';
import { runAgyNativeInvocation } from '../../dist/domains/cats/services/agents/providers/agy-native/run/agy-native-invocation.js';
import { resolveCliCommand } from '../../dist/utils/cli-resolve.js';
import { spawnCli } from '../../dist/utils/cli-spawn.js';

const negative = process.argv.includes('--negative');
const scenario = negative ? 'negative' : 'positive';
const binary = process.env.AGY_MEMBER_WIRE_BINARY ?? resolveCliCommand('agy');
assert.ok(binary, 'Set AGY_MEMBER_WIRE_BINARY to an installed native carrier');
const binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
const output = process.env.AGY_MEMBER_WIRE_OUTPUT_DIR;
function persist(suffix, value) {
  if (!output) return;
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(output, `agy-member-wire-${scenario}-${suffix}.json`), JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
}
const scratch = mkdtempSync(join(tmpdir(), 'agy-member-wire-'));
const workspace = join(scratch, 'workspace'),
  homeRoot = join(scratch, 'profiles'),
  home = join(homeRoot, 'fixture');
const data = join(home, '.gemini/antigravity-cli');
mkdirSync(workspace);
mkdirSync(data, { recursive: true });
const nonce = randomUUID(),
  identity = `SCOPED-IDENTITY-${nonce}`,
  poison = `ENGINEERING-POISON-${nonce}`;
writeFileSync(join(workspace, 'AGENTS.md'), poison);
mkdirSync(join(workspace, '.agents/skills/poison'), { recursive: true });
writeFileSync(
  join(workspace, '.agents/skills/poison/SKILL.md'),
  `---\nname: poison\ndescription: ${poison}\n---\n${poison}`,
);
mkdirSync(join(home, '.gemini/config/skills/poison'), { recursive: true });
writeFileSync(
  join(home, '.gemini/config/skills/poison/SKILL.md'),
  `---\nname: poison\ndescription: ${poison}\n---\n${poison}`,
);
const baselinePath = join(data, 'settings.json');
const baseline = JSON.stringify({
  modelProvider: 'gemini',
  model: 'gemini-4-argon-high',
  trustedWorkspaces: ['/other-wall'],
});
writeFileSync(baselinePath, baseline);
const require = createRequire(new URL('../../../mcp-server/package.json', import.meta.url));
const sdk = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
const transport = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
const log = join(scratch, 'calls.jsonl'),
  mcp = join(scratch, 'mcp.mjs');
writeFileSync(
  mcp,
  `import {McpServer} from ${JSON.stringify(sdk)};\nimport {StdioServerTransport} from ${JSON.stringify(transport)};\nimport {appendFileSync} from 'node:fs';\nconst s=new McpServer({name:'fixture-member',version:'1'});\nfor(const name of ['observe','act'])s.registerTool(name,{description:'Synthetic own-game fixture',inputSchema:{}},async()=>{appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({name})+'\\n');return {content:[{type:'text',text:'OWN-GAME-'+name}]};});\nawait s.connect(new StdioServerTransport());\n`,
);
const requests = [],
  events = [],
  rawEvents = [];
let mainCount = 0;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (req.method === 'GET') {
    res.end(JSON.stringify({ models: [] }));
    return;
  }
  requests.push(body);
  let parts = [{ text: 'FIXTURE-DONE' }];
  if (body.tools) {
    mainCount++;
    if (mainCount <= 2)
      parts = [
        {
          functionCall: {
            name: 'call_mcp_tool',
            args: {
              ServerName: 'plugin__dev.clowder.fixture__member',
              ToolName: mainCount === 1 ? 'observe' : 'act',
              Arguments: {},
            },
          },
        },
      ];
    else if (negative && mainCount === 3) parts = [{ functionCall: { name: 'manage_task', args: { Action: 'list' } } }];
    else if (negative && mainCount === 4)
      parts = [
        {
          functionCall: {
            name: 'call_mcp_tool',
            args: { ServerName: 'cat-cafe-collab', ToolName: 'post_message', Arguments: {} },
          },
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
let plan;
try {
  const signal = AbortSignal.timeout(35000);
  const options = {
    workingDirectory: workspace,
    signal,
    executionAccount: {
      accountRef: 'fixture-only',
      displayName: 'Synthetic',
      authType: 'oauth',
      accountRevision: 'fixture',
    },
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'fixture',
      contributionId: 'member',
      memberSession: { sessionId: 'fixture', generation: 1, executionId: 'fixture' },
    },
    pluginNativeLaunch: {
      sandbox: { kind: 'scoped-member', workspaceRoot: workspace },
      assertCurrent: () => {},
      server: {
        name: 'plugin__dev.clowder.fixture__member',
        command: process.execPath,
        args: [mcp],
        workingDirectory: workspace,
        env: { FIXTURE_LOG: log },
        transport: 'stdio',
      },
    },
    // This existing synthetic transport seam avoids provisioning any native keychain.
    spawnCliOverride: async function* (launch) {
      for await (const event of spawnCli({
        ...launch,
        timeoutMs: 30000,
        env: {
          ...launch.env,
          GEMINI_API_KEY: 'fixture-not-a-real-key',
          GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          HTTPS_PROXY: 'http://127.0.0.1:9',
          HTTP_PROXY: 'http://127.0.0.1:9',
          ALL_PROXY: 'http://127.0.0.1:9',
          NO_PROXY: '127.0.0.1,localhost',
        },
      })) {
        rawEvents.push(event);
        yield event;
      }
    },
  };
  plan = await prepareAgyNativeLaunch({
    catId: 'gemini38',
    model: 'gemini-3.8-flash-high',
    command: binary,
    profileConfig: { enabled: true, profileId: 'fixture', homeRoot, autoApprove: true, model: 'gemini-3.8-flash-high' },
    workspace,
    prompt: 'Synthetic carrier check only: use your own observe then act tools.',
    body: `# Identity\n${identity}`,
    options,
  });
  for await (const event of runAgyNativeInvocation({
    catId: 'gemini38',
    model: 'gemini-3.8-flash-high',
    prompt: 'Synthetic fixture',
    launch: plan,
    metadata: { provider: 'google', model: 'gemini-3.8-flash-high' },
    rawArchive: { append: async () => {} },
    spawnCliFn: spawnCli,
    options,
    compactionRequested: false,
  }))
    events.push(event);
  const tools = [
    ...new Set(
      requests.flatMap((r) => r.tools?.flatMap((t) => t.functionDeclarations?.map((x) => x.name) ?? []) ?? []),
    ),
  ];
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((s) => JSON.parse(s))
    : [];
  const responses = requests.flatMap(
    (r) =>
      r.contents?.flatMap((m) => m.parts?.filter((p) => p.functionResponse).map((p) => p.functionResponse) ?? []) ?? [],
  );
  const proof = {
    scenario,
    responses,
    binarySha256,
    toolNames: tools,
    calls,
    sourceIdentityPresent: JSON.stringify(requests).includes(identity),
    engineeringPoisonAbsent: !JSON.stringify(requests).includes(poison),
    accountSettingsUnchanged: isDeepStrictEqual(JSON.parse(readFileSync(baselinePath, 'utf8')), JSON.parse(baseline)),
    accountSettingsBytesUnchanged: readFileSync(baselinePath, 'utf8') === baseline,
    accountSettingsBefore: JSON.parse(baseline),
    accountSettingsAfter: JSON.parse(readFileSync(baselinePath, 'utf8')),
    terminal: events.at(-1),
    requests: requests.length,
    realModelCalls: 0,
    authenticationCopies: 0,
  };
  persist('raw', rawEvents);
  persist('proof', proof);
  persist('requests', requests);
  process.stdout.write(`${JSON.stringify({ ...proof, responses: undefined })}\n`);
  assert.deepEqual(
    calls.map((x) => x.name),
    ['observe', 'act'],
  );
  assert.deepEqual(tools, ['call_mcp_tool', 'manage_task']);
  if (negative)
    assert.ok(
      responses.some(
        (r) =>
          r.name === 'manage_task' &&
          JSON.stringify(r).includes('member invocation permits only its issued MCP server'),
      ),
    );
  if (negative)
    assert.ok(
      responses.some(
        (r) =>
          r.name === 'call_mcp_tool' &&
          JSON.stringify(r).includes('member invocation permits only its issued MCP server'),
      ),
    );
  assert.equal(proof.engineeringPoisonAbsent, true);
  assert.equal(proof.accountSettingsUnchanged, true);
  assert.equal(proof.sourceIdentityPresent, true);
  assert.equal(events.at(-1)?.errorCode, negative ? 'AGY_UNEXPECTED_TOOL' : undefined);
} catch (error) {
  persist('partial-requests', requests);
  const partial = {
    error: error.message,
    toolNames: [
      ...new Set(
        requests.flatMap((r) => r.tools?.flatMap((t) => t.functionDeclarations?.map((x) => x.name) ?? []) ?? []),
      ),
    ],
    calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
    rawInit: rawEvents.filter((x) => x.event === 'init'),
    accountSettingsBefore: JSON.parse(baseline),
    accountSettingsAfter: JSON.parse(readFileSync(baselinePath, 'utf8')),
    modelRequests: requests.length,
    realModelCalls: 0,
  };
  persist('partial', partial);
  process.stdout.write(`${JSON.stringify(partial)}\n`);
  throw error;
} finally {
  await plan?.disposeCredentials?.();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(scratch, { recursive: true, force: true });
}
