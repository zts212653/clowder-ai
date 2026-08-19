import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

await import('tsx/esm');
const {
  MESSAGE_BUNDLE_RICH_BLOCK_DIGEST_DOMAIN,
  MessageSelectionResolver,
  digestMessageBundleCliQuoteProjection,
  digestMessageBundleRichBlockProjection,
} = await import('../src/domains/cats/services/context/MessageSelectionResolver.ts');

function makeThread(overrides = {}) {
  return {
    id: 'thread-source',
    projectPath: '/test',
    title: 'Source thread',
    createdBy: 'user-1',
    participants: [],
    lastActiveAt: 1,
    createdAt: 1,
    ...overrides,
  };
}

function makeMessage(overrides = {}) {
  return {
    id: 'message-1',
    threadId: 'thread-source',
    userId: 'user-1',
    catId: null,
    content: 'alpha beta gamma',
    mentions: [],
    timestamp: 100,
    deliveryStatus: 'delivered',
    ...overrides,
  };
}

function createResolver({ messages = [makeMessage()] } = {}) {
  const messageMap = new Map(messages.map((message) => [message.id, message]));
  return {
    messageMap,
    resolver: new MessageSelectionResolver({
      threadStore: {
        async get(threadId) {
          return threadId === 'thread-source' ? makeThread() : null;
        },
      },
      messageStore: {
        async getById(messageId) {
          return messageMap.get(messageId) ?? null;
        },
        async getByThreadAfter(threadId) {
          return [...messageMap.values()]
            .filter((message) => message.threadId === threadId)
            .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
        },
      },
    }),
  };
}

const auth = { userId: 'user-1' };

describe('MessageSelectionResolver Rich Block forwarding', () => {
  it('admits one Rich Block and strips actions, privileged meta, HTML, and sibling blocks', async () => {
    const message = makeMessage({
      id: 'message-rich',
      catId: 'codex-sol',
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              id: 'decision-card',
              kind: 'card',
              v: 1,
              title: 'Decision',
              bodyMarkdown: 'Use the exact resolver.',
              actions: [{ label: 'Approve', action: 'approve', payload: { callbackToken: 'secret' } }],
              meta: { kind: 'proposal', callbackToken: 'secret' },
            },
            { id: 'sibling', kind: 'html_widget', v: 1, title: 'Do not include', html: '<script>run()</script>' },
          ],
        },
      },
    });
    const { resolver } = createResolver({ messages: [message] });

    const result = await resolver.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [
          {
            kind: 'rich_block',
            messageId: message.id,
            sourceMessageIds: [message.id],
            blockId: 'decision-card',
          },
        ],
      },
      auth,
    );

    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.carrier.items[0], {
      kind: 'rich_block',
      messageId: message.id,
      sourceMessageIds: [message.id],
      blockId: 'decision-card',
      sourceProjectionVersion: 1,
      sourceProjectionSha256: digestMessageBundleRichBlockProjection(message.extra.rich.blocks[0]),
    });
    assert.equal(result.items[0].kind, 'rich_block');
    assert.equal(result.items[0].readableContent, '[卡片: Decision]\nUse the exact resolver.');
    assert.deepEqual(result.items[0].richBlock, {
      id: 'decision-card',
      kind: 'card',
      v: 1,
      title: 'Decision',
      bodyMarkdown: 'Use the exact resolver.',
    });
    assert.equal(JSON.stringify(result.items[0]).includes('callbackToken'), false);
    assert.equal(JSON.stringify(result.items[0]).includes('Do not include'), false);
    assert.equal(MESSAGE_BUNDLE_RICH_BLOCK_DIGEST_DOMAIN.endsWith('\0'), true);
  });

  it('tombstones CLI and Rich Block refs when their source projection changes', async () => {
    const cli = makeMessage({
      id: 'message-cli',
      catId: 'codex-sol',
      content: 'alpha beta',
      origin: 'stream',
      extra: { stream: { turnInvocationId: 'turn-cli' } },
    });
    const rich = makeMessage({
      id: 'message-rich',
      catId: 'codex-sol',
      content: '',
      extra: {
        rich: { v: 1, blocks: [{ id: 'card-1', kind: 'card', v: 1, title: 'Before' }] },
      },
    });
    const state = createResolver({ messages: [cli, rich] });
    const carrier = {
      v: 1,
      sourceThreadId: 'thread-source',
      items: [
        {
          kind: 'cli_quote',
          messageId: cli.id,
          sourceMessageIds: [cli.id],
          segmentId: 'stdout',
          selectionStart: 6,
          selectionEnd: 10,
          sourceProjectionVersion: 1,
          sourceProjectionSha256: digestMessageBundleCliQuoteProjection('alpha beta'),
        },
        {
          kind: 'rich_block',
          messageId: rich.id,
          sourceMessageIds: [rich.id],
          blockId: 'card-1',
          sourceProjectionVersion: 1,
          sourceProjectionSha256: digestMessageBundleRichBlockProjection(rich.extra.rich.blocks[0]),
        },
      ],
    };

    state.messageMap.set(cli.id, { ...cli, content: 'alpha changed' });
    state.messageMap.set(rich.id, {
      ...rich,
      extra: { rich: { v: 1, blocks: [{ id: 'card-1', kind: 'card', v: 1, title: 'After' }] } },
    });

    const result = await state.resolver.resolveCarrier(carrier, auth);
    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.items, [
      { status: 'tombstone', messageId: cli.id, reason: 'source_changed' },
      { status: 'tombstone', messageId: rich.id, reason: 'source_changed' },
    ]);
  });

  it('rejects an omitted live Rich record and tombstones an existing partial carrier', async () => {
    const finished = makeMessage({
      id: 'message-rich-finished',
      catId: 'codex-sol',
      content: '',
      origin: 'stream',
      isStreaming: false,
      extra: {
        stream: { turnInvocationId: 'turn-forged-rich' },
        rich: { v: 1, blocks: [{ id: 'card-1', kind: 'card', v: 1, title: 'Finished card' }] },
      },
    });
    const live = makeMessage({
      id: 'message-rich-live',
      catId: 'codex-sol',
      content: 'still running',
      origin: 'stream',
      isStreaming: true,
      timestamp: 101,
      extra: { stream: { turnInvocationId: 'turn-forged-rich' } },
    });
    const { resolver } = createResolver({ messages: [finished, live] });
    const partialItem = {
      kind: 'rich_block',
      messageId: finished.id,
      sourceMessageIds: [finished.id],
      blockId: 'card-1',
    };

    assert.deepEqual(
      await resolver.resolveForAdmission({ sourceThreadId: 'thread-source', items: [partialItem] }, auth),
      { status: 'invalid', reason: 'source_unavailable', messageId: finished.id },
    );

    const result = await resolver.resolveCarrier(
      {
        v: 1,
        sourceThreadId: 'thread-source',
        items: [
          {
            ...partialItem,
            sourceProjectionVersion: 1,
            sourceProjectionSha256: digestMessageBundleRichBlockProjection(finished.extra.rich.blocks[0]),
          },
        ],
      },
      auth,
    );
    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.items, [{ status: 'tombstone', messageId: finished.id, reason: 'source_changed' }]);
  });
});
