/**
 * C09 — ACP permission requests are only granted by an explicit authority.
 * No owner, an unreachable/failed owner and an explicit human decline never
 * become an allow; a member's explicit autoApprove grants within its scope.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { createAcpPermissionHandler, failClosedPermissionResult } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/acp-permission-policy.js'
);
const { RuntimeInteractionError } = await import('../../dist/domains/runtime-interaction/RuntimeInteractionError.js');
const { AcpAgentService } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');

const OWNER = { userId: 'u1', threadId: 't1', catId: 'kimi', invocationId: 'inv-1' };
const OPTIONS = [
  { optionId: 'approve_for_session', name: 'Always', kind: 'allow_always' },
  { optionId: 'approve', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
];

function request(options = OPTIONS) {
  return {
    jsonrpc: '2.0',
    id: 'perm-1',
    method: 'session/request_permission',
    params: { sessionId: 'native-1', toolCall: { title: 'write_file', kind: 'edit' }, options },
  };
}

async function decide(handler, req = request()) {
  let answer;
  await handler(req, (result) => {
    answer = result;
  });
  return answer;
}

function baseInput(overrides = {}) {
  return { catId: 'kimi', providerId: 'kimi', sessionId: 'native-1', autoApprove: false, ...overrides };
}

describe('ACP permission policy (C09)', () => {
  it('fails closed without an approval owner', async () => {
    assert.deepEqual(await decide(createAcpPermissionHandler(baseInput())), { optionId: 'deny' });
    assert.deepEqual(
      await decide(createAcpPermissionHandler(baseInput({ port: { request: async () => assert.fail('no owner') } }))),
      { optionId: 'deny' },
      'a port without an owner identity is not an approval owner',
    );
  });

  it('answers cancelled when no reject option exists, never an allow', async () => {
    const handler = createAcpPermissionHandler(baseInput());
    assert.deepEqual(await decide(handler, request([OPTIONS[0], OPTIONS[1]])), { cancelled: true });
    assert.deepEqual(failClosedPermissionResult({ options: [] }), { cancelled: true });
    assert.deepEqual(failClosedPermissionResult(undefined), { cancelled: true });
  });

  it('routes to the approval owner and maps ACP options onto approval decisions', async () => {
    let seen;
    const port = {
      request: async (req) => {
        seen = req;
        return { kind: 'decision', decisionId: 'approve' };
      },
    };
    const answer = await decide(createAcpPermissionHandler(baseInput({ port, owner: OWNER })));
    assert.deepEqual(answer, { optionId: 'approve' });
    assert.equal(seen.kind, 'approval');
    assert.deepEqual(seen.owner, OWNER);
    assert.equal(seen.provider.method, 'session/request_permission');
    assert.equal(seen.provider.requestId, 'perm-1');
    assert.equal(seen.provider.threadId, 'native-1');
    assert.deepEqual(
      seen.decisions.map((d) => [d.id, d.outcome]),
      [
        ['approve_for_session', 'accept'],
        ['approve', 'accept'],
        ['deny', 'decline'],
      ],
    );
  });

  it('adds a cancel decision when the agent offers only allow options', async () => {
    let seen;
    const port = {
      request: async (req) => {
        seen = req;
        return { kind: 'decision', decisionId: '__cancel__' };
      },
    };
    const answer = await decide(createAcpPermissionHandler(baseInput({ port, owner: OWNER })), request([OPTIONS[1]]));
    assert.ok(seen.decisions.some((d) => d.outcome === 'cancel'));
    assert.deepEqual(answer, { cancelled: true });
  });

  it('keeps an explicit human decline as a reject', async () => {
    const port = { request: async () => ({ kind: 'decision', decisionId: 'deny' }) };
    assert.deepEqual(await decide(createAcpPermissionHandler(baseInput({ port, owner: OWNER }))), { optionId: 'deny' });
  });

  for (const [name, failure] of [
    ['unreachable owner', new RuntimeInteractionError('unavailable', 'down', 'confirmation_unavailable')],
    ['timeout', new RuntimeInteractionError('stale', 'expired', 'expired')],
    ['generic failure', new Error('socket closed')],
  ]) {
    it(`fails closed on ${name}`, async () => {
      const port = {
        request: async () => {
          throw failure;
        },
      };
      assert.deepEqual(await decide(createAcpPermissionHandler(baseInput({ port, owner: OWNER }))), {
        optionId: 'deny',
      });
    });
  }

  it('fails closed on a malformed approval response', async () => {
    const port = { request: async () => ({ kind: 'answers', answers: {} }) };
    assert.deepEqual(await decide(createAcpPermissionHandler(baseInput({ port, owner: OWNER }))), { optionId: 'deny' });
  });

  it('member autoApprove grants once without asking the owner', async () => {
    const port = { request: async () => assert.fail('autoApprove must not open an approval card') };
    const handler = createAcpPermissionHandler(baseInput({ autoApprove: true, port, owner: OWNER }));
    assert.deepEqual(await decide(handler), { optionId: 'approve' }, 'allow_once preferred over allow_always');
    assert.deepEqual(await decide(handler, request([OPTIONS[0]])), { optionId: 'approve_for_session' });
    assert.deepEqual(await decide(handler, request([OPTIONS[2]])), { optionId: 'deny' }, 'no allow → still deny');
  });
});

/** Fake ACP client: during the prompt, the agent asks for one permission. */
function makePermissionAskingClient() {
  const client = {
    handlers: new Map(),
    installs: [],
    answers: [],
    recentCapacitySignal: null,
    async newSession() {
      return { sessionId: 'native-1' };
    },
    setSessionPermissionHandler(sessionId, handler) {
      client.installs.push({ sessionId, active: Boolean(handler) });
      if (handler) client.handlers.set(sessionId, handler);
      else client.handlers.delete(sessionId);
    },
    cancelSession() {},
    async *promptStream(sessionId) {
      const handler = client.handlers.get(sessionId);
      if (handler) {
        await handler(request(), (answer) => client.answers.push(answer));
      } else {
        client.answers.push({ clientDefault: true });
      }
      yield { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } };
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
  };
  return client;
}

