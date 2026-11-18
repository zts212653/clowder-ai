import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { roleConfigurationRevision } from '@clowder-ai/agent-access/roles/write-role';
import { AGENT_ACCESS_OPERATIONS, OFFICIAL_AGENT_ACCESS_OPERATIONS } from '@clowder-ai/agent-contract';
import { validateManifest } from '@clowder-ai/plugin-contract';
import Fastify from 'fastify';
import { A2AAgentService } from '../dist/domains/cats/services/agents/providers/A2AAgentService.js';
import { sessionImplementationKey } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createAgentAccessA2ARunner } from '../dist/domains/plugin/agent-access-a2a.js';
import { createAgentAccessDshConnectionTest } from '../dist/domains/plugin/agent-access-dsh.js';
import { createAgentAccessKimiLaunchPlanner } from '../dist/domains/plugin/agent-access-kimi.js';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../dist/domains/plugin/carrier/plugin-owner-request-context.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import {
  createAgentRoleRead,
  createAgentRoleWrite,
  registerAgentAccessRoutes,
} from '../dist/routes/agent-access-routes.js';
import { catsRoutes } from '../dist/routes/cats.js';
import { tarArchive } from '../scripts/bundled-plugin-artifacts.mjs';
import { canonicalGzip } from '../scripts/canonical-gzip.mjs';

