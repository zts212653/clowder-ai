import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

await import('tsx/esm');
const { MessageSelectionResolver, digestMessageBundleQuoteProjectionV2 } = await import(
  '../src/domains/cats/services/context/MessageSelectionResolver.ts'
);

/**
 * A chat bubble is a *projection over several stored records*: the web client joins the rows of one
 * canonical group into a single bubble whose id is the anchor row. Whole-message selection used to
 * judge that anchor row alone, so a bubble whose prose lives in a sibling row looked empty to the
 * server and came back as a `source_unavailable` tombstone — even though the human could read it on
 * screen and the client had offered it for selection.
 *
 * The mirror defect is just as real: when the anchor row *does* read fine on its own, resolving
 * only that row silently drops the siblings' prose from whatever gets exported or forwarded. The
 * human selected the bubble, so the bubble is the unit — always.
 */
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

function makeRecord(overrides = {}) {
  return {
    id: 'message-1',
    threadId: 'thread-source',
    userId: 'user-1',
    catId: 'codex-sol',
    content: '',
    mentions: [],
    timestamp: 100,
    deliveryStatus: 'delivered',
    ...overrides,
  };
}

/**
 * One bubble: several stream rows from the same invocation. The canonical anchor carries the tool
 * events and no prose of its own, exactly like a CLI Output bubble whose narration lands in a later
 * row of the same turn.
 */
function cliBubbleRecords() {
  const streamBase = {
    origin: 'stream',
    isStreaming: false,
    extra: { stream: { invocationId: 'inv-1', turnInvocationId: 'turn-1' } },
  };
  return [
    makeRecord({ id: 'message-anchor', content: '', timestamp: 100, ...streamBase }),
    makeRecord({
      id: 'message-narration',
      content: '我先派了两只猫去查 hook evidence。',
      timestamp: 101,
      ...streamBase,
    }),
  ];
}

function createResolver(messages) {
  const messageMap = new Map(messages.map((message) => [message.id, message]));
  return new MessageSelectionResolver({
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
  });
}

const auth = { userId: 'user-1' };

async function admitMessage(resolver, messageId) {
  return resolver.resolveForAdmission(
    { sourceThreadId: 'thread-source', items: [{ kind: 'message', messageId }] },
    auth,
  );
}

/** One bubble where BOTH rows carry visible prose — the reader sees them as one message. */
function twoVisibleRowsBubble() {
  const streamBase = {
    origin: 'stream',
    isStreaming: false,
    extra: { stream: { invocationId: 'inv-2', turnInvocationId: 'turn-2' } },
  };
  return [
    makeRecord({ id: 'message-anchor', content: '屏幕上的第一段', timestamp: 100, ...streamBase }),
    makeRecord({ id: 'message-sibling', content: '屏幕上的第二段', timestamp: 101, ...streamBase }),
  ];
}

async function admitQuote(resolver, item) {
  return resolver.resolveForAdmission(
    { sourceThreadId: 'thread-source', items: [{ kind: 'quote', renderedOccurrences: 1, ...item }] },
    auth,
  );
}