function makeService(client, overrides = {}) {
  return new AcpAgentService({
    catId: 'kimi',
    pool: { acquire: async () => ({ client, release() {} }), rememberSession() {} },
    poolKey: { projectPath: '/tmp', providerProfile: 'test' },
    projectRoot: '/tmp',
    providerName: 'kimi',
    mcpServers: [],
    ...overrides,
  });
}

async function drainInvoke(service, options) {
  const messages = [];
  for await (const message of service.invoke('hello', options)) messages.push(message);
  return messages;
}

const AUDIT = { invocationId: 'inv-1', executionId: 'inv-1', threadId: 't1', userId: 'u1', catId: 'kimi' };

describe('AcpAgentService permission policy wiring (C09)', () => {
  it('routes a generic member to the invocation owner and clears the handler after the turn', async () => {
    const client = makePermissionAskingClient();
    const requests = [];
    const runtimeInteractionPort = {
      request: async (req) => {
        requests.push(req);
        return { kind: 'decision', decisionId: 'deny' };
      },
      invalidateInvocation: async () => [],
      pendingConversationDecisionPrompt: async () => '',
    };
    await drainInvoke(makeService(client), { runtimeInteractionPort, auditContext: AUDIT });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].owner, OWNER);
    assert.deepEqual(client.answers, [{ optionId: 'deny' }]);
    assert.deepEqual(client.installs, [
      { sessionId: 'native-1', active: true },
      { sessionId: 'native-1', active: false },
    ]);
  });

  it('fails closed for a generic member invoked without an approval owner', async () => {
    const client = makePermissionAskingClient();
    await drainInvoke(makeService(client), { auditContext: AUDIT });
    assert.deepEqual(client.answers, [{ optionId: 'deny' }]);
  });

  it('honors explicit member autoApprove without an owner', async () => {
    const client = makePermissionAskingClient();
    await drainInvoke(makeService(client, { autoApprove: true }), {});
    assert.deepEqual(client.answers, [{ optionId: 'approve' }]);
  });

  it('leaves iCode on the client fail-closed default (no session approval handler)', async () => {
    const client = makePermissionAskingClient();
    client.setSessionModel = async () => {};
    client.closeSession = async () => {};
    client.setSessionRequestHandler = () => {};
    await drainInvoke(makeService(client, { protocolAdapter: 'icode', sessionModel: 'profile', autoApprove: true }), {
      auditContext: AUDIT,
    });
    assert.deepEqual(client.answers, [{ clientDefault: true }]);
    assert.deepEqual(client.installs, []);
  });
});

describe('ACP permission policy against the real RuntimeInteractionService (review P2-1/P2-2)', async () => {
  const { RuntimeInteractionService } = await import(
    '../../dist/domains/runtime-interaction/RuntimeInteractionService.js'
  );
  const { InMemoryRuntimeInteractionStore } = await import(
    '../../dist/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js'
  );
  const realService = () => {
    const store = new InMemoryRuntimeInteractionStore();
    const service = new RuntimeInteractionService({
      store,
      hostEpoch: 'host-epoch-1',
      now: () => 1_777_000_000_100,
      cardPublisher: {
        prepare: async (request) => ({ threadId: 't1', messageId: 'm1', blockId: `ri:${request.interactionId}` }),
        publish: async () => {},
        isLive: async () => true,
      },
    });
    return { store, service };
  };
  const pending = async (store, id) => {
    for (let i = 0; i < 50; i += 1) {
      const record = await store.get(id);
      if (record?.status === 'pending') return record;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.fail(`interaction ${id} never became pending`);
  };

  it('a second request in the same invocation waits for the first card instead of being auto-denied', async () => {
    const { store, service } = realService();
    let n = 0;
    const handler = createAcpPermissionHandler(
      baseInput({ port: service, owner: OWNER, createInteractionId: () => `ix-${++n}` }),
    );
    const answers = [];
    const first = handler({ ...request(), id: 'p1' }, (answer) => answers.push(['p1', answer]));
    const second = handler({ ...request(), id: 'p2' }, (answer) => answers.push(['p2', answer]));
    const card1 = await pending(store, 'ix-1');
    await service.respond({
      interactionId: 'ix-1',
      ownerUserId: 'u1',
      cardRef: card1.cardRef,
      response: { kind: 'decision', decisionId: 'approve' },
    });
    await first;
    const card2 = await pending(store, 'ix-2');
    await service.respond({
      interactionId: 'ix-2',
      ownerUserId: 'u1',
      cardRef: card2.cardRef,
      response: { kind: 'decision', decisionId: 'deny' },
    });
    await second;
    assert.deepEqual(answers, [
      ['p1', { optionId: 'approve' }],
      ['p2', { optionId: 'deny' }],
    ]);
  });

  it('an unanswered card times out, is invalidated, and the request fails closed', async () => {
    const { store, service } = realService();
    const handler = createAcpPermissionHandler(
      baseInput({ port: service, owner: OWNER, approvalTimeoutMs: 30, createInteractionId: () => 'ix-timeout' }),
    );
    let answer;
    await handler(request(), (value) => {
      answer = value;
    });
    assert.deepEqual(answer, { optionId: 'deny' });
    assert.notEqual((await store.get('ix-timeout'))?.status, 'pending', 'no orphaned card outlives the request');
  });
});
