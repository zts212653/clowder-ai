import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCloudBridgeFailureDiagnosticV1 } from '@cat-cafe/shared';
import { persistUserFacingSystemInfoNotices } from '../dist/domains/cats/services/agents/routing/persist-system-info-warnings.js';
import { buildCloudBridgeStatusContent } from '../dist/domains/cats/services/cloud-bridge/cloud-bridge-fallback.js';
import { dispatchBoundConversationThroughHost } from '../dist/domains/cats/services/cloud-bridge/conversation-host-dispatch.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { safeAdapterDiagnostic } from '../src/plugins/cloud-cat-personal-host/native-host/native-results.mjs';
import { createUnsupportedNodeHarness } from './helpers/f247-unsupported-node-harness.js';

const BOUNDARY_FIXTURES = [
  {
    id: 'long-custom-tag',
    expectedPath: 'composer/#node-1[0]',
    privateDomText: `x-${'a'.repeat(31)}`,
    mutateAfterInsert({ composer, document }) {
      composer.replaceChildren(document.createElement(`x-${'a'.repeat(31)}`));
    },
  },
  {
    id: 'high-child-index',
    expectedPath: 'composer/#node-8[10000]',
    privateDomText: 'comment body must stay private',
    mutateAfterInsert({ composer, document }) {
      const nodes = Array.from({ length: 10_000 }, () => document.createTextNode(''));
      nodes.push(document.createComment('comment body must stay private'));
      composer.replaceChildren(...nodes);
    },
  },
];

describe('F247 DOM fingerprint producer bounds', () => {
  it('persists representable diagnostics for long tags and high child indexes', async () => {
    for (const fixture of BOUNDARY_FIXTURES) {
      const threadId = `thread-failed-dispatch-${fixture.id}`;
      const messageStore = new MessageStore();
      const source = messageStore.append({
        userId: 'alice',
        catId: 'codex-sol',
        threadId,
        content: '@gpt-pro private source body',
        mentions: ['gpt-pro'],
        timestamp: 1_000,
        extra: { stream: { invocationId: 'inv-source', turnInvocationId: 'inv-source' } },
      });
      const harness = createUnsupportedNodeHarness({ mutateAfterInsert: fixture.mutateAfterInsert });
      let pageDiagnostic;
      await assert.rejects(
        harness.adapter.appendMessage({
          requestId: `${fixture.id}-failure`,
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
      assert.equal(pageDiagnostic.fingerprint.firstUnsupportedPath, fixture.expectedPath);
      assert.equal(pageDiagnostic.fingerprint.truncated, true);
      assert.equal(JSON.stringify(pageDiagnostic).includes(fixture.privateDomText), false);

      const diagnostic = safeAdapterDiagnostic(pageDiagnostic);
      assert.ok(diagnostic, `${fixture.id}: native Helper must preserve the producer diagnostic`);
      assert.equal(isCloudBridgeFailureDiagnosticV1(diagnostic), true);
      const decision = await dispatchBoundConversationThroughHost({
        adapter: {
          async append_message() {
            throw Object.assign(new Error('ChatGPT composer DOM is unsupported'), {
              code: 'COMPOSER_DOM_UNSUPPORTED',
              diagnostic,
              idempotentReplay: false,
            });
          },
        },
        boundUrl: 'https://chatgpt.com/c/conversation-product-chain',
        renderedPrompt: 'must never enter diagnostics',
        params: { sourceMessageId: source.id },
      });
      const content = buildCloudBridgeStatusContent({
        catId: 'gpt-pro',
        outcome: decision.outcome,
        audit: {
          sourceMessageId: source.id,
          sourceSender: { kind: 'cat', id: 'codex-sol', invocationId: 'inv-source' },
          dispatchInvocationId: `inv-${fixture.id}`,
        },
      });
      await persistUserFacingSystemInfoNotices({
        messageStore,
        threadId,
        catId: 'gpt-pro',
        expectedSourceMessageId: source.id,
        expectedDispatchInvocationId: `inv-${fixture.id}`,
        contents: [content],
      });
      const durableReceipt = (await messageStore.getByThread(threadId)).find(
        (message) => message.source?.connector === 'cloud-bridge-status',
      );
      assert.deepEqual(durableReceipt.source.meta.cloudBridgeOutboundReceipt.failure, diagnostic);
    }
  });
});
