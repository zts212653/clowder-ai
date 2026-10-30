/**
 * iCode ACP protocol adapter (`acp.protocolAdapter: "icode"`) — Phase A contracts.
 *
 * Reference: docs/features/F306-codex-app-capability-parity.md (parity journey)
 * and the iCode integration plan. These tests pin the iCode-specific protocol
 * decisions that differ from the generic ACP path:
 *
 *  - Model selection uses the standard `session/set_model` (modelId = iCode
 *    model profile id), never `session/set_config_option`, and failures are
 *    surfaced as errors instead of silently continuing on the default model.
 *  - Resume (`session/load`) re-injects the current invocation's MCP overlay
 *    after the previous live instance is closed, so persisted sessions load
 *    with fresh per-turn credentials, just like `session/new`.
 *  - The live session instance is closed per turn (`session/close`) so the
 *    next turn can load the persisted session with fresh credentials.
 *  - Permission requests stay reject-only: iCode gets no invocation-scoped
 *    approval handler, so the client's fail-closed default answers them, and
 *    `acp.autoApprove` is ignored for iCode members.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { AcpAgentService } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');
const { createAcpServiceForConfig } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
);
const { createAcpPoolSpawnSignature } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/acp-pool-signature.js'
);
const { RuntimeInteractionError } = await import('../../dist/domains/runtime-interaction/RuntimeInteractionError.js');

const TEST_POOL_KEY = { projectPath: '/tmp', providerProfile: 'test' };

// Keep session credential files out of the repo working tree.
process.env.CAT_CAFE_MCP_CREDS_DIR = mkdtempSync(join(tmpdir(), 'icode-adapter-creds-'));

const STDIO_SERVER = {
  name: 'cat-cafe',
  command: process.execPath,
  args: [fileURLToPath(new URL('../../../mcp-server/dist/index.js', import.meta.url))],
  env: [],
};
const HTTP_SERVER = { name: 'gateway', type: 'http', url: 'http://127.0.0.1:1/mcp', headers: [] };
const USER_STDIO_SERVER = { name: 'user-tool', command: 'node', args: ['tool.js'], env: [] };

/** Per-turn callback env as assembled by invoke-single-cat for one invocation. */
const GATEWAY_ENV = {
  CAT_CAFE_API_URL: 'http://127.0.0.1:4604',
  CAT_CAFE_INVOCATION_ID: 'inv-turn-1',
  CAT_CAFE_CALLBACK_TOKEN: 'tok-turn-1',
  CAT_CAFE_THREAD_ID: 'th-1',
  CAT_CAFE_USER_ID: 'u-1',
};

/** The member gateway overlay the icode adapter must inject for this turn. */
function gatewayOverlay(invocationId, callbackToken) {
  return {
    type: 'http',
    name: 'cat-cafe-member',
    url: 'http://127.0.0.1:4604/api/member-mcp/mcp',
    headers: [
      { name: 'x-invocation-id', value: invocationId },
      { name: 'x-callback-token', value: callbackToken },
    ],
  };
}

/**
 * Fake ACP client with iCode protocol surface + strict call-order tracking.
 * newSession advertises a `model` configOption so any test can catch the
 * adapter accidentally taking the set_config_option path.
 */
