import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

await import('tsx/esm');
const { MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN, MessageSelectionResolver, digestMessageBundleQuoteProjection } =
  await import('../src/domains/cats/services/context/MessageSelectionResolver.ts');

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

function createResolver({ thread = makeThread(), messages = [makeMessage()] } = {}) {
  const messageMap = new Map(messages.map((message) => [message.id, message]));
  let currentThread = thread;
  return {
    messageMap,
    setThread(next) {
      currentThread = next;
    },
    resolver: new MessageSelectionResolver({
      threadStore: {
        async get(threadId) {
          return currentThread?.id === threadId ? currentThread : null;
        },
      },
      messageStore: {
        async getById(messageId) {
          return messageMap.get(messageId) ?? null;
        },
      },
    }),
  };
}

const auth = { userId: 'user-1' };

describe('MessageSelectionResolver admission', () => {
  it('normalizes request order to source timeline order and emits refs-only carrier data', async () => {
    const later = makeMessage({ id: 'message-later', timestamp: 200, catId: 'codex-sol', content: 'later' });
    const earlier = makeMessage({ id: 'message-earlier', timestamp: 100, content: 'earlier' });
    const { resolver } = createResolver({ messages: [later, earlier] });

    const result = await resolver.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [
          { kind: 'message', messageId: later.id },
          { kind: 'message', messageId: earlier.id },
        ],
      },
      auth,
    );

    assert.equal(result.status, 'resolved');
    assert.deepEqual(
      result.carrier.items.map((item) => item.messageId),
      [earlier.id, later.id],
    );
    assert.deepEqual(Object.keys(result.carrier.items[0]).sort(), ['kind', 'messageId']);
    assert.deepEqual(Object.keys(result.carrier.items[1]).sort(), ['kind', 'messageId']);
    assert.deepEqual(result.items[0].author, { kind: 'user', userId: 'user-1' });
    assert.deepEqual(result.items[1].author, { kind: 'cat', catId: 'codex-sol' });
  });

  it('anchors an exact Quote and stores a domain-separated digest of the full projection', async () => {
    const message = makeMessage({ content: 'alpha beta gamma' });
    const { resolver } = createResolver({ messages: [message] });

    const result = await resolver.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [
          {
            kind: 'quote',
            messageId: message.id,
            text: 'beta',
            selectionStart: 6,
            selectionEnd: 10,
            comment: 'focus here',
          },
        ],
      },
      auth,
    );

    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.carrier.items[0], {
      kind: 'quote',
      messageId: message.id,
      selectionStart: 6,
      selectionEnd: 10,
      sourceProjectionVersion: 1,
      sourceProjectionSha256: digestMessageBundleQuoteProjection(message.content),
      comment: 'focus here',
    });
    assert.equal(MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN.endsWith('\0'), true);
    assert.equal('text' in result.carrier.items[0], false);
    assert.equal(result.items[0].readableContent, 'beta');
  });

  it('anchors Quote evidence against the full canonical rich fallback projection', async () => {
    const message = makeMessage({
      content: '',
      contentBlocks: [{ type: 'image', url: '/uploads/diagram.png', alt: 'queue topology' }],
    });
    const { resolver } = createResolver({ messages: [message] });

    const result = await resolver.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [{ kind: 'quote', messageId: message.id, text: 'queue topology' }],
      },
      auth,
    );

    assert.equal(result.status, 'resolved');
    assert.equal(result.items[0].readableContent, 'queue topology');
    assert.equal(
      result.carrier.items[0].sourceProjectionSha256,
      digestMessageBundleQuoteProjection('[图片: queue topology]'),
    );
  });

  it('repairs stale offsets only when the client evidence has one unique exact match', async () => {
    const unique = createResolver({ messages: [makeMessage({ content: 'alpha beta gamma' })] }).resolver;
    const repaired = await unique.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [
          {
            kind: 'quote',
            messageId: 'message-1',
            text: 'beta',
            selectionStart: 0,
            selectionEnd: 4,
          },
        ],
      },
      auth,
    );
    assert.equal(repaired.status, 'resolved');
    assert.equal(repaired.carrier.items[0].selectionStart, 6);
    assert.equal(repaired.carrier.items[0].selectionEnd, 10);

    const ambiguous = createResolver({ messages: [makeMessage({ content: 'beta x beta' })] }).resolver;
    const rejected = await ambiguous.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [{ kind: 'quote', messageId: 'message-1', text: 'beta' }],
      },
      auth,
    );
    assert.deepEqual(rejected, { status: 'invalid', reason: 'ambiguous_quote', messageId: 'message-1' });
  });

  it('fails closed for foreign scope, unstable/internal records, recall, and empty readable content', async () => {
    const invalidMessages = [
      makeMessage({ id: 'foreign-thread', threadId: 'thread-other' }),
      makeMessage({ id: 'foreign-user', userId: 'user-2' }),
      makeMessage({ id: 'recalled', _tombstone: true, recall: { exposure: 'seen' }, content: '' }),
      makeMessage({ id: 'canceled', deliveryStatus: 'canceled' }),
      makeMessage({ id: 'internal', userId: 'system', origin: 'briefing' }),
      makeMessage({
        id: 'empty',
        content: '',
        contentBlocks: [{ type: 'tool_call', toolName: 'x', toolId: '1', input: {} }],
      }),
    ];
    const { resolver } = createResolver({ messages: invalidMessages });

    for (const message of invalidMessages) {
      const result = await resolver.resolveForAdmission(
        {
          sourceThreadId: 'thread-source',
          items: [{ kind: 'message', messageId: message.id }],
        },
        auth,
      );
      assert.equal(result.status, 'invalid', `${message.id} must fail closed`);
    }

    const unauthorized = createResolver({ thread: makeThread({ createdBy: 'user-2' }) }).resolver;
    assert.deepEqual(
      await unauthorized.resolveForAdmission(
        { sourceThreadId: 'thread-source', items: [{ kind: 'message', messageId: 'message-1' }] },
        auth,
      ),
      { status: 'invalid', reason: 'not_authorized' },
    );
  });

  it('allows an authenticated user to select from a system-created shared thread', async () => {
    const { resolver } = createResolver({ thread: makeThread({ createdBy: 'system' }) });

    const result = await resolver.resolveForAdmission(
      { sourceThreadId: 'thread-source', items: [{ kind: 'message', messageId: 'message-1' }] },
      auth,
    );

    assert.equal(result.status, 'resolved');
  });
});