describe('whole-message selection resolves the bubble, not a single stored row', () => {
  it('admits a bubble whose readable text lives in a sibling record', async () => {
    const records = cliBubbleRecords();
    const result = await admitMessage(createResolver(records), 'message-anchor');

    assert.equal(result.status, 'resolved', 'a readable bubble must not come back as a tombstone');
    assert.match(result.items[0].readableContent, /我先派了两只猫去查 hook evidence。/);
  });

  it('keeps the anchor identity and refs-only carrier shape', async () => {
    const result = await admitMessage(createResolver(cliBubbleRecords()), 'message-anchor');

    assert.deepEqual(result.carrier.items[0], { kind: 'message', messageId: 'message-anchor' });
    assert.equal(JSON.stringify(result.carrier).includes('我先派了两只猫'), false, 'carrier stays refs-only');
  });

  it('still fails closed when the whole bubble has no readable content', async () => {
    const silent = cliBubbleRecords().map((record) => ({ ...record, content: '' }));
    const result = await admitMessage(createResolver(silent), 'message-anchor');

    assert.deepEqual(result, { status: 'invalid', reason: 'source_unavailable', messageId: 'message-anchor' });
  });

  it('still fails closed when a sibling in the bubble is not accessible', async () => {
    const [stream, callback] = cliBubbleRecords();
    const foreign = { ...callback, userId: 'user-2' };
    const result = await admitMessage(createResolver([stream, foreign]), 'message-anchor');

    assert.deepEqual(result, { status: 'invalid', reason: 'source_unavailable', messageId: 'message-anchor' });
  });

  it('carries every visible row of the bubble, not just a readable anchor', async () => {
    const result = await admitMessage(createResolver(twoVisibleRowsBubble()), 'message-anchor');

    assert.equal(result.status, 'resolved');
    assert.match(result.items[0].readableContent, /屏幕上的第一段/);
    assert.match(
      result.items[0].readableContent,
      /屏幕上的第二段/,
      'a readable anchor must not make the sibling disappear from the selection',
    );
  });

  it('re-reads a persisted bundle with the same bubble fidelity as admission', async () => {
    const records = twoVisibleRowsBubble();
    const admitted = await admitMessage(createResolver(records), 'message-anchor');
    assert.equal(admitted.status, 'resolved');

    const reread = await createResolver(records).resolveCarrier(
      { v: 1, sourceThreadId: 'thread-source', items: admitted.carrier.items },
      auth,
    );

    assert.equal(reread.status, 'resolved');
    assert.equal(
      reread.items[0].readableContent,
      admitted.items[0].readableContent,
      'a stored bundle must re-read as the same bubble it was admitted from',
    );
  });
});