test('Agent access discovery executes the same standalone entrypoint from a Manager archive across replacement and rollback', async (t) => {
  const pluginId = 'official.agent-access';
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-access-manager-'));
  const app = Fastify();
  const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
  const previousTemplate = process.env.CAT_TEMPLATE_PATH;
  const template = join(projectRoot, 'cat-template.json');
  const availableProviders = new Set();
  await writeFile(template, JSON.stringify({ version: 1, breeds: [], roleTemplates: [] }));
  process.env.CAT_CAFE_CONFIG_ROOT = projectRoot;
  process.env.CAT_TEMPLATE_PATH = template;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    contract: { manifestContractRange: '0.4.0-candidate.0', validateManifest },
    isDeclaredAgentProviderAvailable: (reference) => availableProviders.has(sessionImplementationKey(reference)),
  });
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
    if (previousTemplate === undefined) delete process.env.CAT_TEMPLATE_PATH;
    else process.env.CAT_TEMPLATE_PATH = previousTemplate;
    await app.close();
    await runtime.shutdown();
    await rm(projectRoot, { recursive: true, force: true });
  });

  const manager = createPluginManagerRuntimeComposition({
    runtime,
    catalogManifests: [],
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 0 }) },
  }).manager;
  const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = owner;
  });
  const { readLegacyNativeRuntimes: nativeRuntimeDiscovery, readDetection: agentAccessDetection } =
    registerAgentAccessRoutes(app, {
      inventory: runtime.inventoryStore,
      runtime: runtime.supervisor,
    });
  await app.register(catsRoutes, {
    nativeRuntimeDiscovery,
    agentAccessDetection,
    agentRoleRead: createAgentRoleRead(runtime.inventoryStore, runtime.supervisor),
    agentRoleWrite: createAgentRoleWrite(runtime.inventoryStore, runtime.supervisor),
  });
  const scan = async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/agent-access/v1/detect',
      headers: { host: 'localhost:3004' },
      remoteAddress: '127.0.0.1',
      payload: { refresh: true },
    });
    assert.equal(result.statusCode, 200, result.payload);
    return result.json();
  };

  const entrypoint = await readFile(new URL('../../agent-access-plugin/dist/plugin/entrypoint.mjs', import.meta.url));
  const nextModule = entrypoint
    .toString()
    .replace(/(id:\s*["']kimi["'],\s*label:\s*)(["'])Kimi\2/g, '$1$2Kimi vNext$2');
  assert.notEqual(nextModule, entrypoint.toString());
  async function archive(version, protocolVersion = 1, operations = OFFICIAL_AGENT_ACCESS_OPERATIONS) {
    const manifest = {
      pluginId,
      version,
      contractVersion: '0.4.0-candidate.0',
      name: 'Agent access discovery',
      features: [{ id: 'discovery', name: 'Client discovery', capabilities: [], resources: [] }],
      runtime: { transport: 'builtin', entrypoint: 'entrypoint.mjs' },
    };
    assert.deepEqual(validateManifest(manifest).errors ?? [], []);
    const output = join(projectRoot, `agent-access-${version}.tgz`);
    await writeFile(
      output,
      canonicalGzip(
        tarArchive([
          { name: 'package/manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) },
          {
            name: 'package/agent-access.json',
            bytes: Buffer.from(JSON.stringify({ protocolVersion, operations, transports: ['a2a'] })),
          },
          { name: 'package/entrypoint.mjs', bytes: version === '1.0.1' ? Buffer.from(nextModule) : entrypoint },
          {
            name: 'package/package.json',
            bytes: Buffer.from(JSON.stringify({ name: '@clowder-ai/agent-access', version, type: 'module' })),
          },
        ]),
      ),
    );
    return output;
  }
  const previous = await archive('1.0.0');
  const next = await archive('1.0.1');
  const incompatible = await archive('1.0.2', 2);
  const obsolete = await archive('0.9.0', 1, AGENT_ACCESS_OPERATIONS);
  const install = (path) => manager.install({ source: { kind: 'local-archive', path } });
  assert.equal((await scan()).readiness.state, 'missing');
  const setupRead = () =>
    app.inject({
      method: 'POST',
      url: '/api/cats/dsh-setup/inspect',
      headers: { host: 'localhost:3004' },
      remoteAddress: '127.0.0.1',
      payload: { runtimeId: 'unregistered-test-runtime', sourceProfile: 'acp' },
    });
  assert.deepEqual((await setupRead()).json(), { error: 'dsh_setup_unavailable' });
  const installed = await install(previous);
  await manager.setEnabled(pluginId, {
    enabled: true,
    expectedRevision: (await manager.get(pluginId)).plugin.lifecycleRevision,
  });
  const first = await scan();
  assert.equal(first.readiness.state, 'ready', JSON.stringify(first.readiness));
  assert.ok(first.candidates.some((candidate) => candidate.id === 'codex'));
  assert.equal(first.candidates.find((candidate) => candidate.id === 'kimi')?.label, 'Kimi');
  assert.deepEqual((await setupRead()).json(), { error: 'dsh_setup_custom_startup' });

  const remote = Fastify();
  t.after(() => remote.close());
  const dispatched = [];
  remote.post('/a2a', async (request) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-peer-token');
    const rpc = request.body;
    assert.equal(rpc.method, 'tasks/send');
    return {
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        id: rpc.params.id,
        status: 'TASK_STATE_COMPLETED',
        artifacts: [{ parts: [{ type: 'text', text: rpc.params.message.parts[0].text }] }],
      },
    };
  });
  const url = await remote.listen({ host: '127.0.0.1', port: 0 });
  const service = new A2AAgentService({
    catId: 'isolated-remote',
    config: { url: url + '/a2a', apiKey: 'fixture-peer-token' },
    runTurn: createAgentAccessA2ARunner(runtime.inventoryStore, runtime.supervisor),
  });
  const invoke = async (text) => {
    const output = [];
    for await (const event of service.invoke(text, {
      onRemoteExecutionDispatched: (execution) => dispatched.push(execution.kind),
    }))
      output.push(event);
    assert.deepEqual(
      output.map((event) => event.type),
      ['session_init', 'text', 'done'],
    );
    assert.equal(output[1].content, text);
  };
  await invoke('before replacement');

  const catalogPath = join(projectRoot, '.cat-cafe', 'cat-catalog.json');
  await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
  await writeFile(catalogPath, JSON.stringify({ version: 1, breeds: [] }));
  const readCatalog = async () => JSON.parse(await readFile(catalogPath, 'utf8'));
  const request = {
    kind: 'create',
    receipt: { requestHash: 'a'.repeat(64), payloadHash: 'b'.repeat(64) },
    input: {
      catId: 'isolated-role',
      name: 'Isolated role',
      displayName: 'Isolated role',
      avatar: '/avatars/default.png',
      color: { primary: '#101010', secondary: '#eeeeee' },
      mentionPatterns: ['@isolated-role'],
      roleDescription: 'Plugin-owned role write',
      clientId: 'kimi',
      configurationSource: 'native_tool',
      carrier: 'cli',
      defaultModel: 'fixture',
      mcpSupport: false,
      cli: { command: 'kimi', outputFormat: 'json' },
    },
  };
  await assert.rejects(runtime.supervisor.invoke(installed.pluginInstanceId, 'writeRole', request));
  assert.equal((await readCatalog()).breeds.length, 0);

  const mutate = (input) =>
    withPluginOwnerRequest(
      {
        pluginId,
        contributionId: 'writeRole',
        userId: owner,
        operation: 'write',
        signal: new AbortController().signal,
      },
      () =>
        withPluginOwnerWebhook(
          pluginId,
          'writeRole',
          installed.pluginInstanceId,
          false,
          () => {},
          () => runtime.supervisor.invoke(installed.pluginInstanceId, 'writeRole', input),
        ),
    );
  assert.deepEqual(await mutate(request), { status: 'committed', catId: request.input.catId });
  assert.deepEqual(await mutate(request), { status: 'committed', catId: request.input.catId, replayed: true });
  assert.equal((await readCatalog()).breeds.length, 1);
  assert.equal((await readCatalog()).breeds[0].catId, request.input.catId);
  const before = roleConfigurationRevision(await readCatalog(), request.input.catId);

  await assert.rejects(install(incompatible), /Agent access protocol version/);
  await assert.rejects(install(obsolete), /missing operations parseNativeEvent, testDshConnection/);
  assert.equal((await manager.get(pluginId)).plugin.installedVersion, '1.0.0');
  assert.equal((await scan()).readiness.state, 'ready');

  const planLaunch = createAgentAccessKimiLaunchPlanner(runtime.inventoryStore, runtime.supervisor);
  const launch = await planLaunch({
    prompt: 'fixture',
    imageAccessDirs: [],
    resumeSessionId: 'history-id',
    cliConfigArgs: ['--session unsolicited --output-format stream-json'],
  });
  assert.deepEqual(launch.args, ['--session', 'history-id', '-p', 'fixture', '--output-format', 'stream-json']);
  await launch.assertCurrent();
  assert.deepEqual(
    await launch.normalizeEvent({ role: 'assistant', session_id: 'history-id', content: 'Kimi reply' }),
    { kind: 'assistant', sessionId: 'history-id', text: 'Kimi reply', tools: [] },
  );
  const runConnectionTest = createAgentAccessDshConnectionTest(runtime.inventoryStore, runtime.supervisor);
  const fixtureAcpServer = `
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    const send = (value) => console.log(JSON.stringify({ jsonrpc: '2.0', ...value }));
    lines.on('line', (line) => {
      const { method, id } = JSON.parse(line);
      if (method === 'initialize') send({ id, result: { protocolVersion: 1 } });
      if (method === 'session/new') send({ id, result: { sessionId: 'isolated-dsh' } });
      if (method === 'session/prompt') {
        send({
          method: 'session/update',
          params: { sessionId: 'isolated-dsh', update: {
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DSH_CONNECTION_OK' },
          } },
        });
        send({ id, result: { stopReason: 'end_turn' } });
      }
    });
  `;
  assert.deepEqual(
    await runConnectionTest(
      { command: process.execPath, args: ['-e', fixtureAcpServer], cwd: projectRoot, spawnFn: spawn },
      projectRoot,
      {},
    ),
    { sessionId: 'isolated-dsh' },
  );

  const latest = await install(next);
  await assert.rejects(launch.assertCurrent(), /session_implementation_unavailable/);
  assert.equal(latest.pluginInstanceId, installed.pluginInstanceId);
  const afterUpdate = await scan();
  assert.equal(afterUpdate.readiness.state, 'ready');
  assert.equal(afterUpdate.candidates.find((candidate) => candidate.id === 'kimi')?.label, 'Kimi vNext');
  const legacyScan = await app.inject({
    method: 'GET',
    url: '/api/cats/native-runtimes?refresh=1',
    headers: { host: 'localhost:3004', 'X-Cat-Cafe-User': owner },
    remoteAddress: '127.0.0.1',
  });
  assert.equal(legacyScan.statusCode, 200, legacyScan.payload);
  assert.equal(legacyScan.json().runtimes.find((candidate) => candidate.id === 'kimi')?.label, 'Kimi vNext');
  assert.equal((await manager.get(pluginId)).plugin.installedVersion, '1.0.1');
  await invoke('after replacement');

  assert.deepEqual(
    await mutate({
      kind: 'update',
      catId: request.input.catId,
      expectedRevision: before,
      patch: { displayName: 'Renamed during upgrade' },
    }),
    { status: 'committed', catId: request.input.catId },
  );
  assert.deepEqual(
    await mutate({
      kind: 'delete',
      catId: request.input.catId,
      expectedRevision: before,
    }),
    { status: 'conflict' },
  );

  await install(previous);
  assert.equal((await manager.get(pluginId)).plugin.installedVersion, '1.0.0');
  const afterRollback = await scan();
  assert.equal(afterRollback.readiness.state, 'ready');
  assert.equal(afterRollback.candidates.find((candidate) => candidate.id === 'kimi')?.label, 'Kimi');
  const restored = await readCatalog();
  assert.equal(restored.breeds[0].displayName, 'Renamed during upgrade');
  await invoke('after rollback');
  assert.deepEqual(dispatched, ['a2a_task', 'a2a_task', 'a2a_task']);
  assert.deepEqual(
    await mutate({
      kind: 'delete',
      catId: request.input.catId,
      expectedRevision: roleConfigurationRevision(restored, request.input.catId),
    }),
    { status: 'committed', catId: request.input.catId },
  );
  assert.equal((await readCatalog()).breeds.length, 0);

  const call = (method, path, payload, headers = {}) =>
    app.inject({
      method,
      url: path,
      headers: { host: 'localhost:3004', origin: 'http://localhost:3003', ...headers },
      remoteAddress: '127.0.0.1',
      payload,
    });
  const directory = await call('GET', '/api/agent-access/v1/clients');
  assert.ok(directory.json().clients.some((client) => client.id === 'kimi'));
  const previousBindHost = process.env.API_SERVER_HOST;
  t.after(() => {
    if (previousBindHost === undefined) delete process.env.API_SERVER_HOST;
    else process.env.API_SERVER_HOST = previousBindHost;
  });
  process.env.API_SERVER_HOST = '0.0.0.0';
  const lanDetection = await call('POST', '/api/agent-access/v1/detect', { refresh: true });
  assert.equal(lanDetection.statusCode, 200, lanDetection.payload);
  assert.ok(lanDetection.json().candidates.some((client) => client.id === 'kimi'));
  const lanDirectory = await call('GET', '/api/agent-access/v1/clients');
  assert.equal(lanDirectory.statusCode, 200, lanDirectory.payload);
  assert.ok(lanDirectory.json().clients.some((client) => client.id === 'kimi'));
  const selectedProvider = 'plugin:local.agent-access-test/kimi';
  const declared = {
    clientId: 'acp',
    carrier: 'acp',
    acp: { command: 'plugin-agent', startupArgs: [], agentProvider: selectedProvider },
  };
  const unavailable = await call('POST', '/api/cats', { ...request.input, ...declared });
  assert.equal(unavailable.statusCode, 409, unavailable.payload);
  assert.equal(unavailable.json().code, 'agent_provider_unavailable');
  const unavailableTopLevel = await call('POST', '/api/cats', { ...request.input, agentProvider: selectedProvider });
  assert.equal(unavailableTopLevel.statusCode, 409, unavailableTopLevel.payload);
  assert.equal(unavailableTopLevel.json().code, 'agent_provider_unavailable');
  assert.equal((await readCatalog()).breeds.length, 0);
  const create = await call('POST', '/api/cats', request.input);
  assert.equal(create.statusCode, 201, create.payload);
  const createdRole = create.json().cat;
  assert.equal(createdRole.id, request.input.catId);
  const journey = randomUUID();
  const receipt = {
    'idempotency-key': `onboarding:${journey}:cat:${request.input.catId}`,
    'x-cat-cafe-onboarding-journey': journey,
  };
  const collidingCreate = { ...request.input, ...declared, mentionPatterns: ['@separate-receipt-member'] };
  const blockedCollision = await call('POST', '/api/cats', collidingCreate, receipt);
  assert.equal(blockedCollision.statusCode, 409, blockedCollision.payload);
  assert.equal(blockedCollision.json().code, 'agent_provider_unavailable');
  const inherited = await readCatalog();
  Object.assign(inherited.breeds[0], {
    teamStrengths: 'Template collaboration strength',
    caution: 'Template caution',
    restrictions: ['Template restriction'],
  });
  await writeFile(template, JSON.stringify(inherited));
  const roles = await call('GET', '/api/cats');
  const card = roles.json().cats.find((cat) => cat.id === createdRole.id);
  assert.deepEqual(card.client, { id: 'kimi', label: 'Kimi', type: 'legacy' });
  assert.equal(card.teamStrengths, 'Template collaboration strength');
  assert.equal(card.caution, 'Template caution');
  assert.deepEqual(card.restrictions, ['Template restriction']);
  const rolePath = '/api/cats/' + createdRole.id;
  const staleSelection = await call('PATCH', rolePath, {
    ...declared,
    expectedRevision: createdRole.configurationRevision,
  });
  assert.equal(staleSelection.statusCode, 409, staleSelection.payload);
  assert.equal(staleSelection.json().code, 'agent_provider_unavailable');
  availableProviders.add(selectedProvider);
  const distinctCreation = await call('POST', '/api/cats', collidingCreate, receipt);
  assert.equal(distinctCreation.statusCode, 201, distinctCreation.payload);
  const receiptRole = distinctCreation.json().cat;
  assert.notEqual(receiptRole.id, createdRole.id);
  assert.equal(receiptRole.acp.agentProvider, selectedProvider);
  const bound = await call('PATCH', rolePath, { ...declared, expectedRevision: createdRole.configurationRevision });
  assert.equal(bound.statusCode, 200, bound.payload);
  assert.equal(bound.json().cat.acp.agentProvider, selectedProvider);
  availableProviders.delete(selectedProvider);
  const edited = await call('PATCH', rolePath, {
    displayName: 'Changed using the member API',
    expectedRevision: bound.json().cat.configurationRevision,
  });
  assert.equal(edited.statusCode, 200, edited.payload);
  assert.equal(edited.json().cat.displayName, 'Changed using the member API');
  assert.equal(edited.json().cat.acp.agentProvider, selectedProvider);
  const deleted = await call('DELETE', rolePath, { expectedRevision: edited.json().cat.configurationRevision });
  assert.equal(deleted.statusCode, 200, deleted.payload);
  const replay = await call('POST', '/api/cats', collidingCreate, receipt);
  assert.equal(replay.statusCode, 200, replay.payload);
  assert.equal(replay.json().cat.id, receiptRole.id);
  const removedReplay = await call('DELETE', '/api/cats/' + receiptRole.id, {
    expectedRevision: replay.json().cat.configurationRevision,
  });
  assert.equal(removedReplay.statusCode, 200, removedReplay.payload);
  assert.equal((await readCatalog()).breeds.length, 0);
});