describe('MessageSelectionResolver durable reads', () => {
  it('compares the full projection digest before applying Quote offsets', async () => {
    const message = makeMessage({ content: 'alpha beta gamma' });
    const { resolver } = createResolver({ messages: [message] });
    const carrier = {
      v: 1,
      sourceThreadId: 'thread-source',
      items: [
        {
          kind: 'quote',
          messageId: message.id,
          selectionStart: 6,
          selectionEnd: 10,
          sourceProjectionVersion: 1,
          sourceProjectionSha256: digestMessageBundleQuoteProjection('different projection'),
        },
      ],
    };

    const result = await resolver.resolveCarrier(carrier, auth);

    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.items, [{ status: 'tombstone', messageId: message.id, reason: 'source_changed' }]);
  });

  it('converges hard delete, recall, and permission loss on typed unavailable tombstones', async () => {
    const original = makeMessage({ id: 'message-1' });
    const state = createResolver({ messages: [original] });
    const carrier = {
      v: 1,
      sourceThreadId: 'thread-source',
      items: [{ kind: 'message', messageId: original.id }],
    };

    state.messageMap.delete(original.id);
    assert.deepEqual((await state.resolver.resolveCarrier(carrier, auth)).items, [
      { status: 'tombstone', messageId: original.id, reason: 'source_unavailable' },
    ]);

    state.messageMap.set(original.id, { ...original, content: '', _tombstone: true, recall: { exposure: 'seen' } });
    assert.deepEqual((await state.resolver.resolveCarrier(carrier, auth)).items, [
      { status: 'tombstone', messageId: original.id, reason: 'source_unavailable' },
    ]);

    state.setThread(makeThread({ createdBy: 'user-2' }));
    assert.deepEqual((await state.resolver.resolveCarrier(carrier, auth)).items, [
      { status: 'tombstone', messageId: original.id, reason: 'source_unavailable' },
    ]);
  });

  it('projects readable rich fallbacks without adding them to the durable carrier', async () => {
    const message = makeMessage({
      content: 'Architecture update',
      contentBlocks: [
        { type: 'image', url: '/uploads/diagram.png', alt: 'queue topology' },
        { type: 'file', url: '/uploads/report.pdf', fileName: 'report.pdf', mimeType: 'application/pdf', fileSize: 1 },
      ],
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              id: 'card-1',
              kind: 'card',
              v: 1,
              title: 'Decision',
              bodyMarkdown: 'Use the shared resolver.',
              fields: [{ label: 'Status', value: 'approved' }],
            },
          ],
        },
      },
    });
    const { resolver } = createResolver({ messages: [message] });
    const admitted = await resolver.resolveForAdmission(
      { sourceThreadId: 'thread-source', items: [{ kind: 'message', messageId: message.id }] },
      auth,
    );

    assert.equal(admitted.status, 'resolved');
    assert.equal(
      admitted.items[0].readableContent,
      'Architecture update\n[图片: queue topology]\n[文件: report.pdf]\n[卡片: Decision]\nUse the shared resolver.\nStatus: approved',
    );
    assert.equal(JSON.stringify(admitted.carrier).includes('queue topology'), false);
  });
});
