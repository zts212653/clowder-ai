// Installed Native qualification; all accounts, tokens and model responses are synthetic/local.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'smol-toml';
import { readKimiNativeAccount } from '../../dist/config/native-accounts/kimi-account.js';
import { inspectKimiNativeLaunch } from '../../dist/config/native-accounts/kimi-installation.js';
import { providerProfileAccountSnapshot } from '../../dist/domains/cats/services/agents/invocation/execution-account-binding.js';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { invokeKimiMember } from '../../dist/domains/cats/services/agents/providers/acp/kimi/kimi-member-invocation.js';
import { createMemberResourceDescription } from '../../dist/domains/plugin/member-sessions/resources.js';
import { createMemberRuntime } from '../../dist/domains/plugin/member-sessions/runtime.js';

const negative = process.argv.includes('--negative'),
  rotate = process.argv.includes('--rotate-during-compile');
const revoke = process.argv.includes('--revoke-during-compile'),
  liveRotate = process.argv.includes('--rotate-during-provider');
const templateUnsafe = process.argv.includes('--identity-template');
const dynamic = process.argv.includes('--dynamic-tools');
const foreignHostHooks = process.argv.includes('--foreign-host-hooks');
const scenario = foreignHostHooks
  ? 'foreign-host-hooks'
  : templateUnsafe
    ? 'identity-template'
    : liveRotate
      ? 'live-rotate'
      : rotate
        ? 'rotate'
        : revoke
          ? 'revoke'
          : negative
            ? 'negative'
            : dynamic
              ? 'dynamic'
              : 'positive';
const root = await realpath(await mkdtemp(join(tmpdir(), 'kimi-member-wire-')));
const home = join(root, 'native-source'),
  workspace = join(root, 'host-workspace');
const previous = {
  KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
  CAT_CAFE_GLOBAL_CONFIG_ROOT: process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT,
};
process.env.KIMI_CODE_HOME = home;
process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
await mkdir(join(home, 'credentials'), { recursive: true });
await mkdir(join(root, '.cat-cafe'));
await mkdir(workspace);
const identity = 'OWN-IDENTITY-' + randomUUID(),
  poison = 'ENGINEERING-POISON-' + randomUUID();
await writeFile(join(workspace, 'AGENTS.md'), poison);
await writeFile(join(home, 'SYSTEM.md'), poison);
await writeFile(
  join(root, '.cat-cafe/accounts.json'),
  JSON.stringify({
    existing: {
      clientId: 'kimi',
      authType: 'oauth',
      envVars: { HOME: root, KIMI_CODE_HOME: home },
    },
  }),
);
const credential = join(home, 'credentials/kimi-code.json');
const token = JSON.stringify({
  access_token: 'EXAMPLE',
  refresh_token: 'PLACEHOLDER',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  expires_in: 3600,
  scope: 'fixture',
  token_type: 'Bearer',
});
await writeFile(credential, token, { mode: 0o600 });
const require = createRequire(new URL('../../../mcp-server/package.json', import.meta.url));
const sdk = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
const transport = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
const calls = join(root, 'calls.jsonl'),
  mcp = join(root, 'mcp.mjs'),
  foreign = join(root, 'foreign.mjs');
await writeFile(
  mcp,
  `import{McpServer}from ${JSON.stringify(sdk)};import{StdioServerTransport}from ${JSON.stringify(transport)};import{appendFileSync}from'node:fs';const s=new McpServer({name:'own-game',version:'1'});for(const name of['observe','act'])s.registerTool(name,{description:'Own allowed action',inputSchema:{}},async()=>{appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({name,cwd:process.cwd()})+'\\n');return{content:[{type:'text',text:'OWN-'+name}]}});await s.connect(new StdioServerTransport());`,
);
await writeFile(
  foreign,
  `import{McpServer}from ${JSON.stringify(sdk)};import{StdioServerTransport}from ${JSON.stringify(transport)};import{writeFileSync}from'node:fs';const s=new McpServer({name:'foreign',version:'1'});s.registerTool('post_message',{description:'Forbidden message',inputSchema:{}},async()=>{writeFileSync(${JSON.stringify(join(root, 'FORBIDDEN'))},'called');return{content:[{type:'text',text:'FORBIDDEN'}]}});await s.connect(new StdioServerTransport());`,
);
await writeFile(
  join(home, 'mcp.json'),
  JSON.stringify({ mcpServers: { foreign: { command: process.execPath, args: [foreign] } } }),
);
const requests = [],
  authMatches = [],
  configPath = join(home, 'config.toml');
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  authMatches.push(req.headers.authorization === 'Bearer EXAMPLE' || req.headers['x-api-key'] === 'EXAMPLE');
  if (liveRotate)
    await writeFile(configPath, (await readFile(configPath, 'utf8')) + '\n# source changed during provider\n');
  const n = requests.length,
    names = (body.tools ?? []).map((tool) => tool.name);
  const own = names.find((name) => name.endsWith(n === 1 ? '__observe' : '__act'));
  const tool =
    n <= 2
      ? own
      : negative && n === 3
        ? 'Shell'
        : negative && n === 4
          ? 'mcp__foreign__post_message'
          : negative && n === 5
            ? 'select_tools'
            : null;
  const block = tool
    ? {
        type: 'tool_use',
        id: 'fixture-' + n,
        name: tool,
        input:
          tool === 'Shell'
            ? { command: 'touch ' + join(root, 'FORBIDDEN') }
            : tool === 'select_tools'
              ? { tools: ['Shell'] }
              : {},
      }
    : { type: 'text', text: 'FIXTURE-DONE' };
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'fixture-' + n,
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
  res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const modelAlias = 'kimi-code/fixture',
  model = 'fixture-model';
