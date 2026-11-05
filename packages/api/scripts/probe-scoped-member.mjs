import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { parseRawCatConfig, toAllCatConfigs } from '../dist/config/cat-config-loader.js';
import { freezeExecutionAccountBinding } from '../dist/domains/cats/services/agents/invocation/execution-account-binding.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { EventAuditLog } from '../dist/domains/cats/services/orchestration/EventAuditLog.js';
import { CliRawArchive } from '../dist/domains/cats/services/session/CliRawArchive.js';
import { currentPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';
import { pluginNativeActionRoutes } from '../dist/routes/plugin-native-action-routes.js';

// Engineering probe: real member/model/account and real game tools, isolated
// fixture terrain. Not a six-seat, Hub, frozen-Xicun or complete-product verdict.
const [worldSource, consumerSource, outputArg] = process.argv.slice(2);
if (!worldSource || !consumerSource || !outputArg)
  throw new Error('Expected world source, consumer source and output directory');
const output = resolve(outputArg);
mkdirSync(output, { recursive: true, mode: 0o700 });
const workspace = join(output, 'player-workspace');
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const worldRoot = join(output, 'world');
mkdirSync(worldRoot, { recursive: true, mode: 0o700 });
const imported = async (root, path) => import(pathToFileURL(join(root, path)).href);
const { createWorldServer } = await imported(worldSource, 'server/http.mjs');
const { PlaygroundClient } = await imported(consumerSource, 'brain/playground/client.mjs');
const { PlaygroundMemberSession } = await imported(consumerSource, 'brain/playground/session.mjs');
const { createPlayerToolSurface } = await imported(consumerSource, 'brain/playground/tools.mjs');
const catId = createCatId('codex61-sol'),
  userId = process.env.CAT_CAFE_USER_ID ?? 'default-user';
const catalogPath = join(process.env.CAT_CAFE_RUNTIME_ROOT, '.cat-cafe/cat-catalog.json');
const config = toAllCatConfigs(parseRawCatConfig(readFileSync(catalogPath, 'utf8')))[catId];
assert.ok(config?.defaultModel, 'actual configured member/model required');
catRegistry.register(catId, config);
process.env.CAT_TEMPLATE_PATH = catalogPath;
process.env.CAT_CAFE_CONFIG_ROOT = process.env.CAT_CAFE_WORKSPACE_ROOT;
const execution = freezeExecutionAccountBinding({
  catId,
  catConfig: config,
  workspace: {
    usesDefaultWorkspace: false,
    workingDirectory: workspace,
    workingProjectRoot: process.env.CAT_CAFE_WORKSPACE_ROOT,
  },
});
const instanceId = `native-probe-${Date.now()}`,
  binding = { instanceId, threadId: `probe_${randomUUID()}`, catId, generation: 1 };
const policy = { mode: 'plugin_native', pluginInstanceId: 'playground-probe', contributionId: 'member-tools' };
const report = {
  schema: 'f329.scoped-member-probe.v1',
  scope: 'one real Sol, fixture terrain, two bounded native invocations; not full B',
  startedAt: new Date().toISOString(),
  binding,
  model: config.defaultModel,
  carrier: 'codex_exec_json',
  account: execution.executionAccount,
  calls: [],
  checks: [],
  complete: false,
};
const notes = readFileSync(join(process.env.CAT_CAFE_WORKSPACE_ROOT, 'docs/stories/cat-names/README.md'), 'utf8');
const nameStory = notes.slice(notes.indexOf('## 砚砚'), notes.indexOf('## 烁烁'));
const memory = [
  {
    sourceRef: 'file:docs/stories/cat-names/README.md#砚砚',
    revision: createHash('sha256').update(nameStory).digest('hex'),
    text: nameStory,
  },
];
writeFileSync(
  join(worldRoot, 'world.json'),
  JSON.stringify({
    schema: 'world.v1',
    revision: 'bounded-native-probe-scene',
    spawn: { x: 0, y: 0, z: 0 },
    bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
    slots: [],
    obstacles: [],
    doors: [],
    train: {
      id: 'train',
      speed: 1,
      stopsForSeconds: 2,
      points: [
        { x: 20, y: 0, z: 0 },
        { x: 20, y: 0, z: 20 },
      ],
      station: { x: 20, y: 0, z: 0 },
    },
  }),
);
writeFileSync(join(worldRoot, 'index.html'), '<p>Isolated integration probe</p>');
const admission = {
  instance: {
    pluginInstanceId: policy.pluginInstanceId,
    packageDigest: 'isolated-probe',
    activationState: 'enabled',
    lifecycleState: 'installed',
    configReadiness: 'ready',
  },
  packageRecord: { manifest: { contributions: [{ type: 'mcp', id: policy.contributionId }] } },
};
const registry = new InvocationRegistry();
registry.markStartupRecoveryComplete();
const actions = new NativePluginActions(async () => admission);
let currentInput = null,
  currentInvocation = null,
  world,
  session;
const api = Fastify({ logger: false });
actions.activate(admission, 0, async (method, input) => {
  const caller = currentPluginCallContext(policy.pluginInstanceId);
  assert.ok(
    currentInput &&
      caller?.invocationId === currentInvocation &&
      caller.catId === binding.catId &&
      caller.threadId === binding.threadId,
    'exact live member callback required',
  );
  assert.equal(method, 'playground.mcp');
  if (input.operation === 'list') return currentInput.surface.list();
  assert.equal(input.operation, 'call');
  try {
    return await currentInput.surface.call(input.name, input.arguments);
  } catch (error) {
    return { ok: false, error: /^[a-z_]{1,100}$/i.test(error.message) ? error.message : 'member_tool_failed' };
  }
});
await api.register(pluginNativeActionRoutes, {
  actions,
  registry,
  sources: { messageStore: { getById: async () => null } },
  threadStore: { get: async (id) => (id === binding.threadId ? { id, createdBy: userId } : null) },
});
await api.listen({ host: '127.0.0.1', port: 0 });
const address = api.server.address();
const apiUrl = `http://127.0.0.1:${address.port}`;
const service = new CodexAgentService({
  catId,
  model: config.defaultModel,
  carrierMode: 'exec_json',
  rawArchive: new CliRawArchive({ archiveDir: join(output, 'raw') }),
  auditLog: new EventAuditLog({ auditDir: join(output, 'audit') }),
});
const server = {
  name: 'playground_member',
  transport: 'stdio',
  command: process.execPath,
  args: [join(consumerSource, 'brain/playground/mcp-entry.mjs')],
  workingDirectory: consumerSource,
  env: { ...actions.environment(policy.pluginInstanceId, policy.contributionId) },
};
const host = {
  async invoke(input) {
    assert.ok(report.calls.length < 2, 'probe call budget exhausted');
    const auth = await registry.create(userId, catId, binding.threadId, undefined, undefined, policy);
    currentInvocation = auth.invocationId;
    let observation = input.observation;
    const tools = {
      ...input.tools,
      observe: async () => {
        observation = await input.tools.observe();
        return observation;
      },
    };
    currentInput = { surface: createPlayerToolSurface({ tools, observation: () => observation }) };
    const account = execution.resolvedAccount;
    const callbackEnv = {
      CAT_CAFE_API_URL: apiUrl,
      CAT_CAFE_CAT_ID: catId,
      CAT_CAFE_USER_ID: userId,
      CAT_CAFE_THREAD_ID: binding.threadId,
      CAT_CAFE_INVOCATION_ID: auth.invocationId,
      CAT_CAFE_CALLBACK_TOKEN: auth.callbackToken,
      CODEX_AUTH_MODE: execution.codexAccountLaunch?.authMode ?? 'oauth',
    };
    const accountEnv = {
      ...account?.envVars,
      ...(account?.authType === 'api_key'
        ? { OPENAI_API_KEY: account.apiKey, ...(account.baseUrl ? { OPENAI_BASE_URL: account.baseUrl } : {}) }
        : {}),
    };
    const call = { invocationId: auth.invocationId, startedAt: new Date().toISOString(), events: [], metadata: [] };
    report.calls.push(call);
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120000)]);
    let failed = false,
      done = false;
    try {
      for await (const event of service.invoke(
        [
          '这是明确标注的受限接入联调，地面和物件是隔离夹具，不是正式游玩场。你是本猫，不是在表演角色。',
          '先通过工具读本人获准记忆和当前观察。按自己的选择做一项当前允许、能留下可观察后果的动作，并写一条愿意下次续接的日记。',
          '第二次调用时从真实保存的记忆和经历续接；不要把夹具中的联调刺激当另一只真实LLM猫。最终回复只说实际结果。',
          JSON.stringify({ binding: input.binding, observation: input.observation, memory: input.memory }),
        ].join('\n\n'),
        {
          workingDirectory: workspace,
          signal,
          callbackEnv,
          accountEnv,
          codexAccountLaunch: execution.codexAccountLaunch,
          executionAccount: execution.executionAccount,
          invocationId: auth.invocationId,
          toolExecutionPolicy: policy,
          pluginNativeLaunch: {
            server,
            sandbox: { kind: 'scoped-member', workspaceRoot: workspace },
            assertCurrent: async () => {
              assert.equal(currentInvocation, auth.invocationId);
              assert.ok((await registry.verifyLatest(auth.invocationId, auth.callbackToken)).ok);
              signal.throwIfAborted();
            },
          },
          beforeProviderLaunch: async (request) =>
            writeFileSync(join(output, `${auth.invocationId}-prepared.json`), JSON.stringify(request, null, 2), {
              mode: 0o600,
            }),
        },
      )) {
        const saved = {
          type: event.type,
          content: event.content,
          toolName: event.toolName,
          toolInput: event.toolInput,
          error: event.type === 'error' ? event.error : undefined,
        };
        appendFileSync(
          join(output, 'native-events.ndjson'),
          JSON.stringify({ invocationId: auth.invocationId, ...saved }) + '\n',
          { mode: 0o600 },
        );
        call.events.push(saved);
        if (event.metadata)
          call.metadata.push({
            provider: event.metadata.provider,
            model: event.metadata.model,
            usage: event.metadata.usage,
            servedModel: event.metadata.servedModel,
          });
        if (event.type === 'error') failed = true;
        if (event.type === 'done') done = true;
      }
      assert.ok(done && !failed, 'native member execution failed; inspect bounded native-events and raw archive');
      return {
        status: 'completed',
        execution: { model: config.defaultModel, carrier: 'codex_exec_json', account: execution.executionAccount },
      };
    } finally {
      currentInput = null;
      currentInvocation = null;
      await registry.commitTerminal({
        invocationId: auth.invocationId,
        disposition: failed ? 'failed' : 'completed',
        endedAt: Date.now(),
        endReason: 'probe_finished',
      });
      call.endedAt = new Date().toISOString();
    }
  },
};

