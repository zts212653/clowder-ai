import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexMcpCapabilityCorrelation } from '../dist/domains/cats/services/agents/providers/CodexMcpCapabilityCorrelation.js';

const binding = { threadId: 'thread-1', turnId: 'turn-1' };

function approve(correlation, callId) {
  correlation.observe({
    method: 'item/started',
    params: {
      ...binding,
      item: {
        id: callId,
        type: 'mcpToolCall',
        status: 'inProgress',
        server: 'cua_repl',
        tool: 'js',
        pluginId: 'unified-computer-use@openai-bundled',
      },
    },
  });
  correlation.observe({
    method: 'item/autoApprovalReview/started',
    params: {
      ...binding,
      targetItemId: callId,
      reviewId: `review-${callId}`,
      review: { status: 'inProgress' },
      action: { type: 'mcpToolCall', server: 'cua_repl', toolName: 'js' },
    },
  });
  correlation.observe({
    method: 'item/autoApprovalReview/completed',
    params: {
      ...binding,
      targetItemId: callId,
      reviewId: `review-${callId}`,
      review: { status: 'approved' },
      action: { type: 'mcpToolCall', server: 'cua_repl', toolName: 'js' },
    },
  });
}

test('F306 clears provider approval evidence at exact turn completion and close', () => {
  const correlation = createCodexMcpCapabilityCorrelation();
  correlation.bindProviderTurn(binding);
  approve(correlation, 'call-1');
  assert.equal(correlation.isProviderAutoReviewApproved({ ...binding, callId: 'call-1' }), true);

  correlation.observe({
    method: 'turn/completed',
    params: { threadId: binding.threadId, turn: { id: binding.turnId, status: 'completed' } },
  });
  assert.equal(correlation.isProviderAutoReviewApproved({ ...binding, callId: 'call-1' }), false);

  correlation.bindProviderTurn(binding);
  approve(correlation, 'call-2');
  assert.equal(correlation.isProviderAutoReviewApproved({ ...binding, callId: 'call-2' }), false);

  correlation.close();
  assert.equal(correlation.isProviderAutoReviewApproved({ ...binding, callId: 'call-2' }), false);
});

test('F306 rebinding a provider turn discards an earlier active approval window', () => {
  const correlation = createCodexMcpCapabilityCorrelation();
  correlation.bindProviderTurn(binding);
  approve(correlation, 'call-1');
  correlation.bindProviderTurn({ threadId: binding.threadId, turnId: 'turn-2' });
  assert.equal(correlation.isProviderAutoReviewApproved({ ...binding, callId: 'call-1' }), false);
});