describe('quote selection anchors inside the bubble, not only its anchor row', () => {
  it('anchors a highlight that lives in a sibling row of an empty-anchor bubble', async () => {
    const records = cliBubbleRecords();
    const result = await admitQuote(createResolver(records), {
      messageId: 'message-anchor',
      text: '我先派了两只猫',
    });

    assert.equal(result.status, 'resolved', 'a highlight the human can read must not be unavailable');
    assert.equal(result.items[0].readableContent, '我先派了两只猫');
    assert.equal(result.carrier.items[0].messageId, 'message-anchor');
    assert.equal(result.carrier.items[0].sourceProjectionVersion, 3);
  });

  it('anchors a highlight from a sibling row even when the anchor row reads fine', async () => {
    const result = await admitQuote(createResolver(twoVisibleRowsBubble()), {
      messageId: 'message-anchor',
      text: '屏幕上的第二段',
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.items[0].readableContent, '屏幕上的第二段');
    assert.equal(result.carrier.items[0].messageId, 'message-anchor');
  });

  it('re-reads a sibling-anchored quote with the same characters it was admitted with', async () => {
    const records = twoVisibleRowsBubble();
    const admitted = await admitQuote(createResolver(records), {
      messageId: 'message-anchor',
      text: '屏幕上的第二段',
    });
    assert.equal(admitted.status, 'resolved');

    const reread = await createResolver(records).resolveCarrier(
      { v: 1, sourceThreadId: 'thread-source', items: admitted.carrier.items },
      auth,
    );

    assert.equal(reread.status, 'resolved');
    assert.equal(reread.items[0].readableContent, admitted.items[0].readableContent);
  });

  it('admits a highlight that spans two stored rows of one visible bubble', async () => {
    const records = twoVisibleRowsBubble();
    const result = await admitQuote(createResolver(records), {
      messageId: 'message-anchor',
      // Chromium Selection.toString() inserts a paragraph break when one selection crosses the
      // two rendered paragraphs. The browser exposes one bubble, so this is one valid quote even
      // though no individual storage row contains all of its characters.
      text: '第一段\n\n屏幕上的第二',
    });

    assert.equal(result.status, 'resolved', 'a visible cross-row highlight must resolve in bubble space');
    assert.equal(result.items[0].readableContent, '第一段\n\n屏幕上的第二');
    assert.equal(result.carrier.items[0].messageId, 'message-anchor');
    assert.equal(result.carrier.items[0].sourceProjectionVersion, 3);

    const reread = await createResolver(records).resolveCarrier(
      { v: 1, sourceThreadId: 'thread-source', items: result.carrier.items },
      auth,
    );
    assert.equal(reread.status, 'resolved');
    assert.equal(reread.items[0].readableContent, result.items[0].readableContent);
  });

  it('admits the exact cross-paragraph text emitted by the real Chromium MessageActions fixture', async () => {
    const records = twoVisibleRowsBubble().map((record) => ({ ...record, content: 'foo' }));
    const result = await admitQuote(createResolver(records), {
      messageId: 'message-anchor',
      text: 'oo\n\nfo',
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.items[0].readableContent, 'oo\n\nfo');
    assert.equal(result.carrier.items[0].sourceProjectionVersion, 3);
  });

  it('refuses characters that no row of the bubble contains', async () => {
    const result = await admitQuote(createResolver(twoVisibleRowsBubble()), {
      messageId: 'message-anchor',
      text: '这段话不在任何一行里',
    });

    assert.deepEqual(result, { status: 'invalid', reason: 'quote_mismatch', messageId: 'message-anchor' });
  });

  it('refuses characters that two rows of the same bubble both contain', async () => {
    const repeated = twoVisibleRowsBubble().map((record) => ({ ...record, content: '同一句话' }));
    const result = await admitQuote(createResolver(repeated), { messageId: 'message-anchor', text: '同一句话' });

    assert.deepEqual(result, { status: 'invalid', reason: 'ambiguous_quote', messageId: 'message-anchor' });
  });
});

/**
 * New selections are made in browser-bubble space. Whole messages read through current rows, while
 * exact quotes keep a digest of the admitted bubble projection. Historical v1/v2 quote carriers
 * remain row-scoped so existing forwarded evidence does not retroactively change meaning.
 */
describe('re-reading uses the unit each selection was made in', () => {
  it('tombstones a v3 quote when one row changes its admitted bubble projection', async () => {
    const records = twoVisibleRowsBubble();
    const admitted = await admitQuote(createResolver(records), {
      messageId: 'message-anchor',
      text: '屏幕上的第二段',
    });
    assert.equal(admitted.status, 'resolved');
    assert.equal(admitted.carrier.items[0].messageId, 'message-anchor');

    const withoutSibling = records.filter((record) => record.id === 'message-anchor');
    const reread = await createResolver(withoutSibling).resolveCarrier(
      { v: 1, sourceThreadId: 'thread-source', items: admitted.carrier.items },
      auth,
    );

    assert.equal(reread.status, 'resolved');
    assert.equal(reread.items[0].status, 'tombstone');
    assert.equal(reread.items[0].reason, 'source_changed');
  });

  it('keeps historical v2 row carriers readable without an unrelated bubble row', async () => {
    const sibling = twoVisibleRowsBubble()[1];
    const projection = sibling.content;
    const reread = await createResolver([sibling]).resolveCarrier(
      {
        v: 1,
        sourceThreadId: 'thread-source',
        items: [
          {
            kind: 'quote',
            messageId: sibling.id,
            selectionStart: 0,
            selectionEnd: projection.length,
            sourceProjectionVersion: 2,
            sourceProjectionSha256: digestMessageBundleQuoteProjectionV2(projection),
          },
        ],
      },
      auth,
    );

    assert.equal(reread.status, 'resolved');
    assert.equal(reread.items[0].readableContent, projection);
  });

  it('re-reads a whole-message selection from the bubble rows that still exist', async () => {
    // Refs-only carriers are read through to current truth, so losing a sibling narrows what the
    // bundle shows rather than tombstoning it. Only losing *everything* readable fails closed,
    // which the admission suite covers separately.
    const records = twoVisibleRowsBubble();
    const admitted = await admitMessage(createResolver(records), 'message-anchor');
    assert.equal(admitted.status, 'resolved');

    const withoutSibling = records.filter((record) => record.id === 'message-anchor');
    const reread = await createResolver(withoutSibling).resolveCarrier(
      { v: 1, sourceThreadId: 'thread-source', items: admitted.carrier.items },
      auth,
    );

    assert.equal(reread.status, 'resolved');
    assert.equal(
      reread.items[0].readableContent,
      '屏幕上的第一段',
      'the bubble is re-read from whatever rows still exist, never from a stale copy',
    );
  });
});
