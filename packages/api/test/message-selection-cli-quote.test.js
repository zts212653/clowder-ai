import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

await import('tsx/esm');
const {
  MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN_V2,
  MessageSelectionResolver,
  digestMessageBundleCliQuoteProjection,
  digestMessageBundleCliQuoteProjectionV2,
  projectCliSegmentReadable,
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

describe('MessageSelectionResolver CLI Quote admission', () => {
  it('admits only the exact selected CLI stdout range from one canonical bubble group', async () => {
    const stream = makeMessage({
      id: 'message-stream',
      catId: 'codex-sol',
      content: 'alpha beta gamma',
      origin: 'stream',
      isStreaming: true,
      deliveredAt: 300,
      extra: { stream: { invocationId: 'inv-1', turnInvocationId: 'turn-1' } },
    });
    const final = makeMessage({
      id: 'message-final',
      catId: 'codex-sol',
      content: 'neighboring stream detail',
      origin: 'stream',
      isStreaming: false,
      timestamp: 101,
      deliveredAt: 200,
      extra: { stream: { invocationId: 'inv-1', turnInvocationId: 'turn-1' } },
    });
    const { resolver } = createResolver({ messages: [stream, final] });

    const result = await resolver.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        note: 'why this matters',
        items: [
          {
            kind: 'cli_quote',
            messageId: stream.id,
            sourceMessageIds: [stream.id, final.id],
            segmentId: 'stdout',
            text: 'beta',
            selectionStart: 6,
            selectionEnd: 10,
            comment: 'look here',
          },
        ],
      },
      auth,
    );

    assert.equal(result.status, 'resolved');
    assert.equal(result.carrier.note, 'why this matters');
    assert.deepEqual(result.carrier.items[0], {
      kind: 'cli_quote',
      messageId: stream.id,
      sourceMessageIds: [stream.id, final.id],
      segmentId: 'stdout',
      selectionStart: 6,
      selectionEnd: 10,
      sourceProjectionVersion: 1,
      sourceProjectionSha256: digestMessageBundleCliQuoteProjection('alpha beta gamma\n\nneighboring stream detail'),
      comment: 'look here',
    });
    assert.equal(result.items[0].kind, 'cli_quote');
    assert.equal(result.items[0].readableContent, 'beta');
    assert.equal(JSON.stringify(result.carrier).includes('neighboring stream detail'), false);
    assert.equal(MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN.endsWith('\0'), true);
  });

  it('admits a unique browser-visible row from Markdown-rendered CLI stdout and rereads it in the same plane', async () => {
    const markdown = [
      '| Surface | Status | Meaning |',
      '| --- | --- | --- |',
      '| Hub Browser Preview | `no_matching_client` | 不属于本 thread 的修复责任 |',
    ].join('\n');
    const browserText = 'Hub Browser Preview\tno_matching_client\t不属于本 thread 的修复责任';
    const message = makeMessage({
      id: 'message-markdown-table',
      catId: 'codex-sol',
      content: markdown,
      origin: 'stream',
      isStreaming: false,
      extra: { stream: { invocationId: 'inv-table', turnInvocationId: 'turn-table' } },
    });
    const { resolver } = createResolver({ messages: [message] });

    const result = await resolver.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [
          {
            kind: 'cli_quote',
            messageId: message.id,
            sourceMessageIds: [message.id],
            segmentId: 'stdout',
            text: browserText,
            selectionStart: 23,
            selectionEnd: 23 + browserText.length,
            sourceProjectionVersion: 2,
            renderedOccurrences: 1,
          },
        ],
      },
      auth,
    );

    assert.equal(result.status, 'resolved');
    const readableProjection = projectCliSegmentReadable(markdown);
    assert.ok(readableProjection);
    assert.deepEqual(result.carrier.items[0], {
      kind: 'cli_quote',
      messageId: message.id,
      sourceMessageIds: [message.id],
      segmentId: 'stdout',
      selectionStart: readableProjection.indexOf('Hub Browser Preview'),
      selectionEnd: readableProjection.length,
      sourceProjectionVersion: 2,
      sourceProjectionSha256: digestMessageBundleCliQuoteProjectionV2(readableProjection),
    });
    assert.equal(result.items[0].readableContent, 'Hub Browser Preview no_matching_client 不属于本 thread 的修复责任');
    assert.equal(MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN_V2.endsWith('\0'), true);

    const reread = await resolver.resolveCarrier(result.carrier, auth);
    assert.equal(reread.status, 'resolved');
    assert.equal(reread.items[0].status, 'available');
    assert.equal(reread.items[0].readableContent, result.items[0].readableContent);
  });

  it('mirrors the retained R21 cached-speech stdout fallback only in the readable v2 plane', async () => {
    const message = makeMessage({
      id: 'cached-r21-stream-only',
      catId: 'codex-sol',
      content: '',
      origin: 'stream',
      isStreaming: false,
      extra: {
        stream: {
          invocationId: 'inv-cached-r21',
          turnInvocationId: 'turn-cached-r21',
          cliStdout: '',
          speechContent: 'CACHED_R21_SPEECH',
        },
      },
    });
    const { resolver } = createResolver({ messages: [message] });

    const readable = await resolver.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [
          {
            kind: 'cli_quote',
            messageId: message.id,
            sourceMessageIds: [message.id],
            segmentId: 'stdout',
            text: 'CACHED_R21_SPEECH',
            selectionStart: 0,
            selectionEnd: 'CACHED_R21_SPEECH'.length,
            sourceProjectionVersion: 2,
            renderedOccurrences: 1,
          },
        ],
      },
      auth,
    );

    assert.equal(readable.status, 'resolved');
    assert.equal(readable.items[0].readableContent, 'CACHED_R21_SPEECH');
    assert.deepEqual(readable.carrier.items[0], {
      kind: 'cli_quote',
      messageId: message.id,
      sourceMessageIds: [message.id],
      segmentId: 'stdout',
      selectionStart: 0,
      selectionEnd: 'CACHED_R21_SPEECH'.length,
      sourceProjectionVersion: 2,
      sourceProjectionSha256: digestMessageBundleCliQuoteProjectionV2('CACHED_R21_SPEECH'),
    });

    const reread = await resolver.resolveCarrier(readable.carrier, auth);
    assert.equal(reread.status, 'resolved');
    assert.equal(reread.items[0].status, 'available');
    assert.equal(reread.items[0].readableContent, 'CACHED_R21_SPEECH');

    const legacy = await resolver.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [
          {
            kind: 'cli_quote',
            messageId: message.id,
            sourceMessageIds: [message.id],
            segmentId: 'stdout',
            text: 'CACHED_R21_SPEECH',
            selectionStart: 0,
            selectionEnd: 'CACHED_R21_SPEECH'.length,
          },
        ],
      },
      auth,
    );
    assert.deepEqual(legacy, {
      status: 'invalid',
      reason: 'source_unavailable',
      messageId: message.id,
    });
  });

  it('keeps Markdown-rendered CLI stdout fail-closed for repeated or renderer-generated text', async () => {
    const repeated = makeMessage({
      id: 'message-markdown-repeat',
      catId: 'codex-sol',
      content: '| Value |\n| --- |\n| `retry failed` |\n| retry failed |',
      origin: 'stream',
      isStreaming: false,
      extra: { stream: { turnInvocationId: 'turn-markdown-repeat' } },
    });
    const generated = makeMessage({
      id: 'message-markdown-generated',
      catId: 'codex-sol',
      content: '正文[^a]\n\n[^a]: 脚注内容',
      origin: 'stream',
      isStreaming: false,
      extra: { stream: { turnInvocationId: 'turn-markdown-generated' } },
    });
    const { resolver } = createResolver({ messages: [repeated, generated] });

    const selection = (message, text) => ({
      sourceThreadId: 'thread-source',
      items: [
        {
          kind: 'cli_quote',
          messageId: message.id,
          sourceMessageIds: [message.id],
          segmentId: 'stdout',
          text,
          selectionStart: 0,
          selectionEnd: text.length,
          sourceProjectionVersion: 2,
          renderedOccurrences: 1,
        },
      ],
    });

    assert.deepEqual(await resolver.resolveForAdmission(selection(repeated, 'retry failed'), auth), {
      status: 'invalid',
      reason: 'ambiguous_quote',
      messageId: repeated.id,
    });
    assert.deepEqual(await resolver.resolveForAdmission(selection(generated, '正文'), auth), {
      status: 'invalid',
      reason: 'unsupported_source',
      messageId: generated.id,
    });
  });

  it('keeps CLI ranges strictly canonical: repeated text is only admitted by exact coordinates', async () => {
    // Tool labels/details and legacy CLI clients remain in the raw v1 plane. Their coordinates
    // are authoritative, and repeated text must never be re-anchored by a normalized guess.
    const bubble = makeMessage({
      id: 'message-repeat',
      catId: 'codex-sol',
      content: 'retry failed\nretry failed',
      origin: 'stream',
      isStreaming: false,
      extra: { stream: { invocationId: 'inv-2', turnInvocationId: 'turn-2' } },
    });

    async function admit(overrides) {
      const { resolver } = createResolver({ messages: [makeMessage({ ...bubble })] });
      return resolver.resolveForAdmission(
        {
          sourceThreadId: 'thread-source',
          items: [
            {
              kind: 'cli_quote',
              messageId: bubble.id,
              sourceMessageIds: [bubble.id],
              segmentId: 'stdout',
              text: 'retry failed',
              ...overrides,
            },
          ],
        },
        auth,
      );
    }

    const exact = await admit({ selectionStart: 13, selectionEnd: 25 });
    assert.equal(exact.status, 'resolved');
    assert.equal(exact.carrier.items[0].selectionStart, 13);

    const stale = await admit({ selectionStart: 14, selectionEnd: 26 });
    assert.deepEqual(stale, { status: 'invalid', reason: 'ambiguous_quote', messageId: bubble.id });

    const driftedWhitespace = await admit({ text: 'retry  failed', selectionStart: 13, selectionEnd: 26 });
    assert.deepEqual(driftedWhitespace, { status: 'invalid', reason: 'quote_mismatch', messageId: bubble.id });
  });

  it('rejects refs that mix a stream CLI bubble with separate callback speech', async () => {
    const stream = makeMessage({
      id: 'message-stream',
      catId: 'codex-sol',
      content: 'alpha beta gamma',
      origin: 'stream',
      isStreaming: false,
      extra: { stream: { invocationId: 'inv-1', turnInvocationId: 'turn-1' } },
    });
    const callback = makeMessage({
      id: 'message-callback',
      catId: 'codex-sol',
      content: 'separate callback speech',
      origin: 'callback',
      timestamp: 101,
      extra: { stream: { invocationId: 'inv-1', turnInvocationId: 'turn-1' } },
    });
    const { resolver } = createResolver({ messages: [stream, callback] });

    const result = await resolver.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [
          {
            kind: 'cli_quote',
            messageId: stream.id,
            sourceMessageIds: [stream.id, callback.id],
            segmentId: 'stdout',
            text: 'beta',
            selectionStart: 6,
            selectionEnd: 10,
          },
        ],
      },
      auth,
    );

    assert.deepEqual(result, { status: 'invalid', reason: 'source_unavailable', messageId: stream.id });
  });

  it('accepts a finalized CLI group with an earlier streaming record and rejects a still-live group', async () => {
    const earlier = makeMessage({
      id: 'message-streaming-earlier',
      catId: 'codex-sol',
      content: 'alpha ',
      origin: 'stream',
      isStreaming: true,
      extra: { stream: { turnInvocationId: 'turn-terminal-check' } },
    });
    const final = makeMessage({
      id: 'message-streaming-final',
      catId: 'codex-sol',
      content: 'beta',
      origin: 'stream',
      isStreaming: false,
      timestamp: 101,
      extra: { stream: { turnInvocationId: 'turn-terminal-check' } },
    });
    const { resolver } = createResolver({ messages: [earlier, final] });
    const item = {
      kind: 'cli_quote',
      messageId: final.id,
      sourceMessageIds: [earlier.id, final.id],
      segmentId: 'stdout',
      text: 'beta',
      selectionStart: 7,
      selectionEnd: 11,
    };

    assert.equal(
      (await resolver.resolveForAdmission({ sourceThreadId: 'thread-source', items: [item] }, auth)).status,
      'resolved',
    );
    assert.deepEqual(
      await resolver.resolveForAdmission(
        {
          sourceThreadId: 'thread-source',
          items: [
            {
              ...item,
              messageId: earlier.id,
              sourceMessageIds: [earlier.id],
              text: 'alpha',
              selectionStart: 0,
              selectionEnd: 5,
            },
          ],
        },
        auth,
      ),
      { status: 'invalid', reason: 'source_unavailable', messageId: earlier.id },
    );
  });

  it('rejects an omitted live CLI record and tombstones an existing partial carrier', async () => {
    const finished = makeMessage({
      id: 'message-cli-finished',
      catId: 'codex-sol',
      content: 'alpha beta',
      origin: 'stream',
      isStreaming: false,
      extra: { stream: { turnInvocationId: 'turn-forged-cli' } },
    });
    const live = makeMessage({
      id: 'message-cli-live',
      catId: 'codex-sol',
      content: 'still running',
      origin: 'stream',
      isStreaming: true,
      timestamp: 101,
      extra: { stream: { turnInvocationId: 'turn-forged-cli' } },
    });
    const { resolver } = createResolver({ messages: [finished, live] });
    const partialItem = {
      kind: 'cli_quote',
      messageId: finished.id,
      sourceMessageIds: [finished.id],
      segmentId: 'stdout',
      text: 'beta',
      selectionStart: 6,
      selectionEnd: 10,
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
            kind: 'cli_quote',
            messageId: finished.id,
            sourceMessageIds: [finished.id],
            segmentId: 'stdout',
            selectionStart: 6,
            selectionEnd: 10,
            sourceProjectionVersion: 1,
            sourceProjectionSha256: digestMessageBundleCliQuoteProjection('alpha beta'),
          },
        ],
      },
      auth,
    );
    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.items, [{ status: 'tombstone', messageId: finished.id, reason: 'source_changed' }]);
  });

  it('keeps the same invocation in separate canonical groups across a user turn boundary', async () => {
    const first = makeMessage({
      id: 'message-first-turn',
      catId: 'codex-sol',
      origin: 'stream',
      isStreaming: false,
      extra: { stream: { turnInvocationId: 'reused-turn-id' } },
    });
    const user = makeMessage({ id: 'message-user-boundary', content: 'continue', timestamp: 101 });
    const second = makeMessage({
      id: 'message-second-turn',
      catId: 'codex-sol',
      origin: 'stream',
      isStreaming: false,
      timestamp: 102,
      extra: { stream: { turnInvocationId: 'reused-turn-id' } },
    });
    const { resolver } = createResolver({ messages: [first, user, second] });

    const result = await resolver.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [
          {
            kind: 'cli_quote',
            messageId: first.id,
            sourceMessageIds: [first.id],
            segmentId: 'stdout',
            text: 'alpha',
            selectionStart: 0,
            selectionEnd: 5,
          },
        ],
      },
      auth,
    );

    assert.equal(result.status, 'resolved');
  });

  it('projects a paired tool result detail by the stable tool-use segment id', async () => {
    const message = makeMessage({
      id: 'message-cli-tools',
      catId: 'codex-sol',
      content: '',
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-tool', turnInvocationId: 'turn-tool' } },
      toolEvents: [
        { id: 'tool-1', type: 'tool_use', label: 'codex-sol → Read', detail: '{"file_path":"spec.md"}', timestamp: 1 },
        {
          id: 'result-1',
          type: 'tool_result',
          label: 'codex-sol ← result',
          detail: 'first line\nsecond line',
          timestamp: 2,
        },
      ],
    });
    const { resolver } = createResolver({ messages: [message] });

    const result = await resolver.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [
          {
            kind: 'cli_quote',
            messageId: message.id,
            sourceMessageIds: [message.id],
            segmentId: 'tool-detail:tool-1',
            text: 'second',
            selectionStart: 11,
            selectionEnd: 17,
          },
        ],
      },
      auth,
    );

    assert.equal(result.status, 'resolved');
    assert.equal(result.items[0].readableContent, 'second');
  });

  it('rejects CLI refs spanning different canonical bubble groups', async () => {
    const first = makeMessage({
      id: 'message-first',
      catId: 'codex-sol',
      origin: 'stream',
      extra: { stream: { turnInvocationId: 'turn-1' } },
    });
    const second = makeMessage({
      id: 'message-second',
      catId: 'codex-sol',
      origin: 'stream',
      extra: { stream: { turnInvocationId: 'turn-2' } },
    });
    const { resolver } = createResolver({ messages: [first, second] });

    const result = await resolver.resolveForAdmission(
      {
        sourceThreadId: 'thread-source',
        items: [
          {
            kind: 'cli_quote',
            messageId: first.id,
            sourceMessageIds: [first.id, second.id],
            segmentId: 'stdout',
            text: 'alpha',
            selectionStart: 0,
            selectionEnd: 5,
          },
        ],
      },
      auth,
    );

    assert.deepEqual(result, { status: 'invalid', reason: 'source_unavailable', messageId: first.id });
  });
});
