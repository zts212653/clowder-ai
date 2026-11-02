import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '../../shared/dist/index.js';
import {
  invokeSingleCat,
  prepareInvocationExecutionBinding,
} from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpClient, AcpProtocolError } from '../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { resolveBuiltinCatCafeServer } from '../dist/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';
import { PiAcpBridge } from '../dist/domains/cats/services/agents/providers/pi/pi-acp-bridge.js';
import { PI_BRIDGE_NAME } from '../dist/domains/cats/services/agents/providers/pi/pi-bridge-contract.js';
import { PiSessionStore } from '../dist/domains/cats/services/agents/providers/pi/pi-session-store.js';
import { SessionSealer } from '../dist/domains/cats/services/session/SessionSealer.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { routingJourneyDeps } from './helpers/routing-journey-deps.js';

for (const failure of ['none', 'seal', 'finalize', 'rebuild', 'no-context']) {
  test(`Host preserves Pi history across MCP binding upgrade (failure=${failure})`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const root = mkdtempSync(join(tmpdir(), 'pi-upgrade-continuity-'));
    const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CAT_CAFE_MCP_CREDS_DIR'];
    const env = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CAT_CAFE_CONFIG_ROOT = root;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    process.env.CAT_CAFE_MCP_CREDS_DIR = join(root, 'creds');
    t.after(() =>
      env.forEach((value, key) => (value === undefined ? delete process.env[key] : (process.env[key] = value))),
    );
    mkdirSync(join(root, '.cat-cafe'));
    writeFileSync(join(root, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }));
    const original = catRegistry.getAllConfigs(),
      catId = 'pi-upgrade-review';
    catRegistry.register(catId, {
      ...original.codex,
      id: catId,
      clientId: 'acp',
      configurationSource: 'managed_account',
      accountRef: undefined,
      defaultModel: '',
      mcpSupport: true,
    });
    t.after(() => {
      catRegistry.reset();
      Object.entries(original).forEach(([id, config]) => catRegistry.register(id, config));
    });
    const canonical = resolveBuiltinCatCafeServer(root, 'cat-cafe-collab');
    const oldServer = { ...canonical, args: [join(root, 'packages/mcp-server/dist/collab.js')] };
    const piStore = new PiSessionStore({ root, scope: 'e'.repeat(64) });
    const slot = piStore.create(root, [oldServer]);
    const nativeFile = join(slot.directory, 'history.jsonl');
    writeFileSync(nativeFile, JSON.stringify({ type: 'session', version: 3, id: slot.id, cwd: root }) + '\n');
    assert.throws(() => piStore.load(slot.id, root, [canonical]), /MCP/);
    const hash = () => createHash('sha256').update(readFileSync(nativeFile)).digest('hex');
    const beforeHash = hash();
    const protocol = [],
      output = [];
    const bridge = new PiAcpBridge('never-start-a-model', [], (response) => output.push(response), {
      root,
      scope: 'e'.repeat(64),
    });
    t.after(() => bridge.close());
    const client = new AcpClient({ command: 'never-start-a-process', args: [], cwd: root });
    client.initResult = {
      agentInfo: { name: PI_BRIDGE_NAME },
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: false } },
    };
    let sequence = 0,
      prompts = 0;
    const freshIds = new Set();
    client.sendRequest = async (method, params) => {
      protocol.push({ method, sessionId: params.sessionId });
      if (method === 'session/load') {
        if (freshIds.has(params.sessionId)) {
          piStore.load(params.sessionId, params.cwd, params.mcpServers);
          return { result: { sessionId: params.sessionId } };
        }
        const id = ++sequence;
        await bridge.handle({ jsonrpc: '2.0', id, method, params });
        const response = output.find((item) => item.id === id);
        if (response.error)
          throw new AcpProtocolError(response.error.code, response.error.message, response.error.data);
        return response;
      }
      if (method === 'session/new') {
        const next = piStore.create(params.cwd, params.mcpServers);
        freshIds.add(next.id);
        writeFileSync(
          join(next.directory, 'history.jsonl'),
          JSON.stringify({ type: 'session', version: 3, id: next.id, cwd: params.cwd }) + '\n',
        );
        return { result: { sessionId: next.id } };
      }
      return { result: {} };
    };
    client.promptStream = async function* (sessionId, input) {
      assert.equal(store.get(old.id).status, 'sealed', 'Host seals old history before submitting any replacement');
      assert.notEqual(sessionId, slot.id);
      if (!prompts) {
        assert.match(JSON.stringify(input), /AUTHORIZED_HISTORY_SUMMARY/);
        assert.match(JSON.stringify(input), /CURRENT_TASK/);
      }
      prompts += 1;
      yield {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'synthetic reply' } },
      };
      return 'end_turn';
    };
    const service = new AcpAgentService({
      catId,
      projectRoot: root,
      mcpWhitelist: ['cat-cafe-collab'],
      mcpSupport: true,
      poolKey: { projectPath: root, providerProfile: 'pi' },
      pool: {
        async acquire() {
          return { client, async closeTurn() {}, release() {} };
        },
      },
    });
    const { deps: routing } = routingJourneyDeps(undefined, undefined, service);
    const deps = routing.invocationDeps;
    const store = new SessionChainStore();
    deps.sessionChainStore = store;
    deps.sessionSealer = new SessionSealer(store);
    if (failure === 'seal') deps.sessionSealer.requestSeal = async () => ({ accepted: false });
    if (failure === 'finalize') deps.sessionSealer.finalize = async () => ({ sealed: false });
    deps.threadStore = { get: () => ({ id: 'thread', projectPath: root }) };
    let resume = slot.id;
    deps.sessionManager.get = async () => resume;
    deps.sessionManager.store = async (_user, _cat, _thread, id) => {
      resume = id;
    };
    deps.sessionManager.delete = async () => {
      resume = undefined;
    };
    const binding = await prepareInvocationExecutionBinding(deps, {
      catId,
      threadId: 'thread',
      userId: 'owner',
      service,
      ownerAuthProvenance: 'strict',
    });
    const old = store.create({ catId, threadId: 'thread', userId: 'owner' });
    assert.ok(await store.bindHostExecutionBoundary(old.id, undefined, binding.hostExecutionBoundary));
    assert.ok(await store.bindCliSessionId(old.id, slot.id));
    assert.deepEqual(
      store.get(old.id).hostExecutionBoundary,
      binding.hostExecutionBoundary,
      'the fixture must start with a proven compatible Host boundary',
    );
    const invoke = () =>
      Array.fromAsync(
        invokeSingleCat(deps, {
          catId,
          service,
          userId: 'owner',
          threadId: 'thread',
          prompt: 'CURRENT_TASK',
          systemPrompt: 'ROLE',
          isLastCat: true,
          ownerAuthProvenance: 'strict',
          ...(failure === 'no-context'
            ? {}
            : {
                rebuildPromptAfterSessionSeal: async () => {
                  if (failure === 'rebuild') throw new Error('fixture_history_rebuild_unavailable');
                  return 'AUTHORIZED_HISTORY_SUMMARY\nCURRENT_TASK';
                },
              }),
        }),
      );
    const first = await invoke();
    if (failure !== 'none') {
      assert.equal(prompts, 0, 'failed sealing or history reconstruction cannot submit a new prompt');
      assert.equal(
        protocol.some((call) => call.method === 'session/new'),
        false,
      );
      assert.equal(hash(), beforeHash);
      assert.ok(first.some((message) => message.type === 'error'));
      assert.equal(
        store.get(old.id).status,
        ['seal', 'no-context'].includes(failure) ? 'active' : failure === 'finalize' ? 'sealing' : 'sealed',
      );
      return;
    }
    const second = await invoke();
    console.log(
      'UPGRADE_EVIDENCE',
      JSON.stringify({
        oldId: old.id,
        oldNativeId: slot.id,
        oldStatus: store.get(old.id).status,
        activeId: store.getActive(catId, 'thread', 'owner').id,
        chainLength: store.getChain(catId, 'thread', 'owner').length,
        prompts,
        protocol,
        errors: [first, second].map((messages) =>
          messages.filter((message) => message.type === 'error').map(({ errorCode, error }) => ({ errorCode, error })),
        ),
        nativeHashUnchanged: beforeHash === hash(),
        fixture: root,
      }),
    );
    assert.equal(hash(), beforeHash, 'upgrade recovery must never rewrite old native history');
    assert.equal(
      store.get(old.id).status,
      'sealed',
      'old incompatible MCP binding must not remain the active retry target',
    );
    assert.notEqual(store.getActive(catId, 'thread', 'owner').cliSessionId, slot.id);
    assert.ok(prompts > 0, 'the authorized current task must reach a fresh segment');
    assert.equal(protocol.filter((call) => call.method === 'session/new').length, 1);
    assert.equal(store.getChain(catId, 'thread', 'owner').length, 2, 'subsequent turns reuse the replacement');
    assert.equal(
      first.some((message) => message.type === 'error'),
      false,
    );
    assert.equal(
      second.some((message) => message.type === 'error'),
      false,
    );
  });
}
