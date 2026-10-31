import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

await import('tsx/esm');
const { MessageSelectionResolver, digestMessageBundleCliQuoteProjection } = await import(
  '../src/domains/cats/services/context/MessageSelectionResolver.ts'
);

const auth = { userId: 'user-1' };
const thread = {
  id: 'thread-source',
  projectPath: '/test',
  title: 'Source thread',
  createdBy: 'user-1',
  participants: [],
  lastActiveAt: 1,
  createdAt: 1,
};

function message(id, toolEvents) {
  return {
    id,
    threadId: thread.id,
    userId: 'user-1',
    catId: 'codex-sol',
    content: '',
    mentions: [],
    timestamp: 100,
    deliveryStatus: 'delivered',
    origin: 'stream',
    toolEvents,
  };
}

function resolverFor(source) {
  return new MessageSelectionResolver({
    threadStore: {
      async get(id) {
        return id === thread.id ? thread : null;
      },
    },
    messageStore: {
      async getById(id) {
        return id === source.id ? source : null;
      },
      async getByThreadAfter(id) {
        return id === thread.id ? [source] : [];
      },
    },
  });
}

function selection(source, segmentId, text) {
  return {
    sourceThreadId: thread.id,
    items: [
      {
        kind: 'cli_quote',
        messageId: source.id,
        sourceMessageIds: [source.id],
        segmentId,
        text,
        selectionStart: 0,
        selectionEnd: text.length,
        sourceProjectionVersion: 3,
      },
    ],
  };
}

describe('MessageSelectionResolver reply-record quote parity', () => {
  it('admits and rereads a detail paired by provider key when results arrive out of order', async () => {
    const source = message('message-keyed-tools', [
      { id: 'u1', type: 'tool_use', label: 'Read', toolUseId: 'k1', timestamp: 1 },
      { id: 'u2', type: 'tool_use', label: 'Bash', toolUseId: 'k2', timestamp: 2 },
      { id: 'r2', type: 'tool_result', label: 'result', detail: 'SECOND', toolUseId: 'k2', timestamp: 3 },
      { id: 'r1', type: 'tool_result', label: 'result', detail: 'FIRST', toolUseId: 'k1', timestamp: 4 },
    ]);
    const resolver = resolverFor(source);

    const result = await resolver.resolveForAdmission(selection(source, 'tool-detail:u1', 'FIRST'), auth);

    assert.equal(result.status, 'resolved');
    assert.equal(result.items[0].readableContent, 'FIRST');
    assert.equal(result.carrier.items[0].sourceProjectionVersion, 3);
    const reread = await resolver.resolveCarrier(result.carrier, auth);
    assert.equal(reread.status, 'resolved');
    assert.equal(reread.items[0].status, 'available');
    assert.equal(reread.items[0].readableContent, 'FIRST');
  });

  it('keeps a hidden call in FIFO so its result cannot move onto the next visible tool', async () => {
    const source = message('message-hidden-tool', [
      { id: 'u-hidden', type: 'tool_use', label: 'unknown', timestamp: 1 },
      { id: 'u-visible', type: 'tool_use', label: 'Read', timestamp: 2 },
      { id: 'r-hidden', type: 'tool_result', label: 'result', detail: 'HIDDEN', timestamp: 3 },
      { id: 'r-visible', type: 'tool_result', label: 'result', detail: 'VISIBLE', timestamp: 4 },
    ]);
    const resolver = resolverFor(source);

    const result = await resolver.resolveForAdmission(selection(source, 'tool-detail:u-visible', 'VISIBLE'), auth);

    assert.equal(result.status, 'resolved');
    assert.equal(result.items[0].readableContent, 'VISIBLE');
  });

  it('does not fall a keyed orphan result onto an unrelated call', async () => {
    const source = message('message-orphan-result', [
      { id: 'u1', type: 'tool_use', label: 'Read', timestamp: 1 },
      {
        id: 'r-orphan',
        type: 'tool_result',
        label: 'result',
        detail: 'NOT FOR READ',
        toolUseId: 'missing-key',
        timestamp: 2,
      },
    ]);
    const resolver = resolverFor(source);

    const result = await resolver.resolveForAdmission(selection(source, 'tool-detail:u1', 'NOT FOR READ'), auth);

    assert.deepEqual(result, { status: 'invalid', reason: 'source_unavailable', messageId: source.id });
  });

  it('keeps a persisted v1 carrier on the historical positional projection', async () => {
    const source = message('message-legacy-tools', [
      { id: 'u1', type: 'tool_use', label: 'Read', toolUseId: 'k1', timestamp: 1 },
      { id: 'u2', type: 'tool_use', label: 'Bash', toolUseId: 'k2', timestamp: 2 },
      { id: 'r2', type: 'tool_result', label: 'result', detail: 'SECOND', toolUseId: 'k2', timestamp: 3 },
      { id: 'r1', type: 'tool_result', label: 'result', detail: 'FIRST', toolUseId: 'k1', timestamp: 4 },
    ]);
    const resolver = resolverFor(source);
    const carrier = {
      v: 1,
      sourceThreadId: thread.id,
      items: [
        {
          kind: 'cli_quote',
          messageId: source.id,
          sourceMessageIds: [source.id],
          segmentId: 'tool-detail:u1',
          selectionStart: 0,
          selectionEnd: 6,
          sourceProjectionVersion: 1,
          sourceProjectionSha256: digestMessageBundleCliQuoteProjection('SECOND'),
        },
      ],
    };

    const reread = await resolver.resolveCarrier(carrier, auth);

    assert.equal(reread.status, 'resolved');
    assert.equal(reread.items[0].status, 'available');
    assert.equal(reread.items[0].readableContent, 'SECOND');
  });
});