try {
  world = await createWorldServer({
    root: worldRoot,
    webRoot: worldRoot,
    port: 0,
    host: '127.0.0.1',
    playground: {
      instanceId,
      collisionMeshes: [
        { id: 'floor', vertices: [-30, 0, -30, 30, 0, -30, 30, 0, 30, -30, 0, 30], indices: [0, 2, 1, 0, 3, 2] },
      ],
      items: [{ id: 'crate', shape: 'box', size: { x: 1, y: 1, z: 1 }, mass: 4, position: { x: 1.5, y: 0.6, z: 0 } }],
      terminals: [],
    },
  });
  const worldBase = `http://127.0.0.1:${world.port}`;
  const response = await fetch(worldBase + '/api/playground/bindings', {
    method: 'POST',
    headers: { authorization: `Bearer ${world.operatorToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...binding, name: config.nickname ?? config.displayName }),
  });
  assert.equal(response.status, 200);
  const credentials = await response.json();
  const client = new PlaygroundClient({ base: worldBase, token: credentials.token, binding });
  for (const path of ['/api/world', '/api/events', '/api/playground/admissions'])
    assert.equal(
      (await fetch(worldBase + path, { headers: { authorization: `Bearer ${credentials.token}` } })).status,
      403,
    );
  report.checks.push('player cannot request global snapshot, SSE or operator admissions');
  const open = () => new PlaygroundMemberSession({ directory: join(output, 'member'), client, host, memory });
  session = open();
  await session.poll();
  console.log(JSON.stringify({ stage: 'first-native-call', model: report.model }));
  await session.run();
  session.close();
  const before = JSON.parse(readFileSync(join(output, 'member/member.json'), 'utf8'));
  assert.ok(
    before.diary.length > 0 && before.outbox.some((entry) => entry.receipt?.ok),
    'the model must actually use diary and world actions',
  );
  const stimulus = world.world.agent({ id: 'probe-stimulus-controller', name: '非LLM联调刺激' });
  world.world.action(stimulus.token, { commandId: 'resume-stimulus', type: 'say', text: '这是恢复后的局部联调刺激。' });
  session = open();
  await session.poll();
  console.log(JSON.stringify({ stage: 'second-native-call', model: report.model }));
  await session.run();
  const after = JSON.parse(readFileSync(join(output, 'member/member.json'), 'utf8'));
  assert.equal(after.binding.catId, binding.catId);
  assert.ok(after.consumedCursor > before.consumedCursor);
  assert.ok(after.diary.some((entry) => entry.id === before.diary[0].id));
  assert.ok(!JSON.stringify(report.calls).includes(credentials.token));
  report.checks.push(
    'same real cat and model executed two native tool-enabled invocations',
    'approved family source, member diary and accepted world commands survive close/reopen',
    'new local semantic event reaches the resumed member without replacing identity',
  );
  report.complete = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  session?.close();
  actions.deactivateAll();
  await api.close();
  if (world) await world.close();
  report.endedAt = new Date().toISOString();
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      complete: report.complete,
      error: report.error,
      checks: report.checks,
      report: join(output, 'report.json'),
    }),
  );
}
