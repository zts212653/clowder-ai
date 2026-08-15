import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { catRegistry } from '@cat-cafe/shared';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';

function ensureGptProRegistered() {
  if (catRegistry.has('gpt-pro')) return;
  catRegistry.register('gpt-pro', {
    catId: 'gpt-pro',
    clientId: 'openai',
    provider: 'openai-chatgpt-pro',
    avatar: '/avatars/gpt-pro.png',
  });
}

function makeThreadStore() {
  return {
    get: async () => ({ id: 'thread-f247', title: 'F247 live probe', participants: ['codex-sol', 'gpt-pro'] }),
    getCloudCatBindings: async () => ({ 'gpt-pro': 'https://chatgpt.com/c/conversation-7' }),
    updateCloudCatBinding: async () => undefined,
  };
}

function makeDispositionRecorder() {
  const calls = [];
  return {
    calls,
    complete: async (auth, disposition) => {
      calls.push({ auth, disposition });
      return {
        outcome: 'applied',
        disposition,
        invocationId: auth.invocationId,
        sourceMessageId: auth.a2aTriggerMessageId,
        fromCatId: 'codex-sol',
      };
    },
  };
}

async function drain(generator) {
  const messages = [];
  for await (const message of generator) messages.push(message);
  return messages;
}

function makeParallelDeps({ bridge, disposition }) {
  let messageSeq = 0;
  return {
    services: {
      'gpt-pro': {
        usesChainKeyResume: () => false,
        freshnessCarrierCapability: () => ({
          provider: 'other',
          carrier: 'other',
          deliverySemantics: 'undeclared',
        }),
        // biome-ignore lint/correctness/useYield: fail-fast sentinel for an unreachable provider path.
        async *invoke() {
          throw new Error('cloud-only route must not invoke the provider CLI');
        },
      },
    },
    invocationDeps: {
      registry: new InvocationRegistry(),
      sessionManager: {},
      threadStore: makeThreadStore(),
      apiUrl: 'http://localhost:0',
      cloudInvokeBridge: bridge,
      a2aDispatchDispositionService: disposition,
    },
    messageStore: {
      append: async (message) => ({
        id: `parallel-message-${++messageSeq}`,
        threadId: message.threadId ?? 'thread-f247',
        ...message,
      }),
      getById: async () => null,
      getRecent: async () => [],
      getMentionsFor: async () => [],
      getRecentMentionsFor: async () => [],
      getByThread: async () => [],
      getByThreadBefore: async () => [],
      getByThreadAfter: async () => [],
    },
    socketManager: { broadcastToRoom: () => {} },
    draftStore: {
      delete: async () => undefined,
      touch: async () => undefined,
      upsert: async () => undefined,
    },
  };
}

const baseParams = {
  catId: 'gpt-pro',
  service: {
    usesChainKeyResume: () => false,
    freshnessCarrierCapability: () => ({
      provider: 'other',
      carrier: 'other',
      deliverySemantics: 'undeclared',
    }),
  },
  prompt: 'orchestrated prompt',
  mentionContent: '@gpt-pro verify the live bridge',
  mentioningCatId: 'codex-sol',
  userId: 'alice',
  ownerAuthProvenance: 'strict',
  threadId: 'thread-f247',
  isLastCat: true,
  parentInvocationId: 'parent-invocation',
  a2aTriggerMessageId: 'source-message-9',
  executionCausal: { triggerMessageId: 'source-message-9' },
  promptMessageIds: ['source-message-9'],
};

