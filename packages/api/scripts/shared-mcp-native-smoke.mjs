/** F333 real carriers through invokeSingleCat and the production member route. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { inspectOwnedProcessCredentials } from '../../../scripts/mcp-process-census.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const options = Object.fromEntries(process.argv.slice(2).map((argument) => argument.replace(/^--/, '').split('=')));
assert.ok(options['config-root'] && options.members && options.output);
const configRoot = resolve(options['config-root']);
const modes = options.modes ? options.modes.split(',') : [options.transport ?? 'shared', options.transport ?? 'shared'];
assert.ok(modes.length >= 2 && modes.length <= 4 && modes.every((mode) => ['shared', 'stdio'].includes(mode)));
assert.ok(configRoot.startsWith(`${join(repo, '.cat-cafe/tmp')}/`), 'use an owned non-secret config snapshot');
mkdirSync(join(repo, '.cat-cafe/tmp'), { recursive: true });
const root = mkdtempSync(join(repo, '.cat-cafe/tmp/f333-native-'));
const credentialsRoot = mkdtempSync(join(tmpdir(), 'f333-native-credentials-'));
// This fixture is an API Host, not the Codex invocation that launched it.
// Each provider resolves its configured account through the existing owner.
for (const key of Object.keys(process.env)) {
  if (key === 'CODEX_HOME' || key === 'CODEX_SQLITE_HOME' || key === 'CODEX_AUTH_MODE' || key.startsWith('CODEX_CAT_'))
    delete process.env[key];
}
for (const key of [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_CREDENTIAL_FILE',
  'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
  'CAT_CAFE_NATIVE_CONNECTION_ID',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_EXECUTION_ID',
  'CAT_CAFE_CAT_ID',
  'CAT_CAFE_THREAD_ID',
  'CAT_CAFE_USER_ID',
])
  delete process.env[key];
process.env.CAT_CAFE_CONFIG_ROOT = configRoot;
if (options['account-root']) process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = resolve(options['account-root']);
process.env.CAT_TEMPLATE_PATH = join(configRoot, 'cat-template.json');
process.env.CAT_CAFE_RUNTIME_ROOT = repo;
process.env.CAT_CAFE_MCP_SERVER_PATH = join(repo, 'packages/mcp-server/dist/index.js');
process.env.CAT_CAFE_WORKSPACE_ROOT = repo;
process.env.CAT_CAFE_MCP_CREDS_DIR = credentialsRoot;
assert.ok(!options.transport || ['shared', 'stdio'].includes(options.transport));
process.env.CAT_CAFE_MCP_TRANSPORT = options.transport ?? 'shared';
process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
process.env.AUDIT_LOG_DIR = join(root, 'audit');
process.env.CAT_CAFE_CALLBACK_OUTBOX_DIR = join(root, 'outbox');
process.env.REDIS_URL = 'redis://127.0.0.1:6398';

const { loadCatConfig, toAllCatConfigs, getAcpConfig } = await import('../dist/config/cat-config-loader.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
const { resolveInvocationCapacitySnapshot } = await import(
  '../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js'
);
const { SessionManager } = await import('../dist/domains/cats/services/session/SessionManager.js');
const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
const { RuntimeSessionStore } = await import('../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js');
const { ContextEpochOwner } = await import('../dist/domains/cats/services/session/context/ContextEpochOwner.js');
const { InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js');
const { registerMemberMcpRoutes } = await import('../dist/routes/member-mcp.js');
const { resolveConfiguredMemberMcpFamilies } = await import('../dist/config/capabilities/member-mcp-families.js');
const { ClaudeSdkAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/ClaudeSdkAgentService.js'
);
const { ClaudeAgentService } = await import('../dist/domains/cats/services/agents/providers/ClaudeAgentService.js');
const { CodexAgentService } = await import('../dist/domains/cats/services/agents/providers/CodexAgentService.js');
const { CodexAppServerHostPool } = await import(
  '../dist/domains/cats/services/agents/providers/CodexAppServerHostPool.js'
);
const { AgyNativeAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);
const { OpenCodeAgentService } = await import('../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js');
const { createAcpServiceForConfig } = await import(
  '../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
);
const configs = toAllCatConfigs(loadCatConfig());
for (const [id, config] of Object.entries(configs)) catRegistry.register(id, config);
const registry = new InvocationRegistry();
const secrets = new Set();
const admitted = new Map();
const create = registry.create.bind(registry);
registry.create = async (...args) => {
  const value = await create(...args);
  secrets.add(value.callbackToken);
  admitted.set(`${args[1]}:${args[2]}`, value.invocationId);
  return value;
};
let archivedEnvelopes = 0;
let archiveLeak = false;
const archive = {
  append: async (_id, value) => {
    archivedEnvelopes++;
    const text = JSON.stringify(value);
    archiveLeak ||= [...secrets].some((secret) => text.includes(secret));
  },
};
const l0CompilerFn = async ({ outPath } = {}) => {
  const content =
    'You are an isolated MCP integration probe. Follow only the fixture prompt. Use the specified MCP read tool. Do not edit files, run commands, send messages, or call other tools.';
  if (outPath) writeFileSync(outPath, content, { mode: 0o600 });
  return content;
};
const sessionManager = new SessionManager();
const sessionChainStore = new SessionChainStore();
const runtimeSessionStore = new RuntimeSessionStore();
const counts = new Map();
const app = Fastify({ logger: false });
app.addHook('preHandler', async (request) => {
  if (request.url.startsWith('/api/member-mcp/mcp')) {
    const id = request.headers['x-invocation-id'];
    const count = counts.get(id) ?? { initialize: 0, list: 0, call: 0, shared: true };
    count.shared &&= new URL(request.url, 'http://localhost').searchParams.get('shared') === '1';
    if (request.body?.method === 'initialize') count.initialize++;
    if (request.body?.method === 'tools/list') count.list++;
    if (request.body?.method === 'tools/call' && request.body.params?.name === 'cat_cafe_read_file_slice') count.call++;
    counts.set(id, count);
  }
});
app.get('/api/config', () => ({ config: { coCreator: { name: 'Fixture', mentionPatterns: ['@fixture'] } } }));
let apiUrl;
registerMemberMcpRoutes(app, {
  registry,
  resolveMemberToolFamilies: ({ catId, sharedContext }) =>
    resolveConfiguredMemberMcpFamilies(
      sharedContext?.capabilityRoot ?? configRoot,
      catId,
      sharedContext?.workspaceRoot,
    ),
  get apiBaseUrl() {
    return apiUrl;
  },
  log: { warn() {} },
});
apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
const poolRegistry = new Map();
const codexPool = new CodexAppServerHostPool({ idleTtlMs: 1000, maxWarmHosts: 1 });
const report = {
  v: 1,
  capturedAt: new Date().toISOString(),
  configRoot,
  checkout: repo,
  transport: process.env.CAT_CAFE_MCP_TRANSPORT,
  modes,
  fixtureEffort: 'low (fixture thread only; no stored member configuration changed)',
  resourceMetric:
    'peak sampled sum RSS KiB: API fixture Host and its complete native descendant tree, including every proxy/backend; shared pages may be counted more than once',
  loadedEntries: Object.fromEntries(
    [
      'packages/api/dist/domains/cats/services/agents/invocation/invoke-single-cat.js',
      'packages/api/dist/routes/member-mcp.js',
      'packages/mcp-server/dist/member-gateway.js',
      'packages/mcp-server/dist/managed-mcp-config.js',
      'packages/mcp-server/dist/tools/invocation-auth.js',
    ].map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(join(repo, path)))
        .digest('hex'),
    ]),
  ),
  journey:
    'real provider -> invokeSingleCat -> native HTTP/explicit stdio -> production member route/backend -> fixture file',
  results: [],
};
const families = ['collab', 'memory', 'signals', 'limb', 'audio', 'finance'];
const capabilities = {
  version: 1,
  capabilities: families.map((family) => ({
    id: `cat-cafe-${family}`,
    type: 'mcp',
    enabled: true,
    source: 'cat-cafe',
    mcpServer: { command: process.execPath, args: [join(repo, `packages/mcp-server/dist/${family}.js`)] },
  })),
};
mkdirSync(join(configRoot, '.cat-cafe'), { recursive: true });
const fixtureCapabilitiesPath = join(configRoot, '.cat-cafe/capabilities.json');
try {
  assert.deepEqual(JSON.parse(readFileSync(fixtureCapabilitiesPath, 'utf8')), capabilities);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  writeFileSync(fixtureCapabilitiesPath, JSON.stringify(capabilities));
}
try {
  for (const id of options.members.split(',')) {
    const config = configs[id];
    assert.ok(config, `configured member not found: ${id}`);
    const workspace = join(root, `workspace-${id}`);
    mkdirSync(join(workspace, '.cat-cafe'), { recursive: true });
    writeFileSync(join(workspace, '.cat-cafe/capabilities.json'), JSON.stringify(capabilities));
    const marker = `F333-fixture-${randomUUID()}`;
    const document = join(workspace, 'document.txt');
    writeFileSync(document, `${marker}\n`);
    const threadId = `f333-smoke-${randomUUID()}`;
    const thread = {
      id: threadId,
      title: 'F333 private fixture',
      projectPath: workspace,
      createdBy: 'fixture-user',
      participants: [id],
    };
    const deps = {
      registry,
      sessionManager,
      sessionChainStore,
      runtimeSessionStore,
      threadStore: { get: async () => thread, getMemberEffort: async () => 'low' },
      apiUrl,
      contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
    };
    let service;
    const common = { catId: id, l0CompilerFn, rawArchive: archive };
    if (config.carrier === 'acp')
      service = await createAcpServiceForConfig({
        projectRoot: configRoot,
        profileId: id,
        config,
        effectiveModel: config.defaultModel,
        acpConfig: getAcpConfig(id, configRoot),
        poolRegistry,
        log: { info() {}, warn() {} },
        bootstrapRoot: join(root, 'acp-bootstrap'),
      });
    else if (config.clientId === 'anthropic')
      service =
        config.carrier === 'sdk' && options['claude-carrier'] !== 'cli'
          ? new ClaudeSdkAgentService(common)
          : new ClaudeAgentService(common);
    else if (config.clientId === 'openai')
      service = new CodexAgentService({ ...common, carrierMode: 'app_server', appServerHostPool: codexPool });
    else if (config.clientId === 'google')
      service = new AgyNativeAgentService({ ...common, profile: config.agyProfile });
    else if (config.clientId === 'opencode') service = new OpenCodeAgentService(common);
    if (service && config.clientId === 'openai') {
      // The fixture has one explicit required MCP operation. Use the existing
      // native inventory preflight, rather than prompting a model against an
      // unverified tool surface. This does not grant or install any tool.
      const invoke = service.invoke.bind(service);
      service.invoke = (prompt, turnOptions) =>
        invoke(prompt, {
          ...turnOptions,
          requiredTools: ['cat-cafe-memory::cat_cafe_read_file_slice'],
        });
    }
    if (!service) {
      report.results.push({
        member: id,
        clientId: config.clientId,
        carrier: config.carrier,
        turns: [],
        ok: false,
        failure: 'provider could not prepare',
      });
      writeFileSync(resolve(options.output), JSON.stringify(report, null, 2));
      process.stdout.write(`${JSON.stringify({ member: id, ok: false, failure: 'provider could not prepare' })}\n`);
      continue;
    }
    const result = {
      member: id,
      clientId: config.clientId,
      carrier: config.carrier,
      carrierUnderTest: options['claude-carrier'] ?? config.carrier,
      fixtureRequiredTools: config.clientId === 'openai' ? ['cat-cafe-memory::cat_cafe_read_file_slice'] : [],
      turns: [],
      ok: false,
    };
    report.results.push(result);
    try {
      for (let turn = 0; turn < modes.length; turn++) {
        const mode = modes[turn];
        process.env.CAT_CAFE_MCP_TRANSPORT = mode;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error('fixture deadline')), 240000);
        const events = [];
        const wire = {
          samples: 0,
          processes: 0,
          carrierProcesses: 0,
          selfMcpProcesses: 0,
          peakRssKiB: 0,
          peakResourceCost: null,
          incompleteSamples: 0,
          callbackSecretInArgvOrEnv: false,
        };
        const observe = () => {
          const scan = inspectOwnedProcessCredentials(process.pid, secrets);
          wire.samples++;
          wire.processes = Math.max(wire.processes, scan.processCount);
          wire.carrierProcesses = Math.max(wire.carrierProcesses, scan.carrierProcessCount);
          wire.selfMcpProcesses = Math.max(wire.selfMcpProcesses, scan.selfMcpProcessCount);
          if (scan.rssKiB > wire.peakRssKiB) {
            wire.peakRssKiB = scan.rssKiB;
            wire.peakResourceCost = {
              rssKiB: scan.rssKiB,
              hostRssKiB: scan.hostRssKiB,
              byCategory: scan.byCategory,
            };
          }
          if (!scan.complete) wire.incompleteSamples++;
          wire.callbackSecretInArgvOrEnv ||= scan.credentialValueDetected;
        };
        const observer = setInterval(observe, 1000);
        const start = performance.now();
        try {
          const prompt = `MCP integration fixture, turn ${turn + 1}. Call cat_cafe_read_file_slice with path=${JSON.stringify(document)}, startLine=1. You must make this actual MCP call, even if the previous turn read it. Do not use native file/shell tools. Reply with only the line you actually read. Do not send messages or modify anything.`;
          for await (const event of invokeSingleCat(deps, {
            catId: id,
            service,
            prompt,
            userId: 'fixture-user',
            ownerAuthProvenance: 'strict',
            threadId,
            isLastCat: true,
            signal: controller.signal,
            capacitySnapshot: resolveInvocationCapacitySnapshot({ catId: id, service }),
          }))
            events.push(event);
          const invocationId = admitted.get(`${id}:${threadId}`);
          const invocationCounts = counts.get(invocationId);
          const text = events
            .filter((event) => event.type === 'text')
            .map((event) => event.content ?? '')
            .join('');
          const errors = events
            .filter((event) => event.type === 'error')
            .map((event) => ({ code: event.errorCode, message: event.error }));
          const session = events.find((event) => event.type === 'session_init')?.sessionId;
          observe();
          const evidence = {
            turn: turn + 1,
            transport: mode,
            durationMs: performance.now() - start,
            session,
            invocationId,
            events: Object.fromEntries(
              [...new Set(events.map((event) => event.type))].map((type) => [
                type,
                events.filter((event) => event.type === type).length,
              ]),
            ),
            tools: events.filter((event) => event.type === 'tool_use').map((event) => event.toolName),
            calls: invocationCounts,
            markerRead: text.includes(marker),
            failureResponse: text.includes(marker)
              ? undefined
              : [...secrets].reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text).slice(0, 2000),
            errors,
            nativeProcessObservation: wire,
          };
          result.turns.push(evidence);
          const actualMcpRead = evidence.tools.some((name) => name?.includes('cat_cafe_read_file_slice'));
          const correctTransport =
            mode === 'shared'
              ? invocationCounts?.call > 0 && invocationCounts.shared && wire.selfMcpProcesses === 0
              : !invocationCounts && wire.selfMcpProcesses > 0;
          assert.ok(
            !errors.length && evidence.markerRead && actualMcpRead && correctTransport,
            `real carrier fixture failed: ${id}, turn ${turn + 1}`,
          );
          assert.ok(
            wire.samples > wire.incompleteSamples && wire.carrierProcesses > 0 && !wire.callbackSecretInArgvOrEnv,
            'shared MCP credentials cannot enter a real native argv/env',
          );
        } finally {
          clearInterval(observer);
          clearTimeout(timeout);
        }
      }
      result.ok = true;
    } catch (error) {
      result.failure = error.message;
    } finally {
      await service.disposeHostService?.();
    }
    report.archivedEnvelopes = archivedEnvelopes;
    report.callbackSecretFoundInArchive = archiveLeak;
    writeFileSync(resolve(options.output), JSON.stringify(report, null, 2));
    process.stdout.write(
      `${JSON.stringify({ member: id, ok: result.ok, turns: result.turns.map(({ turn, durationMs, markerRead, calls, errors }) => ({ turn, durationMs, markerRead, calls, errors })) })}\n`,
    );
  }
} finally {
  await Promise.allSettled([...poolRegistry.values()].map((pool) => pool.closeAll()));
  await codexPool.closeAll();
  await app.close();
  rmSync(credentialsRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
assert.ok(report.results.every((result) => result.ok) && !archiveLeak, 'native smoke did not pass');
process.exit(0);
