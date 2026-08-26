import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catRegistry, isCloudBridgeFailureDiagnosticV1 } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { AgentKeyRegistry } from '../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { persistUserFacingSystemInfoNotices } from '../dist/domains/cats/services/agents/routing/persist-system-info-warnings.js';
import { buildCloudBridgeStatusContent } from '../dist/domains/cats/services/cloud-bridge/cloud-bridge-fallback.js';
import { CloudReturnBindingSigner } from '../dist/domains/cats/services/cloud-bridge/cloud-return-binding.js';
import { dispatchBoundConversationThroughHost } from '../dist/domains/cats/services/cloud-bridge/conversation-host-dispatch.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { safeAdapterDiagnostic } from '../src/plugins/cloud-cat-personal-host/native-host/native-results.mjs';
import { createUnsupportedNodeHarness } from './helpers/f247-unsupported-node-harness.js';

function ensureGptProRegistered() {
  if (catRegistry.has('gpt-pro')) return;
  catRegistry.register('gpt-pro', {
    catId: 'gpt-pro',
    clientId: 'openai',
    provider: 'openai-chatgpt-pro',
    avatar: '/avatars/gpt-pro.png',
  });
}

async function drain(generator) {
  const messages = [];
  for await (const message of generator) messages.push(message);
  return messages;
}