describe('F247 cloud runtime terminal contract', () => {
  it('waits for the Host bridge outcome, exposes one readable fallback, and terminalizes the exact A2A carrier', async () => {
    ensureGptProRegistered();
    let releaseBridge;
    const bridgeOutcome = new Promise((resolve) => {
      releaseBridge = resolve;
    });
    const disposition = makeDispositionRecorder();
    const bridgeCalls = [];
    const exposed = [];
    let settled = false;
    const result = drain(
      invokeSingleCat(
        {
          registry: new InvocationRegistry(),
          sessionManager: {},
          threadStore: makeThreadStore(),
          apiUrl: 'http://localhost:0',
          cloudInvokeBridge: {
            dispatch: async (params) => {
              bridgeCalls.push(params);
              return bridgeOutcome;
            },
          },
          a2aDispatchDispositionService: disposition,
        },
        {
          ...baseParams,
          onPromptMessagesExposed: async (input) => exposed.push(input),
        },
      ),
    ).then((messages) => {
      settled = true;
      return messages;
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'the invocation must not finish before the bridge has a terminal outcome');

    releaseBridge({
      kind: 'fallback',
      reason: 'no-adapter',
      detail: 'No configured personal Chrome Host Adapter',
    });
    const messages = await result;

    assert.equal(bridgeCalls.length, 1);
    assert.equal(bridgeCalls[0].idempotencyKey, 'source-message-9');
    const created = messages.find(
      (message) => message.type === 'system_info' && message.content?.includes('invocation_created'),
    );
    assert.ok(created, 'cloud delivery must have a durable child invocation identity');
    const createdPayload = JSON.parse(created.content);
    assert.equal(exposed.length, 1);
    assert.equal(exposed[0].invocationId, createdPayload.invocationId);

    const visible = messages.filter((message) => {
      if (message.type !== 'system_info' || !message.content) return false;
      return JSON.parse(message.content).type === 'cloud_bridge_status';
    });
    assert.equal(visible.length, 1, 'one bridge attempt produces one user-visible status');
    assert.deepEqual(JSON.parse(visible[0].content), {
      type: 'cloud_bridge_status',
      catId: 'gpt-pro',
      status: 'unavailable',
      reason: 'no-adapter',
      message:
        '未发送给 @gpt-pro：还没有可用的后台 Host Adapter。请先安装并配对 Chrome 扩展，再绑定目标 ChatGPT 会话；前台自动化保持关闭。',
      detail: 'No configured personal Chrome Host Adapter',
    });

    assert.equal(disposition.calls.length, 1);
    assert.equal(disposition.calls[0].disposition, 'completed');
    assert.deepEqual(
      {
        invocationId: disposition.calls[0].auth.invocationId,
        catId: disposition.calls[0].auth.catId,
        threadId: disposition.calls[0].auth.threadId,
        a2aTriggerMessageId: disposition.calls[0].auth.a2aTriggerMessageId,
        originTriggerMessageId: disposition.calls[0].auth.originTriggerMessageId,
      },
      {
        invocationId: createdPayload.invocationId,
        catId: 'gpt-pro',
        threadId: 'thread-f247',
        a2aTriggerMessageId: 'source-message-9',
        originTriggerMessageId: 'source-message-9',
      },
    );
    const done = messages.find((message) => message.type === 'done');
    assert.equal(done.invocationId, createdPayload.invocationId);
    assert.equal(done.errorCode, undefined);
  });

  it('reports a real Host receipt as sent and still closes the source carrier exactly once', async () => {
    ensureGptProRegistered();
    const disposition = makeDispositionRecorder();
    const messages = await drain(
      invokeSingleCat(
        {
          registry: new InvocationRegistry(),
          sessionManager: {},
          threadStore: makeThreadStore(),
          apiUrl: 'http://localhost:0',
          cloudInvokeBridge: {
            dispatch: async () => ({
              kind: 'sent',
              capturedUrl: 'https://chatgpt.com/c/conversation-7',
              transport: 'host',
              hostMessageId: 'chatgpt-user-message-42',
            }),
          },
          a2aDispatchDispositionService: disposition,
        },
        {
          ...baseParams,
          executionCausal: undefined,
        },
      ),
    );

    const status = messages
      .filter((message) => message.type === 'system_info' && message.content)
      .map((message) => JSON.parse(message.content))
      .find((payload) => payload.type === 'cloud_bridge_status');
    assert.deepEqual(status, {
      type: 'cloud_bridge_status',
      catId: 'gpt-pro',
      status: 'sent',
      message: '已发送给 @gpt-pro，等待它从 ChatGPT 云端会话回写。',
      transport: 'host',
      hostMessageId: 'chatgpt-user-message-42',
    });
    assert.equal(disposition.calls.length, 1);
    assert.equal(disposition.calls[0].disposition, 'completed');
    assert.equal(disposition.calls[0].auth.originTriggerMessageId, 'source-message-9');
  });

  it('preserves the exact A2A source and caller through a parallel cloud route', async () => {
    ensureGptProRegistered();
    const disposition = makeDispositionRecorder();
    const bridgeCalls = [];
    const messages = await drain(
      routeParallel(
        makeParallelDeps({
          bridge: {
            dispatch: async (params) => {
              bridgeCalls.push(params);
              return { kind: 'fallback', reason: 'no-adapter', detail: 'host unavailable' };
            },
          },
          disposition,
        }),
        ['gpt-pro'],
        '@gpt-pro inspect the exact carrier',
        'alice',
        'thread-f247',
        {
          currentUserMessageId: 'queue-envelope-4',
          a2aTriggerMessageId: 'source-message-parallel-4',
          a2aCallerCatId: 'codex-sol',
          parentInvocationId: 'parallel-parent-4',
        },
      ),
    );

    assert.equal(bridgeCalls.length, 1);
    assert.equal(bridgeCalls[0].calledBy, 'codex-sol');
    assert.equal(bridgeCalls[0].idempotencyKey, 'source-message-parallel-4');
    assert.equal(disposition.calls.length, 1);
    assert.equal(disposition.calls[0].auth.a2aTriggerMessageId, 'source-message-parallel-4');
    assert.equal(disposition.calls[0].auth.originTriggerMessageId, 'source-message-parallel-4');
    assert.equal(messages.filter((message) => message.type === 'done').length, 1);
  });

  it('fails closed but still settles an A2A trigger whose caller identity is absent', async () => {
    ensureGptProRegistered();
    const disposition = makeDispositionRecorder();
    const bridgeCalls = [];
    const messages = await drain(
      routeParallel(
        makeParallelDeps({
          bridge: {
            dispatch: async (params) => {
              bridgeCalls.push(params);
              return { kind: 'sent', capturedUrl: 'https://chatgpt.com/c/should-not-send' };
            },
          },
          disposition,
        }),
        ['gpt-pro'],
        '@gpt-pro caller provenance is missing',
        'alice',
        'thread-f247',
        {
          currentUserMessageId: 'queue-envelope-5',
          a2aTriggerMessageId: 'source-message-parallel-5',
          parentInvocationId: 'parallel-parent-5',
        },
      ),
    );

    assert.equal(bridgeCalls.length, 0, 'must not misattribute an A2A call to the thread owner');
    assert.equal(disposition.calls.length, 1);
    assert.equal(disposition.calls[0].auth.a2aTriggerMessageId, 'source-message-parallel-5');
    const status = messages
      .filter((message) => message.type === 'system_info' && message.content)
      .map((message) => JSON.parse(message.content))
      .find((payload) => payload.type === 'cloud_bridge_status');
    assert.equal(status.status, 'unavailable');
    assert.match(status.detail, /provenance was incomplete/);
    assert.equal(messages.filter((message) => message.type === 'done').length, 1);
  });

  it('degrades a thread metadata read failure without skipping cloud status or exact disposition', async () => {
    ensureGptProRegistered();
    const disposition = makeDispositionRecorder();
    const bridgeCalls = [];
    const messages = await drain(
      invokeSingleCat(
        {
          registry: new InvocationRegistry(),
          sessionManager: {},
          threadStore: {
            ...makeThreadStore(),
            get: async () => {
              throw new Error('thread metadata unavailable');
            },
          },
          apiUrl: 'http://localhost:0',
          cloudInvokeBridge: {
            dispatch: async (params) => {
              bridgeCalls.push(params);
              return { kind: 'fallback', reason: 'no-adapter', detail: 'host unavailable' };
            },
          },
          a2aDispatchDispositionService: disposition,
        },
        baseParams,
      ),
    );

    assert.equal(bridgeCalls.length, 1);
    assert.equal(bridgeCalls[0].threadTitle, null);
    assert.deepEqual(bridgeCalls[0].participants, []);
    assert.equal(disposition.calls.length, 1);
    assert.equal(disposition.calls[0].auth.a2aTriggerMessageId, 'source-message-9');
    const statuses = messages
      .filter((message) => message.type === 'system_info' && message.content)
      .map((message) => JSON.parse(message.content))
      .filter((payload) => payload.type === 'cloud_bridge_status');
    assert.equal(statuses.length, 1);
    assert.equal(messages.filter((message) => message.type === 'done').length, 1);
    assert.equal(
      messages.some((message) => message.type === 'error'),
      false,
    );
  });
});
