// Installed-carrier qualification. Run with plain Node after API build.
// All credentials, accounts and provider responses below are synthetic/private.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDshNativeAccount } from '../../dist/config/native-accounts/dsh-account.js';
import { inspectDshNativeLaunch } from '../../dist/config/native-accounts/dsh-installation.js';
import { providerProfileAccountSnapshot } from '../../dist/domains/cats/services/agents/invocation/execution-account-binding.js';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { invokeDshMember } from '../../dist/domains/cats/services/agents/providers/acp/dsh/dsh-member-invocation.js';
import { dshMemberServerName } from '../../dist/domains/cats/services/agents/providers/acp/dsh/dsh-member-launch.js';
import { createMemberResourceDescription } from '../../dist/domains/plugin/member-sessions/resources.js';
import { createMemberRuntime } from '../../dist/domains/plugin/member-sessions/runtime.js';

const negative = process.argv.includes('--negative'),
  rotate = process.argv.includes('--rotate-during-compile');
const revoke = process.argv.includes('--revoke-during-compile');
const scenario = rotate ? 'rotate' : revoke ? 'revoke' : negative ? 'negative' : 'positive';
const scratch = await mkdtemp(join(tmpdir(), 'dsh-member-wire-'));
const home = join(scratch, 'native-source'),
  workspace = join(scratch, 'workspace'),
  profile = join(home, 'profiles/acp');
const previousNativeHome = process.env.DSH_HOME;
process.env.DSH_HOME = home; // This qualification runs in its own disposable Node process.
await mkdir(profile, { recursive: true });
await mkdir(workspace);
const identity = 'OWN-IDENTITY-' + randomUUID(),
  poison = 'ENGINEERING-POISON-' + randomUUID();
await writeFile(join(workspace, 'AGENTS.md'), poison);
await mkdir(join(workspace, '.agents/skills/poison'), { recursive: true });
await writeFile(
  join(workspace, '.agents/skills/poison/SKILL.md'),
  `---\nname: poison\ndescription: ${poison}\n---\n${poison}`,
);
await writeFile(
  join(profile, 'package.json'),
  JSON.stringify({
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } },
  }),
);
const credential = join(home, '.credentials.yaml');
const originalCredential = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: private-synthetic-key\n';
await writeFile(credential, originalCredential, { mode: 0o600 });
const require = createRequire(new URL('../../../mcp-server/package.json', import.meta.url));
const sdk = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
const transport = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
const log = join(scratch, 'calls.jsonl'),
  mcp = join(scratch, 'mcp.mjs');
