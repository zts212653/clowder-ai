import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildAuthHeaders } from '@cat-cafe/mcp-server/dist/tools/callback-tools.js';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { resolveConfiguredMemberMcpFamilies } from '../dist/config/capabilities/member-mcp-families.js';
import { getAcpConfig } from '../dist/config/cat-config-loader.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { registerMemberMcpRoutes } from '../dist/routes/member-mcp.js';
import { resolveActiveProjectRoot } from '../dist/utils/active-project-root.js';
import { currentMemberId, memberFamilies, memberOwnerFixture } from './helpers/shared-mcp-member-owner.js';

test('a real invocation admits all families from the current runtime member, independent of the workspace catalog', async (t) => {
  const f = memberOwnerFixture(t);
  const app = Fastify();
  t.after(() => app.close());
  const registry = new InvocationRegistry();
  registerMemberMcpRoutes(app, {
    registry,
    resolveMemberToolFamilies: ({ catId, sharedContext }) =>
      resolveConfiguredMemberMcpFamilies(sharedContext.capabilityRoot, catId, sharedContext.workspaceRoot),
    apiBaseUrl: 'http://127.0.0.1:3102',
    log: { warn() {} },
  });
  const document = join(f.workspace, 'own-document.txt');
  writeFileSync(document, 'MEMBER_OWNER_DOCUMENT');
  const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
  const { resolveInvocationCapacitySnapshot } = await import(
    '../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js'
  );
  let admitted;
  let authHeaders;
  const service = {
    contextCapability: () => ({
      provider: 'test',
      carrier: 'test_stream',
      reportsRuntimeWindow: true,
      authoritativeUsage: true,
      nativeWindowControl: false,
      nativeCompressionControl: false,
      observesCompression: false,
      reason: 'fixture',
    }),
    async *invoke(_prompt, options) {
      const auth = JSON.parse(readFileSync(options.callbackEnv.CAT_CAFE_CREDENTIAL_FILE, 'utf8'));
      admitted = auth.invocationId;
      authHeaders = buildAuthHeaders(auth);
      const rpc = (family, method, params = {}) =>
        app.inject({
          method: 'POST',
          url: `/api/member-mcp/mcp?shared=1&family=${family}`,
          headers: {
            accept: 'application/json, text/event-stream',
            'x-mcp-connection-id': 'member-owner-fixture',
            ...buildAuthHeaders(auth),
          },
          payload: { jsonrpc: '2.0', id: 1, method, params },
        });
      const statuses = [];
      for (const family of memberFamilies) {
        const response = await rpc(family, 'initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'fixture', version: '1' },
        });
        statuses.push(response.statusCode);
      }
      assert.deepEqual(
        statuses,
        [200, 200, 200, 200, 200, 200],
        'Alpha dual-root initial POSTs must not all fail with 403',
      );
      const read = await rpc('memory', 'tools/call', {
        name: 'cat_cafe_read_file_slice',
        arguments: { path: document, startLine: 1 },
      });
      assert.equal(read.statusCode, 200);
      assert.ok(
        read.body.includes('MEMBER_OWNER_DOCUMENT'),
        'real file handler must execute in the admitted workspace',
      );
      yield { type: 'done', catId: currentMemberId, timestamp: Date.now() };
    },
  };
  const capacitySnapshot = await resolveInvocationCapacitySnapshot({
    catId: currentMemberId,
    threadId: 'fixture-thread',
    service,
  });
  const deps = {
    registry,
    apiUrl: 'http://127.0.0.1:3102',
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => f.workspace,
    },
    threadStore: { get: () => ({ id: 'fixture-thread', userId: 'fixture-user', projectPath: f.workspace }) },
    contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
  };
  const events = [];
  for await (const event of invokeSingleCat(deps, {
    catId: currentMemberId,
    userId: 'fixture-user',
    threadId: 'fixture-thread',
    prompt: 'read my own document',
    service,
    capacitySnapshot,
    isLastCat: true,
  }))
    events.push(event);
  assert.ok(admitted, JSON.stringify(events));
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
    JSON.stringify(events),
  );
  const record = await registry.getRecord(admitted);
  assert.equal(record.sharedMcpContext.capabilityRoot, f.workspace);
  assert.deepEqual([...record.sharedMcpContext.families].sort(), [...memberFamilies].sort());
  await registry.commitTerminal({
    invocationId: admitted,
    disposition: 'revoked',
    endedAt: Date.now(),
    endReason: 'fixture',
  });
  const revoked = await app.inject({
    method: 'POST',
    url: '/api/member-mcp/mcp?shared=1&family=memory',
    headers: {
      accept: 'application/json, text/event-stream',
      'x-mcp-connection-id': 'member-owner-fixture',
      ...authHeaders,
    },
    payload: { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} },
  });
  assert.equal(revoked.statusCode, 401, 'a valid runtime member cannot revive a revoked invocation');
  assert.equal(
    JSON.parse(readFileSync(join(f.workspace, '.cat-cafe/cat-catalog.json'))).breeds.some((breed) =>
      breed.variants.some((member) => member.catId === currentMemberId),
    ),
    false,
  );
});

