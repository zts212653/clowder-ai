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

async function drain(generator) {
  const messages = [];
  for await (const message of generator) messages.push(message);
  return messages;
}

function makeParallelDeps({ bridge }) {
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
      cloudReturnGrantStore: { issue: async () => ({ ok: true, status: 'issued' }) },
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
  it('keeps an A2A needs-binding outcome terminally completed instead of exposing direct-user retry semantics', async () => {
    ensureGptProRegistered();
    const messages = await drain(
      invokeSingleCat(
        {
          registry: new InvocationRegistry(),
          sessionManager: {},
          threadStore: makeThreadStore(),
          apiUrl: 'http://localhost:0',
          cloudInvokeBridge: {
            dispatch: async () => ({ kind: 'fallback', reason: 'needs-binding', detail: 'route absent' }),
          },
          cloudReturnGrantStore: { issue: async () => ({ ok: true, status: 'issued' }) },
        },
        baseParams,
      ),
    );

    assert.equal(messages.at(-1).type, 'done');
    assert.equal(messages.at(-1).errorCode, undefined);
  });

  it('waits for the Host bridge outcome and exposes one readable fallback before normal lifecycle completion', async () => {
    ensureGptProRegistered();
    let releaseBridge;
    const bridgeOutcome = new Promise((resolve) => {
      releaseBridge = resolve;
    });
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
          cloudReturnGrantStore: { issue: async () => ({ ok: true, status: 'issued' }) },
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
    assert.equal(bridgeCalls[0].sourceMessageId, 'source-message-9');
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
    const fallbackStatus = JSON.parse(visible[0].content);
    assert.deepEqual(
      { ...fallbackStatus, outboundReceipt: undefined },
      {
        type: 'cloud_bridge_status',
        catId: 'gpt-pro',
        status: 'unavailable',
        reason: 'no-adapter',
        message:
          '未发送给 @gpt-pro：还没有可用的后台 Host Adapter。请先安装并配对 Chrome 扩展，再绑定目标 ChatGPT 会话；前台自动化保持关闭。',
        detail: 'No configured personal Chrome Host Adapter',
        outboundReceipt: undefined,
      },
    );
    assert.deepEqual(fallbackStatus.outboundReceipt, {
      v: 1,
      sourceMessageId: 'source-message-9',
      sourceSender: { kind: 'cat', id: 'codex-sol', invocationId: 'parent-invocation' },
      dispatchInvocationId: createdPayload.invocationId,
      targetCatId: 'gpt-pro',
      status: 'failed',
      transport: 'none',
      idempotency: { keyKind: 'source_message_id', disposition: 'not_attempted' },
    });

    const done = messages.find((message) => message.type === 'done');
    assert.equal(done.invocationId, createdPayload.invocationId);
    assert.equal(done.errorCode, undefined);
  });

  it('reports a real Host receipt as sent and completes through the ordinary response lifecycle', async () => {
    ensureGptProRegistered();
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
              idempotentReplay: false,
            }),
          },
          cloudReturnGrantStore: { issue: async () => ({ ok: true, status: 'issued' }) },
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
    const { outboundReceipt, ...sentStatus } = status;
    assert.deepEqual(sentStatus, {
      type: 'cloud_bridge_status',
      catId: 'gpt-pro',
      status: 'sent',
      message: '已发送给 @gpt-pro，等待它从 ChatGPT 云端会话回写。',
      transport: 'host',
      hostMessageId: 'chatgpt-user-message-42',
    });
    assert.equal(outboundReceipt.sourceMessageId, 'source-message-9');
    assert.deepEqual(outboundReceipt.sourceSender, {
      kind: 'cat',
      id: 'codex-sol',
      invocationId: 'parent-invocation',
    });
    assert.equal(outboundReceipt.status, 'sent');
    assert.equal(outboundReceipt.transport, 'host');
    assert.equal(outboundReceipt.hostMessageId, 'chatgpt-user-message-42');
    assert.deepEqual(outboundReceipt.idempotency, {
      keyKind: 'source_message_id',
      disposition: 'fresh',
    });
    assert.equal(messages.at(-1).type, 'done');
  });

  it('preserves the exact A2A source and caller through a parallel cloud route', async () => {
    ensureGptProRegistered();
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
    assert.equal(bridgeCalls[0].sourceMessageId, 'source-message-parallel-4');
    assert.equal(messages.filter((message) => message.type === 'done').length, 1);
  });

  it('fails closed but still settles an A2A trigger whose caller identity is absent', async () => {
    ensureGptProRegistered();
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
    const status = messages
      .filter((message) => message.type === 'system_info' && message.content)
      .map((message) => JSON.parse(message.content))
      .find((payload) => payload.type === 'cloud_bridge_status');
    assert.equal(status.status, 'unavailable');
    assert.match(status.detail, /provenance or return-grant store was incomplete/);
    assert.equal(messages.filter((message) => message.type === 'done').length, 1);
  });

  it('degrades a thread metadata read failure without skipping cloud status or lifecycle completion', async () => {
    ensureGptProRegistered();
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
          cloudReturnGrantStore: { issue: async () => ({ ok: true, status: 'issued' }) },
        },
        baseParams,
      ),
    );

    assert.equal(bridgeCalls.length, 1);
    assert.equal(bridgeCalls[0].threadTitle, null);
    assert.deepEqual(bridgeCalls[0].participants, []);
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
