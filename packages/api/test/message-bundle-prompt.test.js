import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { digestMessageBundleQuoteProjection } = await import(
  '../dist/domains/cats/services/context/MessageSelectionResolver.js'
);
const { MESSAGE_BUNDLE_PROMPT_CHAR_LIMIT, resolveMessageBundlePrompt } = await import(
  '../dist/domains/cats/services/context/MessageBundlePromptResolver.js'
);

function buildDeps(messages, sourceThread = { id: 'source-thread', title: 'Source Thread', createdBy: 'user-1' }) {
  return {
    messageStore: {
      getById: async (messageId) => messages.get(messageId) ?? null,
      // Whole-message selection resolves the canonical bubble group, so the store must expose the
      // same timeline the browser projected from.
      getByThreadAfter: async (threadId) => [...messages.values()].filter((message) => message.threadId === threadId),
    },
    threadStore: {
      get: async (threadId) => (threadId === sourceThread.id ? sourceThread : null),
    },
  };
}

function sourceMessage(overrides = {}) {
  return {
    id: 'source-1',
    threadId: 'source-thread',
    userId: 'user-1',
    catId: 'opus',
    content: 'primary source body',
    mentions: [],
    timestamp: Date.parse('2026-08-12T10:00:00.000Z'),
    ...overrides,
  };
}

describe('Message Bundle prompt projection', () => {
  it('projects source identity, time, exact refs, rich fallback, and a separately labeled forwarder comment', async () => {
    const message = sourceMessage({
      content: 'source body',
      extra: {
        rich: {
          blocks: [{ kind: 'card', v: 1, id: 'card-1', title: 'Build result', bodyMarkdown: 'all checks passed' }],
        },
      },
    });
    const quotedMessage = sourceMessage({
      id: 'source-2',
      catId: null,
      content: 'quoted source body',
      timestamp: Date.parse('2026-08-12T10:01:00.000Z'),
    });
    const carrier = {
      v: 1,
      sourceThreadId: 'source-thread',
      note: 'bundle-level reason for forwarding',
      items: [
        { kind: 'message', messageId: message.id },
        {
          kind: 'quote',
          messageId: quotedMessage.id,
          selectionStart: 0,
          selectionEnd: 6,
          sourceProjectionVersion: 1,
          sourceProjectionSha256: digestMessageBundleQuoteProjection(quotedMessage.content),
          comment: 'my forwarding note',
        },
      ],
    };
    const result = await resolveMessageBundlePrompt({
      bundleMessageId: 'bundle-1',
      forwarderUserId: 'user-1',
      carrier,
      ...buildDeps(
        new Map([
          [message.id, message],
          [quotedMessage.id, quotedMessage],
        ]),
      ),
    });

    assert.equal(result.status, 'ready');
    assert.match(result.content, /Bundle ID: bundle-1/);
    assert.match(result.content, /Source thread: "Source Thread" \(source-thread\)/);
    assert.match(result.content, /Exact refs: source-1, source-2/);
    assert.match(result.content, /Source author: cat:@opus/);
    assert.match(result.content, /Source time: 2026-08-12T10:00:00.000Z/);
    assert.match(result.content, /source body/);
    assert.match(result.content, /\[卡片: Build result\]\nall checks passed/);
    assert.match(result.content, /Forwarder comment by user:user-1:\nmy forwarding note/);
    assert.match(result.content, /Bundle note by user:user-1:\nbundle-level reason for forwarding/);
    assert.equal(
      result.content.indexOf('Bundle note by user:user-1:') < result.content.indexOf('## Item 1'),
      true,
      'bundle note must remain distinct from the first item comment',
    );
  });

  it('uses the same quote-drift tombstone and never leaks the changed source body', async () => {
    const message = sourceMessage({ content: 'changed private body' });
    const carrier = {
      v: 1,
      sourceThreadId: 'source-thread',
      items: [
        {
          kind: 'quote',
          messageId: message.id,
          selectionStart: 0,
          selectionEnd: 8,
          sourceProjectionVersion: 1,
          sourceProjectionSha256: digestMessageBundleQuoteProjection('old body'),
        },
      ],
    };
    const result = await resolveMessageBundlePrompt({
      bundleMessageId: 'bundle-2',
      forwarderUserId: 'user-1',
      carrier,
      ...buildDeps(new Map([[message.id, message]])),
    });

    assert.deepEqual(result, {
      status: 'unavailable',
      reason: 'all_unavailable',
      items: [{ status: 'tombstone', messageId: 'source-1', reason: 'source_changed' }],
    });
    assert.equal(JSON.stringify(result).includes('changed private body'), false);
  });

  it('fails honestly when the ephemeral projection exceeds the 48,000 character prompt limit', async () => {
    const message = sourceMessage({ content: 'x'.repeat(MESSAGE_BUNDLE_PROMPT_CHAR_LIMIT) });
    const result = await resolveMessageBundlePrompt({
      bundleMessageId: 'bundle-large',
      forwarderUserId: 'user-1',
      carrier: {
        v: 1,
        sourceThreadId: 'source-thread',
        items: [{ kind: 'message', messageId: message.id }],
      },
      ...buildDeps(new Map([[message.id, message]])),
    });

    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'prompt_too_large');
  });
});