function makeIcodeClient({ failSetModel = false, failClose = false, freshEvents = ['ok'] } = {}) {
  const order = [];
  const calls = {
    newSession: [],
    loadSession: [],
    setSessionModel: [],
    setSessionConfigOption: [],
    closeSession: [],
    prompts: [],
    requestHandlers: [],
  };
  const client = {
    calls,
    order,
    recentCapacitySignal: null,
    sessionHandlers: new Map(),
    async newSession(cwd, mcpServers) {
      order.push('newSession');
      calls.newSession.push({ cwd, mcpServers });
      return {
        sessionId: 'new-1',
        configOptions: [{ id: 'model', currentValue: 'default-profile', options: ['default-profile', 'gpt-5.6-sol'] }],
      };
    },
    async loadSession(sessionId, cwd, mcpServers) {
      order.push('loadSession');
      calls.loadSession.push({ sessionId, cwd, mcpServers });
      return { sessionId };
    },
    async setSessionModel(sessionId, modelId) {
      order.push('setSessionModel');
      calls.setSessionModel.push({ sessionId, modelId });
      if (failSetModel) throw new Error('set_model failed: unknown model profile');
    },
    async setSessionConfigOption(sessionId, configId, value) {
      order.push('setSessionConfigOption');
      calls.setSessionConfigOption.push({ sessionId, configId, value });
    },
    cancelSession() {},
    setSessionRequestHandler(sessionId, handler) {
      order.push(handler ? 'setSessionRequestHandler' : 'clearSessionRequestHandler');
      calls.requestHandlers.push({ sessionId, active: Boolean(handler) });
      if (handler) client.sessionHandlers.set(sessionId, handler);
      else client.sessionHandlers.delete(sessionId);
    },
    async closeSession(sessionId) {
      order.push('closeSession');
      calls.closeSession.push(sessionId);
      if (failClose) throw new Error('close failed: session already gone');
    },
    async *promptStream(sessionId, text) {
      order.push('promptStream');
      calls.prompts.push({ sessionId, text });
      if (client.testOnPrompt) await client.testOnPrompt(sessionId);
      for (const chunk of freshEvents) {
        yield { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } };
      }
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
  };
  return client;
}

function makePool(client) {
  return {
    remembered: [],
    async acquire(poolKey) {
      return { client, poolKey, release() {} };
    },
    rememberSession(_poolKey, sessionId) {
      this.remembered.push(sessionId);
    },
  };
}

function makeIcodeAdapter(pool, overrides = {}) {
  return new AcpAgentService({
    catId: 'icode',
    pool,
    poolKey: TEST_POOL_KEY,
    projectRoot: '/tmp',
    providerName: 'icode',
    protocolAdapter: 'icode',
    sessionModel: 'gpt-5.6-sol',
    ...overrides,
  });
}

async function drain(gen) {
  const messages = [];
  for await (const msg of gen) messages.push(msg);
  return messages;
}