await writeFile(
  mcp,
  `import {McpServer} from ${JSON.stringify(sdk)};\nimport {StdioServerTransport} from ${JSON.stringify(transport)};\nimport {appendFileSync} from 'node:fs';\nconst s=new McpServer({name:'own-game-fixture',version:'1'});\nfor(const name of ['observe','act'])s.registerTool(name,{description:'Synthetic own game action',inputSchema:{}},async()=>{appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({name,cwd:process.cwd()})+'\\n');return {content:[{type:'text',text:'OWN-'+name}]};});\nawait s.connect(new StdioServerTransport());\n`,
);
const name = 'plugin__cat-planet.six-cat-playground__playground-player';
const prefix = `mcp__${dshMemberServerName(name)}__`,
  requests = [];
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const index = requests.length;
  const tool =
    index <= 2
      ? prefix + (index === 1 ? 'observe' : 'act')
      : negative && index === 3
        ? 'bash'
        : negative && index === 4
          ? 'mcp__cat_cafe_collab__post_message'
          : null;
  const block = tool
    ? {
        type: 'tool_use',
        id: 'fixture-' + index,
        name: tool,
        input: tool === 'bash' ? { command: 'touch ' + join(scratch, 'FORBIDDEN') } : {},
      }
    : { type: 'text', text: 'FIXTURE-DONE' };
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'fixture-' + index,
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
let timer, memberFrame;
const pools = new Map();
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
    command: process.env.DSH_MEMBER_WIRE_BINARY ?? 'dsh',
    args: ['--profile', 'acp'],
    env: { DSH_HOME: home },
    projectRoot: scratch,
  });
  assert.ok(native, 'An installed qualified DSH is required; no install is attempted');
  const model = '["deepseek-official","deepseek-flash"]';
  const account = await readDshNativeAccount(native, model, workspace);
  const snapshot = providerProfileAccountSnapshot('acp', account.profile);
  const cat = {
    id: 'deepseek-flash',
    name: 'Native fixture',
    displayName: 'Native fixture',
    color: { primary: '#000000', secondary: '#ffffff' },
    avatar: '/avatars/default.png',
    mentionPatterns: ['@deepseek-flash'],
    roleDescription: 'Synthetic qualification only',
    configurationSource: 'native_tool',
    clientId: 'acp',
    defaultModel: model,
    mcpSupport: true,
  };
  const service = await createAcpServiceForConfig({
    projectRoot: workspace,
    bootstrapRoot: join(scratch, 'bootstrap'),
    profileId: cat.id,
    effectiveModel: model,
    config: cat,
    acpConfig: { command: native.command, startupArgs: [...native.args] },
    poolRegistry: pools,
    log: { info() {}, warn() {} },
  });
  assert.ok(service, 'the actual ACP service factory must produce a carrier');
  const scope = {
    pluginInstanceId: 'fixture',
    packageDigest: 'package',
    ownerUserId: 'owner',
    assertCurrent: async () => {},
  };
  const resources = createMemberResourceDescription({
    projectRoot: workspace,
    config: () => cat,
    service: () => service,
    memory: async () => [],
  });
  const described = await resources(cat.id, scope);
  assert.equal(described.available, true);
  assert.equal(described.runtime.carrier, 'acp');
  assert.equal(described.defaultAccountRef, snapshot.accountRef);
  assert.deepEqual(described.accounts[0].selection, {
    accountRef: snapshot.accountRef,
    authType: 'api_key',
    expectedRevision: snapshot.accountRevision,
  });
  assert.ok(!JSON.stringify(described).includes(account.profile.apiKey));
  const runtime = createMemberRuntime({
    config: () => cat,
    service: () => service,
    workspace: async () => ({
      workingDirectory: workspace,
      workingProjectRoot: workspace,
      usesDefaultWorkspace: false,
    }),
  });
  memberFrame = await runtime.acquire(
    { threadId: 'fixture-thread', catId: cat.id, contributionId: 'player', identity: 'own-game', memory: [] },
    scope,
  );
  const actual = memberFrame.runtime;
  assert.deepEqual(actual.account, {
    accountRef: snapshot.accountRef,
    authType: snapshot.authType,
    accountRevision: snapshot.accountRevision,
  });
  assert.equal(actual.carrier, 'acp');
  assert.ok(!JSON.stringify(actual).includes(account.profile.apiKey));
  assert.ok(
    [...pools.values()].every((pool) => pool.getMetrics().coldStartCount === 0),
    'discovery must not spawn an ordinary ACP carrier',
  );
  const controller = new AbortController();
  let current = true,
    prepared = 0;
  timer = setTimeout(() => controller.abort(new Error('qualification_timeout')), 25000);
  const messages = [];
  for await (const message of invokeDshMember({
    catId: 'deepseek-flash',
    modelSelection: model,
    native,
    prompt: 'Use your own game tools.',
    compile: async (input) => {
      assert.equal(input.projection, 'scoped-member');
      assert.equal(input.runtimeModel, 'deepseek-flash');
      assert.equal(input.frozenInput, memberFrame.binding.frozenL0Input);
      assert.equal(input.requireFrozenInput, true);
      if (rotate)
        await writeFile(credential, originalCredential.replace('private-synthetic-key', 'rotated-synthetic-key'), {
          mode: 0o600,
        });
      if (revoke) current = false;
      return identity;
    },
    options: {
      workingDirectory: workspace,
      signal: controller.signal,
      executionAccount: snapshot,
      frozenL0Input: memberFrame.binding.frozenL0Input,
      toolExecutionPolicy: {
        mode: 'plugin_native',
        pluginInstanceId: 'fixture',
        contributionId: 'player',
        memberSession: { sessionId: 'member', generation: 1, executionId: 'event' },
      },
      pluginNativeLaunch: {
        sandbox: { kind: 'scoped-member', workspaceRoot: workspace },
        server: {
          name,
          transport: 'stdio',
          command: process.execPath,
          args: [mcp],
          workingDirectory: workspace,
          env: { FIXTURE_LOG: log },
        },
        assertCurrent: async () => {
          if (!current) throw new Error('fixture_member_revoked');
        },
      },
      beforeProviderLaunch: async (input) => {
        prepared++;
        assert.equal(input.nativeInstructions[0].body, identity);
        assert.equal(input.runtime.carrier, 'acp');
      },
    },
  }))
    messages.push(message);
  assert.equal(messages.at(-1)?.type, 'done');
  let actions = [];
  if (rotate || revoke) {
    assert.equal(requests.length, 0);
    assert.equal(prepared, 0);
    assert.ok(messages.some((message) => message.type === 'error'));
  } else {
    assert.equal(prepared, 1);
    assert.ok(!messages.some((message) => message.type === 'error'), JSON.stringify(messages));
    assert.equal(requests.length, negative ? 5 : 3);
    for (const request of requests) {
      assert.ok(JSON.stringify(request).includes(identity));
      assert.ok(!JSON.stringify(request).includes(poison));
      assert.deepEqual(request.tools.map((tool) => tool.name).sort(), [prefix + 'act', prefix + 'observe'].sort());
      assert.equal(request.model, 'deepseek-flash');
    }
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    actions = calls.map((call) => call.name);
    assert.deepEqual(actions, ['observe', 'act']);
    const expectedCwd = await realpath(workspace);
    for (const call of calls)
      assert.equal(await realpath(call.cwd), expectedCwd, 'the issued MCP cwd must be preserved');
    if (negative) {
      const results = requests
        .flatMap((request) => request.messages ?? [])
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((block) => block.type === 'tool_result');
      for (const id of ['fixture-3', 'fixture-4'])
        assert.ok(
          results.some((result) => result.tool_use_id === id && result.is_error === true),
          'forbidden native and foreign MCP calls must return actual error results',
        );
    }
    assert.equal(
      await readFile(credential, 'utf8'),
      originalCredential,
      'the native credential source stays untouched',
    );
  }
  await assert.rejects(access(join(scratch, 'FORBIDDEN')), (error) => error.code === 'ENOENT');
  const proof = {
    claim: 'production-dsh-member-installed-wire',
    scenario,
    realModelRequests: 0,
    localProviderRequests: requests.length,
    actions,
    accountOwner: 'native-file',
    credentialCopies: 0,
    onlyOwnMcpTools: true,
    identityPresent: !rotate && !revoke,
    engineeringContextAbsent: true,
    prepared,
    terminalError: messages.at(-1)?.errorCode ?? null,
    productionFactory: true,
    ownerResourceDescribe: true,
    hostRuntimeSnapshot: true,
  };
  const output = process.env.DSH_MEMBER_WIRE_OUTPUT_DIR;
  if (output) {
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(join(output, `dsh-member-wire-${scenario}-proof.json`), JSON.stringify(proof, null, 2) + '\n', {
      mode: 0o600,
    });
    await writeFile(
      join(output, `dsh-member-wire-${scenario}-requests.json`),
      JSON.stringify(requests, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
  console.log(JSON.stringify(proof));
} finally {
  clearTimeout(timer);
  await memberFrame?.release();
  if (previousNativeHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousNativeHome;
  await Promise.all([...pools.values()].map((pool) => pool.closeAll()));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