describe('F247 normal owner-Chrome product chain', () => {
  it('persists the exact Host receipt and accepts only the matching source-bound gpt-pro return', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'alice';
    ensureGptProRegistered();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('alice', 'F247 product chain');
    await threadStore.updateCloudCatBinding(thread.id, 'gpt-pro', 'https://chatgpt.com/c/conversation-product-chain');
    const source = messageStore.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: thread.id,
      content: '@gpt-pro verify this exact source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
      extra: { stream: { invocationId: 'inv-source', turnInvocationId: 'inv-source' } },
    });
    const signer = new CloudReturnBindingSigner(Buffer.alloc(32, 17));
    const bridgeCalls = [];
    const dispositionCalls = [];
    const events = await drain(
      invokeSingleCat(
        {
          registry: new InvocationRegistry(),
          sessionManager: {},
          threadStore,
          apiUrl: 'http://localhost:0',
          cloudInvokeBridge: {
            async dispatch(params) {
              bridgeCalls.push(params);
              return {
                kind: 'sent',
                capturedUrl: 'https://chatgpt.com/c/conversation-product-chain',
                transport: 'host',
                hostMessageId: 'host-message-product-chain',
                idempotentReplay: false,
              };
            },
          },
          cloudReturnBindingSigner: signer,
          a2aDispatchDispositionService: {
            async complete(auth, disposition) {
              dispositionCalls.push({ auth, disposition });
              return {
                outcome: 'applied',
                disposition,
                invocationId: auth.invocationId,
                sourceMessageId: auth.a2aTriggerMessageId,
                fromCatId: 'codex-sol',
              };
            },
          },
        },
        {
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
          mentionContent: source.content,
          mentioningCatId: 'codex-sol',
          userId: 'alice',
          ownerAuthProvenance: 'strict',
          threadId: thread.id,
          isLastCat: true,
          parentInvocationId: 'inv-source',
          a2aTriggerMessageId: source.id,
          executionCausal: { triggerMessageId: source.id },
          promptMessageIds: [source.id],
        },
      ),
    );

    assert.equal(bridgeCalls.length, 1);
    assert.equal(bridgeCalls[0].sourceMessageId, source.id);
    assert.match(bridgeCalls[0].cloudReturnBinding, /^cbr1\./);
    assert.equal(dispositionCalls.length, 1);
    const statusEvent = events.find(
      (event) =>
        event.type === 'system_info' && event.content && JSON.parse(event.content).type === 'cloud_bridge_status',
    );
    const status = JSON.parse(statusEvent.content);
    assert.deepEqual(
      {
        sourceMessageId: status.outboundReceipt.sourceMessageId,
        dispatchInvocationId: status.outboundReceipt.dispatchInvocationId,
        status: status.outboundReceipt.status,
        transport: status.outboundReceipt.transport,
        hostMessageId: status.outboundReceipt.hostMessageId,
      },
      {
        sourceMessageId: source.id,
        dispatchInvocationId: dispositionCalls[0].auth.invocationId,
        status: 'sent',
        transport: 'host',
        hostMessageId: 'host-message-product-chain',
      },
    );

    await persistUserFacingSystemInfoNotices({
      messageStore,
      threadId: thread.id,
      catId: 'gpt-pro',
      expectedSourceMessageId: source.id,
      expectedDispatchInvocationId: status.outboundReceipt.dispatchInvocationId,
      contents: [statusEvent.content],
    });
    const durableReceipt = (await messageStore.getByThread(thread.id)).find(
      (message) => message.source?.connector === 'cloud-bridge-status',
    );
    assert.equal(durableReceipt.replyTo, source.id);
    assert.deepEqual(durableReceipt.source.meta.cloudBridgeOutboundReceipt, status.outboundReceipt);

    const agentKeyRegistry = new AgentKeyRegistry({ ttlMs: 86_400_000 });
    const { secret } = await agentKeyRegistry.issue('gpt-pro', 'alice');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry: new InvocationRegistry(),
      agentKeyRegistry,
      cloudReturnBindingSigner: signer,
      messageStore,
      threadStore,
      socketManager: { broadcastAgentMessage: () => undefined },
    });
    const missingBinding = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        content: 'must not return without the exact capability',
        threadId: thread.id,
        replyTo: bridgeCalls[0].sourceMessageId,
      },
    });
    assert.equal(missingBinding.statusCode, 400);
    assert.equal(missingBinding.json().kind, 'cloud_return_binding_required');

    const wrongSource = messageStore.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: thread.id,
      content: 'a different source in the same thread',
      timestamp: 2_000,
    });
    const substitutedSource = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        content: 'must not return to a substituted source',
        threadId: thread.id,
        replyTo: wrongSource.id,
        cloudReturnBinding: bridgeCalls[0].cloudReturnBinding,
      },
    });
    assert.equal(substitutedSource.statusCode, 403);
    assert.equal(substitutedSource.json().kind, 'cloud_return_binding_mismatch');

    const returned = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        content: 'source-bound product return',
        threadId: thread.id,
        replyTo: bridgeCalls[0].sourceMessageId,
        cloudReturnBinding: bridgeCalls[0].cloudReturnBinding,
      },
    });

    assert.equal(returned.statusCode, 200);
    const remoteReply = (await messageStore.getByThread(thread.id)).find(
      (message) => message.content === 'source-bound product return',
    );
    assert.equal(remoteReply.replyTo, source.id);
    await app.close();
  });

  it('persists only the bounded text-free fingerprint from a terminal Host failure', async () => {
    const messageStore = new MessageStore();
    const source = messageStore.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: 'thread-failed-dispatch',
      content: '@gpt-pro private source body',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
      extra: { stream: { invocationId: 'inv-source', turnInvocationId: 'inv-source' } },
    });
    const harness = createUnsupportedNodeHarness();
    let pageDiagnostic;
    await assert.rejects(
      harness.adapter.appendMessage({
        requestId: 'comment-node-failure',
        conversationId: 'conversation-product-chain',
        text: 'must never enter diagnostics',
        idempotencyKey: source.id,
      }),
      (error) => {
        assert.equal(error.code, 'COMPOSER_DOM_UNSUPPORTED');
        pageDiagnostic = error.diagnostic;
        return true;
      },
    );
    assert.equal(harness.getSendCount(), 0);
    assert.equal(harness.document.querySelectorAll('[data-message-id]').length, 0);
    assert.equal(harness.composer.textContent, '');
    assert.equal(pageDiagnostic.fingerprint.firstUnsupportedPath, 'composer/#node-8[0]');
    assert.deepEqual(
      pageDiagnostic.fingerprint.nodes.map((node) => node.path),
      ['composer', 'composer/#node-8[0]', 'composer/h1[1]'],
    );
    const diagnostic = safeAdapterDiagnostic(pageDiagnostic);
    assert.ok(diagnostic, 'native Helper must preserve the adapter path grammar');
    assert.equal(isCloudBridgeFailureDiagnosticV1(diagnostic), true);
    for (const firstUnsupportedPath of [
      'composer/#node-8[0]/prompt_secret[0]',
      'composer/#node-8[4294967296]',
      `composer/${'a'.repeat(33)}[0]`,
      `composer${'/p[0]'.repeat(110)}`,
    ]) {
      const unsafeDiagnostic = {
        ...diagnostic,
        fingerprint: { ...diagnostic.fingerprint, firstUnsupportedPath },
      };
      assert.equal(safeAdapterDiagnostic(unsafeDiagnostic), null);
      assert.equal(isCloudBridgeFailureDiagnosticV1(unsafeDiagnostic), false);
    }
    const oversizedCountDiagnostic = {
      ...diagnostic,
      fingerprint: {
        ...diagnostic.fingerprint,
        nodes: [{ path: 'composer', kind: 'element', tag: 'DIV', childCount: 0x1_0000_0000 }],
      },
    };
    assert.equal(safeAdapterDiagnostic(oversizedCountDiagnostic), null);
    assert.equal(isCloudBridgeFailureDiagnosticV1(oversizedCountDiagnostic), false);
    const hostError = Object.assign(new Error('ChatGPT composer DOM is unsupported'), {
      code: 'COMPOSER_DOM_UNSUPPORTED',
      diagnostic,
      idempotentReplay: false,
    });
    const decision = await dispatchBoundConversationThroughHost({
      adapter: {
        async append_message() {
          throw hostError;
        },
      },
      boundUrl: 'https://chatgpt.com/c/conversation-product-chain',
      renderedPrompt: 'must never enter diagnostics',
      params: { sourceMessageId: source.id },
    });

    assert.equal(decision.outcome.kind, 'error');
    const content = buildCloudBridgeStatusContent({
      catId: 'gpt-pro',
      outcome: decision.outcome,
      audit: {
        sourceMessageId: source.id,
        sourceSender: { kind: 'cat', id: 'codex-sol', invocationId: 'inv-source' },
        dispatchInvocationId: 'inv-failed-dispatch',
      },
    });
    assert.equal(content.includes('must never enter diagnostics'), false);
    await persistUserFacingSystemInfoNotices({
      messageStore,
      threadId: 'thread-failed-dispatch',
      catId: 'gpt-pro',
      expectedSourceMessageId: source.id,
      expectedDispatchInvocationId: 'inv-failed-dispatch',
      contents: [content],
    });

    const durableReceipt = (await messageStore.getByThread('thread-failed-dispatch')).find(
      (message) => message.source?.connector === 'cloud-bridge-status',
    );
    assert.equal(durableReceipt.replyTo, source.id);
    assert.deepEqual(durableReceipt.source.meta.cloudBridgeOutboundReceipt.failure, diagnostic);

    const forgedDecision = await dispatchBoundConversationThroughHost({
      adapter: {
        async append_message() {
          throw Object.assign(new Error('forged diagnostic'), {
            code: 'COMPOSER_DOM_UNSUPPORTED',
            diagnostic: {
              ...diagnostic,
              fingerprint: {
                ...diagnostic.fingerprint,
                nodes: [{ path: 'composer', kind: 'must never enter diagnostics' }],
              },
            },
          });
        },
      },
      boundUrl: 'https://chatgpt.com/c/conversation-product-chain',
      renderedPrompt: 'private prompt',
      params: { sourceMessageId: source.id },
    });
    assert.equal(forgedDecision.outcome.failureDiagnostic, undefined);
  });
});