describe('AcpAgentService iCode adapter (protocolAdapter: icode)', () => {
  it('selects the model via session/set_model with modelId, ignoring configOptions', async () => {
    const client = makeIcodeClient();
    const adapter = makeIcodeAdapter(makePool(client), { mcpServers: [STDIO_SERVER] });

    const messages = await drain(adapter.invoke('hello'));

    assert.equal(client.calls.setSessionModel.length, 1, 'must call setSessionModel exactly once');
    assert.deepEqual(client.calls.setSessionModel[0], { sessionId: 'new-1', modelId: 'gpt-5.6-sol' });
    assert.equal(
      client.calls.setSessionConfigOption.length,
      0,
      'icode adapter must not use session/set_config_option even when configOptions advertise a model',
    );
    assert.ok(!messages.some((m) => m.type === 'error'), 'successful turn must not emit errors');
  });

  it('routes cat-cafe family servers through the member gateway HTTP overlay on session/new', async () => {
    const client = makeIcodeClient();
    const adapter = makeIcodeAdapter(makePool(client), { mcpServers: [STDIO_SERVER, HTTP_SERVER, USER_STDIO_SERVER] });

    await drain(adapter.invoke('first turn', { callbackEnv: GATEWAY_ENV }));

    assert.equal(client.calls.newSession.length, 1);
    assert.deepEqual(
      client.calls.newSession[0].mcpServers,
      [HTTP_SERVER, gatewayOverlay('inv-turn-1', 'tok-turn-1')],
      'cat-cafe stdio must be routed via the gateway overlay; non-cat-cafe stdio dropped; remote externals kept',
    );
  });

  it('re-injects a fresh gateway overlay on session/load with the new turn credentials', async () => {
    const client = makeIcodeClient();
    const adapter = makeIcodeAdapter(makePool(client), { mcpServers: [STDIO_SERVER, HTTP_SERVER] });

    await drain(adapter.invoke('turn one', { callbackEnv: GATEWAY_ENV }));
    await drain(
      adapter.invoke('turn two', {
        sessionId: 'sess-prev',
        callbackEnv: { ...GATEWAY_ENV, CAT_CAFE_INVOCATION_ID: 'inv-turn-2', CAT_CAFE_CALLBACK_TOKEN: 'tok-turn-2' },
      }),
    );

    assert.equal(client.calls.loadSession.length, 1, 'resume must use session/load');
    assert.deepEqual(
      client.calls.loadSession[0].mcpServers,
      [HTTP_SERVER, gatewayOverlay('inv-turn-2', 'tok-turn-2')],
      'session/load must carry the fresh per-turn credentials — never the stale turn-1 token, never an empty overlay',
    );
    assert.equal(client.calls.newSession.length, 1, 'successful resume must not create a fresh session');
  });

  it('omits the gateway overlay when callback credentials are missing, without failing the turn', async () => {
    const client = makeIcodeClient();
    const adapter = makeIcodeAdapter(makePool(client), { mcpServers: [STDIO_SERVER, HTTP_SERVER] });

    const messages = await drain(adapter.invoke('no creds'));

    assert.deepEqual(
      client.calls.newSession[0].mcpServers,
      [HTTP_SERVER],
      'without credentials the gateway overlay cannot be built',
    );
    assert.ok(!messages.some((m) => m.type === 'error'), 'missing optional tooling must not fail the turn');
  });

  it('applies session/set_model after resume too, not only after session/new', async () => {
    const client = makeIcodeClient();
    const adapter = makeIcodeAdapter(makePool(client));

    await drain(adapter.invoke('resume turn', { sessionId: 'sess-prev' }));

    assert.equal(client.calls.loadSession.length, 1);
    assert.deepEqual(client.calls.setSessionModel, [{ sessionId: 'sess-prev', modelId: 'gpt-5.6-sol' }]);
    assert.equal(client.calls.setSessionConfigOption.length, 0);
  });

  it('surfaces model selection failure as an error instead of silently using the default model', async () => {
    const client = makeIcodeClient({ failSetModel: true });
    const adapter = makeIcodeAdapter(makePool(client));

    const messages = await drain(adapter.invoke('hello'));

    const error = messages.find((m) => m.type === 'error');
    assert.ok(error, 'set_model failure must yield an error event');
    assert.equal(error.errorCode, 'model_selection_failed');
    assert.match(error.error, /set_model failed/);
    assert.equal(client.calls.prompts.length, 0, 'no prompt may be sent on an unselected model');
    assert.deepEqual(client.calls.closeSession, ['new-1'], 'the half-configured session instance must be closed');
    assert.equal(messages[messages.length - 1].type, 'done');
  });

  it('closes the live session instance once per turn, after the prompt finishes', async () => {
    const client = makeIcodeClient();
    const adapter = makeIcodeAdapter(makePool(client));

    await drain(adapter.invoke('hello'));

    assert.deepEqual(client.order, ['newSession', 'setSessionModel', 'promptStream', 'closeSession']);
    assert.deepEqual(client.calls.closeSession, ['new-1']);
  });

  it('tolerates best-effort session/close failures without failing the turn', async () => {
    const client = makeIcodeClient({ failClose: true });
    const adapter = makeIcodeAdapter(makePool(client));

    const messages = await drain(adapter.invoke('hello'));

    assert.deepEqual(client.calls.closeSession, ['new-1'], 'close must still be attempted');
    assert.ok(!messages.some((m) => m.type === 'error'), 'a failed best-effort close must not fail the completed turn');
  });

  it('leaves non-icode members on the existing path: set_config_option model, no per-turn close', async () => {
    const client = makeIcodeClient();
    const pool = makePool(client);
    const adapter = new AcpAgentService({
      catId: 'gemini',
      pool,
      poolKey: TEST_POOL_KEY,
      projectRoot: '/tmp',
      providerName: 'gemini',
      sessionModel: 'gpt-5.6-sol',
      mcpServers: [STDIO_SERVER],
    });

    const messages = await drain(adapter.invoke('hello'));

    assert.equal(client.calls.setSessionModel.length, 0, 'generic path must not call session/set_model');
    assert.equal(client.calls.closeSession.length, 0, 'generic path must not close the session per turn');
    assert.deepEqual(
      client.calls.setSessionConfigOption,
      [{ sessionId: 'new-1', configId: 'model', value: 'gpt-5.6-sol' }],
      'generic path keeps configOptions-based model selection',
    );
    assert.ok(!messages.some((m) => m.type === 'error'));
  });

  it('bridges _chrys/request_input onto the runtime interaction port during the turn', async () => {
    const portRequests = [];
    const runtimeInteractionPort = {
      async request(request) {
        portRequests.push(request);
        return { kind: 'answers', answers: { q0: ['A', 'B'], q1: [] } };
      },
      async invalidateInvocation() {
        return [];
      },
    };
    const client = makeIcodeClient();
    let handlerResult = null;
    client.testOnPrompt = async (sessionId) => {
      const handler = client.sessionHandlers.get(sessionId);
      assert.ok(handler, 'request_input handler must be registered before the prompt runs');
      handlerResult = await handler({
        id: 'ask-1',
        params: {
          sessionId,
          questions: [
            { header: 'Choice', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
            { question: 'More?' },
          ],
        },
      });
    };
    const adapter = makeIcodeAdapter(makePool(client));

    await drain(
      adapter.invoke('hello', {
        runtimeInteractionPort,
        auditContext: { invocationId: 'inv-1', threadId: 'th-1', userId: 'u-1', catId: 'icode' },
      }),
    );

    assert.equal(portRequests.length, 1);
    assert.equal(portRequests[0].kind, 'question');
    assert.deepEqual(portRequests[0].owner, { userId: 'u-1', threadId: 'th-1', catId: 'icode', invocationId: 'inv-1' });
    assert.equal(portRequests[0].provider.method, '_chrys/request_input');
    assert.deepEqual(handlerResult, {
      cancelled: false,
      answers: [
        { values: ['A', 'B'], note: '' },
        { values: [], note: '' },
      ],
    });
    assert.equal(client.sessionHandlers.size, 0, 'the bridge must be cleared when the turn ends');
    assert.deepEqual(client.calls.requestHandlers, [
      { sessionId: 'new-1', active: true },
      { sessionId: 'new-1', active: false },
    ]);
  });

  it('invalidates pending request_input interactions when the turn ends while one is unanswered', async () => {
    const invalidations = [];
    let rejectPending;
    const runtimeInteractionPort = {
      request: () =>
        new Promise((_resolve, reject) => {
          rejectPending = reject;
        }),
      async invalidateInvocation(invocationId, reasonCode) {
        invalidations.push({ invocationId, reasonCode });
        rejectPending(new RuntimeInteractionError('stale', 'provider_cancelled', 'provider_cancelled'));
        return [];
      },
    };
    const client = makeIcodeClient();
    let pendingHandler = null;
    client.testOnPrompt = (sessionId) => {
      const handler = client.sessionHandlers.get(sessionId);
      assert.ok(handler, 'request_input handler must be registered before the prompt runs');
      pendingHandler = handler({ id: 'ask-9', params: { sessionId, questions: [{ question: 'Waiting?' }] } });
    };
    const adapter = makeIcodeAdapter(makePool(client));

    await drain(
      adapter.invoke('hello', {
        runtimeInteractionPort,
        auditContext: { invocationId: 'inv-2', threadId: 'th-1', userId: 'u-1', catId: 'icode' },
      }),
    );

    assert.deepEqual(invalidations, [{ invocationId: 'inv-2', reasonCode: 'provider_cancelled' }]);
    assert.deepEqual(await pendingHandler, { cancelled: true });
  });

  it('rebinds the request_input bridge to the replacement session on the zero-event retry path', async () => {
    const portRequests = [];
    const runtimeInteractionPort = {
      async request(request) {
        portRequests.push(request);
        return { kind: 'answers', answers: { q0: ['A'] } };
      },
      async invalidateInvocation() {
        return [];
      },
    };
    const client = makeIcodeClient({ freshEvents: [] });
    let handlerResult = null;
    client.testOnPrompt = async (sessionId) => {
      // The first (resumed) stream stays silent to trigger #1091; only the
      // replacement session asks the human.
      if (sessionId !== 'new-1') return;
      const handler = client.sessionHandlers.get(sessionId);
      assert.ok(handler, 'the bridge must be rebound to the replacement session');
      handlerResult = await handler({
        id: 'ask-retry',
        params: { sessionId, questions: [{ question: 'Retry path question?' }] },
      });
    };
    const adapter = makeIcodeAdapter(makePool(client));

    await drain(
      adapter.invoke('hello', {
        sessionId: 'sess-prev',
        runtimeInteractionPort,
        auditContext: { invocationId: 'inv-retry', threadId: 'th-1', userId: 'u-1', catId: 'icode' },
      }),
    );

    assert.equal(portRequests.length, 1, 'the replacement session must reach the interaction port');
    assert.equal(portRequests[0].provider.threadId, 'new-1', 'the bridge must follow the replacement session');
    assert.deepEqual(handlerResult, { cancelled: false, answers: [{ values: ['A'], note: '' }] });
    assert.equal(client.sessionHandlers.has('sess-prev'), false, 'the replaced session handler must be cleared');
    assert.equal(client.sessionHandlers.size, 0, 'the fresh handler must be cleared when the turn ends');
    assert.deepEqual(
      client.calls.closeSession,
      ['sess-prev', 'new-1'],
      'the replaced and the fresh session instance must both close',
    );
    assert.deepEqual(client.calls.requestHandlers, [
      { sessionId: 'sess-prev', active: true },
      { sessionId: 'sess-prev', active: false },
      { sessionId: 'new-1', active: true },
      { sessionId: 'new-1', active: false },
    ]);
    assert.deepEqual(
      client.calls.prompts.map((entry) => entry.sessionId),
      ['sess-prev', 'new-1'],
      'the retry must prompt the replacement session',
    );
  });
});

describe('AcpServiceFactory protocolAdapter wiring', () => {
  function makeBaseInput(projectRoot, profileId, poolRegistry, overrides = {}) {
    return {
      projectRoot,
      profileId,
      effectiveModel: 'gpt-5.6-sol',
      config: {
        id: profileId,
        name: 'iCode ACP',
        displayName: 'iCode ACP',
        color: { primary: '#111827', secondary: '#e5e7eb' },
        avatar: '/avatars/default.png',
        mentionPatterns: [`@${profileId}`],
        roleDescription: 'iCode adapter test member',
        clientId: 'acp',
        provider: undefined,
        defaultModel: 'gpt-5.6-sol',
        mcpSupport: false,
      },
      poolRegistry,
      log: { info() {}, warn() {} },
      ...overrides,
    };
  }

  it('threads protocolAdapter=icode into the service and fail-closed permissions into the client', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-icode-factory-'));
    const profileId = 'icode-factory';
    const poolRegistry = new Map();

    try {
      const service = await createAcpServiceForConfig(
        makeBaseInput(projectRoot, profileId, poolRegistry, {
          acpConfig: {
            command: 'mock-acp',
            startupArgs: ['acp'],
            protocolAdapter: 'icode',
            modelProfileId: 'profile-sol',
          },
        }),
      );

      assert.ok(service, 'factory must produce a service for a valid icode member');
      assert.equal(service.protocolAdapter, 'icode');
      assert.equal(
        service.sessionModel,
        'profile-sol',
        'modelProfileId is the set_model target, not the display model',
      );
      const client = poolRegistry.get(profileId).clientFactory();
      // No client-wide handler: requests fall through to the client's fail-closed default.
      assert.equal(client.config.permissionHandler, undefined);
      assert.equal('defaultPermissionDecision' in client.config, false, 'there is no allow default to opt out of');
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects icode members without modelProfileId instead of using the display model', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-icode-model-profile-'));
    const profileId = 'icode-no-profile';
    const poolRegistry = new Map();
    const unavailable = [];

    try {
      const service = await createAcpServiceForConfig(
        makeBaseInput(projectRoot, profileId, poolRegistry, {
          acpConfig: { command: 'mock-acp', startupArgs: ['acp'], protocolAdapter: 'icode' },
          onUnavailable: (info) => unavailable.push(info),
        }),
      );

      assert.equal(service, null, 'an iCode member without a model profile must not register');
      assert.equal(unavailable[0]?.code, 'icode-missing-model-profile');
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('ignores acp.autoApprove for iCode members (reject-only adapter)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-icode-auto-approve-'));
    const profileId = 'icode-auto-approve';
    const poolRegistry = new Map();
    try {
      const service = await createAcpServiceForConfig(
        makeBaseInput(projectRoot, profileId, poolRegistry, {
          acpConfig: {
            command: 'mock-acp',
            startupArgs: ['acp'],
            protocolAdapter: 'icode',
            modelProfileId: 'profile-sol',
            autoApprove: true,
          },
        }),
      );
      assert.ok(service);
      assert.equal(service.autoApprove, false);
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('threads an explicit acp.autoApprove into generic members only when set', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-generic-auto-approve-'));
    const poolRegistry = new Map();
    try {
      const optedIn = await createAcpServiceForConfig(
        makeBaseInput(projectRoot, 'generic-opted-in', poolRegistry, {
          acpConfig: { command: 'mock-acp', startupArgs: ['acp'], autoApprove: true },
        }),
      );
      const defaulted = await createAcpServiceForConfig(
        makeBaseInput(projectRoot, 'generic-default', poolRegistry, {
          acpConfig: { command: 'mock-acp', startupArgs: ['acp'] },
        }),
      );
      assert.equal(optedIn.autoApprove, true);
      assert.equal(defaulted.autoApprove, false);
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps default members on the generic path: no adapter field, no client-wide handler', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-default-factory-'));
    const profileId = 'acp-default-factory';
    const poolRegistry = new Map();

    try {
      const service = await createAcpServiceForConfig(
        makeBaseInput(projectRoot, profileId, poolRegistry, {
          acpConfig: { command: 'mock-acp', startupArgs: ['acp'] },
        }),
      );

      assert.ok(service);
      assert.equal(service.protocolAdapter, undefined);
      const client = poolRegistry.get(profileId).clientFactory();
      assert.equal(client.config.permissionHandler, undefined);
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects icode members on httpstream transport with an explicit reason', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-icode-httpstream-'));
    const profileId = 'icode-httpstream';
    const poolRegistry = new Map();
    const unavailable = [];

    try {
      const service = await createAcpServiceForConfig(
        makeBaseInput(projectRoot, profileId, poolRegistry, {
          acpConfig: {
            command: 'mock-acp',
            startupArgs: ['acp'],
            transport: 'httpstream',
            experimental: true,
            protocolAdapter: 'icode',
          },
          onUnavailable: (info) => unavailable.push(info),
        }),
      );

      assert.equal(service, null, 'icode + httpstream must not register');
      assert.equal(unavailable[0]?.code, 'icode-requires-stdio');
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll?.()));
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('AcpPoolSpawnSignature protocolAdapter', () => {
  it('includes protocolAdapter in the signature so adapter changes rebuild the pool', () => {
    const base = {
      command: 'icode',
      args: ['acp'],
      cwd: '/tmp',
      maxLiveProcesses: 3,
      idleTtlMs: 60000,
    };
    const generic = JSON.parse(createAcpPoolSpawnSignature(base));
    const icode = JSON.parse(createAcpPoolSpawnSignature({ ...base, protocolAdapter: 'icode' }));

    assert.equal(generic.protocolAdapter, null);
    assert.equal(icode.protocolAdapter, 'icode');
    assert.notEqual(
      createAcpPoolSpawnSignature(base),
      createAcpPoolSpawnSignature({ ...base, protocolAdapter: 'icode' }),
    );
  });
});
