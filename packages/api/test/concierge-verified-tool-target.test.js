import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let VerifiedConciergeToolTargetCollector;
let resolveVerifiedConciergeToolAnchor;

before(async () => {
  const mod = await import('../dist/domains/concierge/concierge-verified-tool-target.js');
  VerifiedConciergeToolTargetCollector = mod.VerifiedConciergeToolTargetCollector;
  resolveVerifiedConciergeToolAnchor = mod.resolveVerifiedConciergeToolAnchor;
});

const toolName = 'mcp:cat-cafe-collab/cat_cafe_get_thread_context';

function observeRead(collector, threadId, messageId, toolUseId = `read-${threadId}`) {
  collector.observe({
    type: 'tool_use',
    toolName,
    toolUseId,
    toolInput: { threadId, ...(messageId ? { messageId } : {}) },
  });
}

function observeResult(
  collector,
  threadId,
  messageId,
  { toolUseId = `read-${threadId}`, status = 'ok', resultThreadId = threadId } = {},
) {
  collector.observe({
    type: 'tool_result',
    toolName,
    toolUseId,
    toolResultStatus: status,
    content: `${toolName} (completed)\n${JSON.stringify({
      threadId: resultThreadId,
      messages: messageId ? [{ id: messageId, threadId: resultThreadId }] : [],
    })}`,
  });
}

describe('VerifiedConciergeToolTargetCollector', () => {
  it('accepts known provider name forms but rejects a same-named tool on an untrusted server', () => {
    const trustedNames = [
      'mcp__cat_cafe__cat_cafe_get_thread_context',
      'mcp:codex_apps/cat_cafe_cat_cafe_get_thread_context',
      'cat_cafe_get_thread_context',
    ];
    for (const [index, trustedName] of trustedNames.entries()) {
      const collector = new VerifiedConciergeToolTargetCollector();
      const threadId = `thread_${index}`;
      const toolUseId = `trusted-${index}`;
      collector.observe({ type: 'tool_use', toolName: trustedName, toolUseId, toolInput: { threadId } });
      collector.observe({
        type: 'tool_result',
        toolName: trustedName,
        toolUseId,
        toolResultStatus: 'ok',
        content: `${trustedName} (completed)\n${JSON.stringify({ threadId, messages: [] })}`,
      });
      assert.deepStrictEqual(collector.uniqueTarget(), { threadId });
    }

    const untrusted = new VerifiedConciergeToolTargetCollector();
    const untrustedName = 'mcp:untrusted-server/cat_cafe_get_thread_context';
    untrusted.observe({
      type: 'tool_use',
      toolName: untrustedName,
      toolUseId: 'untrusted-1',
      toolInput: { threadId: 'thread_wrong' },
    });
    untrusted.observe({
      type: 'tool_result',
      toolName: untrustedName,
      toolUseId: 'untrusted-1',
      toolResultStatus: 'ok',
      content: `${untrustedName} (completed)\n${JSON.stringify({ threadId: 'thread_wrong', messages: [] })}`,
    });
    assert.equal(untrusted.uniqueTarget(), undefined);
  });

  it('accepts one successful identity-matched read and hydrates its canonical title', async () => {
    const collector = new VerifiedConciergeToolTargetCollector();
    observeRead(collector, 'thread_target', 'message_target');
    observeResult(collector, 'thread_target', 'message_target');

    const anchor = await resolveVerifiedConciergeToolAnchor(collector, 'thread_concierge', {
      async get(threadId) {
        return { id: threadId, title: 'Canonical target' };
      },
    });

    assert.deepStrictEqual(anchor, {
      threadId: 'thread_target',
      messageId: 'message_target',
      title: 'Canonical target',
      type: 'thread',
    });
  });

  it('rejects failed, mismatched, and unpaired tool results', () => {
    const failed = new VerifiedConciergeToolTargetCollector();
    observeRead(failed, 'thread_target', 'message_target');
    observeResult(failed, 'thread_target', 'message_target', { status: 'error' });
    assert.equal(failed.uniqueTarget(), undefined);

    const mismatched = new VerifiedConciergeToolTargetCollector();
    observeRead(mismatched, 'thread_target', 'message_target');
    observeResult(mismatched, 'thread_target', 'message_target', { resultThreadId: 'thread_wrong' });
    assert.equal(mismatched.uniqueTarget(), undefined);

    const unpaired = new VerifiedConciergeToolTargetCollector();
    observeResult(unpaired, 'thread_target', 'message_target');
    assert.equal(unpaired.uniqueTarget(), undefined);
  });

  it('fails closed when successful reads identify two different target threads', () => {
    const collector = new VerifiedConciergeToolTargetCollector();
    observeRead(collector, 'thread_a', 'message_a');
    observeResult(collector, 'thread_a', 'message_a');
    observeRead(collector, 'thread_b', 'message_b');
    observeResult(collector, 'thread_b', 'message_b');

    assert.equal(collector.verifiedTargetCount(), 2);
    assert.equal(collector.uniqueTarget(), undefined);
  });

  it('degrades two different message reads of one thread to thread-level navigation', () => {
    const collector = new VerifiedConciergeToolTargetCollector();
    observeRead(collector, 'thread_target', 'message_a', 'read-a');
    observeResult(collector, 'thread_target', 'message_a', { toolUseId: 'read-a' });
    observeRead(collector, 'thread_target', 'message_b', 'read-b');
    observeResult(collector, 'thread_target', 'message_b', { toolUseId: 'read-b' });

    assert.deepStrictEqual(collector.uniqueTarget(), { threadId: 'thread_target' });
  });

  it('does not navigate to the current, deleted, or untitled thread', async () => {
    const collector = new VerifiedConciergeToolTargetCollector();
    observeRead(collector, 'thread_target');
    observeResult(collector, 'thread_target');

    assert.equal(
      await resolveVerifiedConciergeToolAnchor(collector, 'thread_target', {
        async get(threadId) {
          return { id: threadId, title: 'Current thread' };
        },
      }),
      undefined,
    );
    assert.equal(
      await resolveVerifiedConciergeToolAnchor(collector, 'thread_concierge', {
        async get(threadId) {
          return { id: threadId, title: 'Deleted thread', deletedAt: Date.now() };
        },
      }),
      undefined,
    );
    assert.equal(
      await resolveVerifiedConciergeToolAnchor(collector, 'thread_concierge', {
        async get(threadId) {
          return { id: threadId, title: '   ' };
        },
      }),
      undefined,
    );
  });
});