test('current member disable/removal and revocation stay closed even when the workspace catalog grants MCP', async (t) => {
  const f = memberOwnerFixture(t);
  const oldBreed = f.oldCatalog.breeds.find((breed) => breed.catId === 'codex');
  oldBreed.variants.push({ ...f.member, mcpSupport: true });
  writeFileSync(join(f.workspace, '.cat-cafe/cat-catalog.json'), JSON.stringify(f.oldCatalog));
  f.member.mcpSupport = false;
  f.refresh();
  assert.deepEqual(await resolveConfiguredMemberMcpFamilies(f.workspace, currentMemberId, f.workspace), []);
  catRegistry.reset();
  assert.deepEqual(await resolveConfiguredMemberMcpFamilies(f.workspace, currentMemberId, f.workspace), []);
  assert.deepEqual(await resolveConfiguredMemberMcpFamilies(f.workspace, 'unknown-member', f.workspace), []);
});

test('actual ACP newSession and shared family bounds use the runtime whitelist with persistent capability toggles', async (t) => {
  const f = memberOwnerFixture(t);
  f.member.clientId = 'kimi';
  f.member.carrier = 'acp';
  f.member.acp = { command: 'fixture-acp', mcpWhitelist: ['cat-cafe-memory'] };
  f.refresh();
  f.oldCatalog.breeds
    .find((breed) => breed.catId === 'codex')
    .variants.push({
      ...f.member,
      acp: { command: 'stale-workspace-acp', mcpWhitelist: ['cat-cafe-finance'] },
    });
  writeFileSync(join(f.workspace, '.cat-cafe/cat-catalog.json'), JSON.stringify(f.oldCatalog));
  const current = getAcpConfig(currentMemberId, resolveActiveProjectRoot());
  let injected;
  const client = {
    async newSession(_cwd, servers) {
      injected = servers;
      return { sessionId: 'fixture-session' };
    },
    async setSessionConfigOption() {},
    async *promptStream(sessionId) {
      yield { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } };
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    recentCapacitySignal: null,
  };
  const service = new AcpAgentService({
    catId: currentMemberId,
    projectRoot: f.runtime,
    providerName: 'kimi',
    modelName: 'fixture',
    mcpSupport: true,
    mcpWhitelist: current.mcpWhitelist,
    poolKey: { projectPath: f.workspace, providerProfile: 'fixture' },
    pool: {
      async acquire(poolKey) {
        return { client, poolKey, release() {} };
      },
      rememberSession() {},
    },
  });
  for await (const _event of service.invoke('fixture', { workingDirectory: f.workspace })) {
    /* real service resolves injected servers */
  }
  assert.deepEqual(
    injected.map((server) => server.name),
    ['cat-cafe-memory'],
  );
  assert.deepEqual(await resolveConfiguredMemberMcpFamilies(f.workspace, currentMemberId, f.workspace), ['memory']);
  const capabilityPath = join(f.workspace, '.cat-cafe/capabilities.json');
  const capabilities = JSON.parse(readFileSync(capabilityPath, 'utf8'));
  capabilities.capabilities.find((entry) => entry.id === 'cat-cafe-memory').enabled = false;
  writeFileSync(capabilityPath, JSON.stringify(capabilities));
  for await (const _event of service.invoke('fixture', { workingDirectory: f.workspace })) {
    /* observe current capability policy */
  }
  assert.deepEqual(injected, []);
  assert.deepEqual(await resolveConfiguredMemberMcpFamilies(f.workspace, currentMemberId, f.workspace), []);
  delete f.member.acp;
  f.refresh();
  assert.deepEqual(
    await resolveConfiguredMemberMcpFamilies(f.workspace, currentMemberId, f.workspace),
    [],
    'missing current ACP configuration cannot fall through to CLI discovery',
  );
});
