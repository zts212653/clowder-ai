import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCloudBridgeFailureDiagnosticV1 } from '@cat-cafe/shared';
import { persistUserFacingSystemInfoNotices } from '../dist/domains/cats/services/agents/routing/persist-system-info-warnings.js';
import { buildCloudBridgeStatusContent } from '../dist/domains/cats/services/cloud-bridge/cloud-bridge-fallback.js';
import { dispatchBoundConversationThroughHost } from '../dist/domains/cats/services/cloud-bridge/conversation-host-dispatch.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { boundedFailureDiagnostic } from './helpers/f202-cloud-failure-diagnostic.js';

const BOUNDARY_FIXTURES = [
  { id: 'long-custom-tag', expectedPath: 'composer/#node-1[0]' },
  { id: 'high-child-index', expectedPath: 'composer/#node-8[10000]' },
];

describe('Host persistence of bounded plugin failure diagnostics', () => {
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
      const diagnostic = boundedFailureDiagnostic(fixture.expectedPath);
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