await writeFile(
  configPath,
  stringify({
    default_model: modelAlias,
    providers: {
      fixture: {
        type: 'kimi',
        base_url: `http://127.0.0.1:${server.address().port}`,
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    },
    models: {
      [modelAlias]: {
        provider: 'fixture',
        model,
        protocol: 'anthropic',
        capabilities: dynamic ? ['tool_use', 'dynamically_loaded_tools'] : ['tool_use'],
        max_context_size: 8000,
        max_output_size: 128,
      },
    },
  }),
  { mode: 0o600 },
);
const pools = new Map();
let timer, memberFrame;
try {
  const command = process.env.KIMI_MEMBER_WIRE_BINARY ?? '/opt/homebrew/bin/kimi';
  const cat = { id: 'kimi31-pro', clientId: 'kimi', carrier: 'acp', defaultModel: modelAlias, accountRef: 'existing' };
  const service = await createAcpServiceForConfig({
    projectRoot: root,
    profileId: 'fixture-kimi',
    config: cat,
    effectiveModel: modelAlias,
    acpConfig: { command, startupArgs: ['acp'] },
    poolRegistry: pools,
    bootstrapRoot: join(root, 'bootstrap'),
    log: { info() {}, warn() {} },
  });
  assert.ok(service);
  const native = inspectKimiNativeLaunch({
    command,
    args: ['acp'],
    env: {},
    projectRoot: root,
    accountRef: 'existing',
  });
  assert.ok(native);
  if (foreignHostHooks) {
    const config = await readFile(configPath, 'utf8');
    const relocated = config.replaceAll(
      '/dist/runtime/scripts/secret-kimi-hook.mjs',
      '/another-host/dist/runtime/scripts/secret-kimi-hook.mjs',
    );
    assert.notEqual(relocated, config);
    await writeFile(configPath, relocated);
  }
  const account = await readKimiNativeAccount(native, modelAlias),
    snapshot = providerProfileAccountSnapshot('kimi', account.profile);
  const beforeConfig = await readFile(configPath, 'utf8');
  const scope = {
    pluginInstanceId: 'fixture',
    packageDigest: 'package',
    ownerUserId: 'owner',
    assertCurrent: async () => {},
  };
  const described = await createMemberResourceDescription({
    projectRoot: root,
    config: () => cat,
    service: () => service,
    memory: async () => [],
  })(cat.id, scope);
  assert.equal(described.available, true);
  assert.equal(described.runtime.carrier, 'acp');
  assert.equal(described.accounts[0].accountRevision, snapshot.accountRevision);
  memberFrame = await createMemberRuntime({
    config: () => cat,
    service: () => service,
    workspace: async () => ({ workingDirectory: workspace, workingProjectRoot: root, usesDefaultWorkspace: false }),
  }).acquire(
    { threadId: 'fixture-thread', catId: cat.id, contributionId: 'player', identity: 'own-game', memory: [] },
    scope,
  );
  const runtime = memberFrame.runtime;
  assert.equal(runtime.account.accountRevision, snapshot.accountRevision);
  assert.equal(runtime.carrier, 'acp');
  assert([...pools.values()].every((pool) => pool.getMetrics().coldStartCount === 0));
  const controller = new AbortController();
  let current = true,
    prepared = 0;
  timer = setTimeout(() => controller.abort(new Error('qualification_timeout')), 35000);
  const messages = [];
  for await (const message of invokeKimiMember({
    catId: cat.id,
    modelSelection: modelAlias,
    native,
    prompt: 'Use your own game tools.',
    compile: async (input) => {
      assert.equal(input.projection, 'scoped-member');
      assert.equal(input.runtimeModel, model);
      assert.equal(input.frozenInput, memberFrame.binding.frozenL0Input);
      assert.equal(input.requireFrozenInput, true);
      if (rotate) await writeFile(configPath, beforeConfig + '\n# source changed during compile\n');
      if (revoke) current = false;
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Native template syntax must be rejected, not interpolated here.
      return templateUnsafe ? '${base_prompt}\n' + identity : identity;
    },
    options: {
      workingDirectory: workspace,
      signal: controller.signal,
      executionAccount: snapshot,
      frozenL0Input: memberFrame.binding.frozenL0Input,
      accountEnv: account.accountEnv,
      toolExecutionPolicy: {
        mode: 'plugin_native',
        pluginInstanceId: 'fixture',
        contributionId: 'player',
        memberSession: { sessionId: 'member', generation: 1, executionId: 'event' },
      },
      pluginNativeLaunch: {
        sandbox: { kind: 'scoped-member', workspaceRoot: workspace },
        server: {
          name: 'plugin__cat-planet.six-cat-playground__playground-player',
          transport: 'stdio',
          command: process.execPath,
          args: [mcp],
          workingDirectory: workspace,
          env: { FIXTURE_LOG: calls },
        },
        assertCurrent: async () => {
          if (!current) throw new Error('fixture_member_revoked');
        },
      },
      beforeProviderLaunch: async (request) => {
        prepared++;
        assert.equal(request.nativeInstructions[0].body, identity);
      },
    },
  }))
    messages.push(message);
  if (process.env.KIMI_MEMBER_WIRE_OUTPUT_DIR) {
    await mkdir(process.env.KIMI_MEMBER_WIRE_OUTPUT_DIR, { recursive: true });
    await writeFile(
      join(process.env.KIMI_MEMBER_WIRE_OUTPUT_DIR, `kimi-member-wire-${scenario}-debug.json`),
      JSON.stringify({ requests, messages }, null, 2) + '\n',
    );
  }
  assert.equal(messages.at(-1)?.type, 'done');
  assert(authMatches.every(Boolean), 'Native must use its synthetic original OAuth token');
  const actions = await readFile(calls, 'utf8')
    .then((text) => text.trim().split('\n').map(JSON.parse))
    .catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  if (rotate || revoke || liveRotate || templateUnsafe) {
    assert.equal(requests.length, liveRotate ? 1 : 0);
    assert.equal(prepared, liveRotate ? 1 : 0);
    assert.equal(actions.length, 0);
    assert(messages.some((message) => message.type === 'error'));
  } else {
    assert.equal(prepared, 1);
    assert(!messages.some((message) => message.type === 'error'), JSON.stringify(messages));
    assert.deepEqual(
      actions.map((action) => action.name),
      ['observe', 'act'],
    );
    assert.equal(requests.length, negative ? 6 : 3);
    for (const request of requests) {
      assert(JSON.stringify(request).includes(identity));
      assert(!JSON.stringify(request).includes(poison));
      assert.equal(request.model, model);
      const names = request.tools.map((tool) => tool.name);
      assert.equal(names.length, 2);
      assert(names.every((name) => /^mcp__member_[a-f0-9]{16}__(?:observe|act)$/.test(name)));
    }
    assert(
      actions.every((action) => action.cwd === workspace),
      'issued MCP cwd must be preserved',
    );
    assert.equal(await readFile(configPath, 'utf8'), beforeConfig, 'Native defaults were not changed');
    if (negative) {
      const results = JSON.stringify(requests.at(-1).messages);
      assert.match(results, /Shell.*not found/);
      assert.match(results, /mcp__foreign__post_message.*(?:not found|disabled)/);
      assert.match(results, /select_tools.*disabled/);
    }
  }
  await assert.rejects(access(join(root, 'FORBIDDEN')));
  assert.equal(await readFile(credential, 'utf8'), token, 'the original Native token was not copied or rewritten');
  const proof = {
    claim: 'production-kimi-member-installed-wire',
    scenario,
    nativeHooksRelocated: foreignHostHooks,
    forbiddenToolAttempts: negative ? 3 : 0,
    realModelRequests: 0,
    localProviderRequests: requests.length,
    actions: actions.map((action) => action.name),
    prepared,
    terminalError: messages.find((message) => message.type === 'error')?.errorCode ?? null,
    originalOAuthSource: true,
    credentialCopies: 0,
    productionFactory: true,
    ownerResourceDescribe: true,
    hostRuntimeSnapshot: true,
    engineeringPoisonAbsent: !requests.some((request) => JSON.stringify(request).includes(poison)),
  };
  if (process.env.KIMI_MEMBER_WIRE_OUTPUT_DIR) {
    const output = process.env.KIMI_MEMBER_WIRE_OUTPUT_DIR;
    await mkdir(output, { recursive: true });
    await writeFile(join(output, `kimi-member-wire-${scenario}-proof.json`), JSON.stringify(proof, null, 2) + '\n');
    await writeFile(
      join(output, `kimi-member-wire-${scenario}-requests.json`),
      JSON.stringify(requests, null, 2) + '\n',
    );
  }
  process.stdout.write(JSON.stringify(proof) + '\n');
} finally {
  clearTimeout(timer);
  await memberFrame?.release();
  for (const pool of pools.values()) await pool.closeAll();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
}
