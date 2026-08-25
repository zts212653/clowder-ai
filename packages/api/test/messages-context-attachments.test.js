import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildMessageContentBlocks, sendMessageSchema } from '../dist/routes/messages.schema.js';
import { parseMultipart } from '../dist/routes/parse-multipart.js';

const attachment = {
  v: 1,
  id: 'ctx-thread-1',
  kind: 'thread',
  threadId: 'thread_abc123',
  title: 'F063 Context Attachments',
};

describe('messages ContextAttachment request contract', () => {
  it('accepts attachment-only sends and rejects a completely empty send', () => {
    const attachmentOnly = sendMessageSchema.safeParse({ content: '', contextAttachments: [attachment] });
    assert.equal(attachmentOnly.success, true);
    assert.equal(sendMessageSchema.safeParse({ content: '' }).success, false);
  });

  it('parses multipart JSON and enforces the attachment count bound', () => {
    const parsed = sendMessageSchema.safeParse({
      content: 'look here',
      contextAttachments: JSON.stringify([attachment]),
    });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.contextAttachments, [attachment]);
    assert.equal(
      sendMessageSchema.safeParse({
        content: 'too many',
        contextAttachments: Array.from({ length: 13 }, () => attachment),
      }).success,
      false,
    );
  });

  it('rejects an attachment collection whose aggregate model projection exceeds the shared budget', () => {
    const maximalQuotes = Array.from({ length: 12 }, (_, index) => ({
      v: 1,
      id: `ctx-quote-${index}`,
      kind: 'quote',
      text: 'x'.repeat(20_000),
      source: { kind: 'message', threadId: 'thread_abc123', messageId: `msg_${index}` },
    }));

    assert.equal(
      sendMessageSchema.safeParse({ content: 'bounded aggregate', contextAttachments: maximalQuotes }).success,
      false,
    );
  });

  it('builds the same attachment block from the multipart boundary', async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), 'cat-cafe-context-attachment-'));
    const request = {
      parts: async function* () {
        yield { type: 'field', fieldname: 'content', value: '' };
        yield { type: 'field', fieldname: 'contextAttachments', value: JSON.stringify([attachment]) };
      },
    };

    try {
      const parsed = await parseMultipart(request, uploadDir);
      assert.ok(!('error' in parsed));
      assert.deepEqual(parsed.contentBlocks, [{ type: 'context_attachment', attachment }]);
    } finally {
      await rm(uploadDir, { recursive: true, force: true });
    }
  });

  it('builds canonical text, attachment, then image content block order', () => {
    assert.deepEqual(
      buildMessageContentBlocks('hello', [attachment], [{ type: 'image', url: 'https://example.com/a.png' }]),
      [
        { type: 'text', text: 'hello' },
        { type: 'context_attachment', attachment },
        { type: 'image', url: 'https://example.com/a.png' },
      ],
    );
    assert.deepEqual(buildMessageContentBlocks('', [attachment]), [{ type: 'context_attachment', attachment }]);
  });
});

describe('F294 Message Bundle item identity validation', () => {
  it('accepts distinct Rich Blocks from one projected message but rejects an exact duplicate', () => {
    const first = {
      kind: 'rich_block',
      messageId: 'source-message',
      sourceMessageIds: ['source-message'],
      blockId: 'block-a',
    };
    const request = {
      content: '',
      threadId: 'target-thread',
      messageBundle: {
        sourceThreadId: 'source-thread',
        targetCats: ['opus'],
        items: [first, { ...first, blockId: 'block-b' }],
      },
    };

    assert.equal(sendMessageSchema.safeParse(request).success, true);
    assert.equal(
      sendMessageSchema.safeParse({
        ...request,
        messageBundle: { ...request.messageBundle, items: [first, first] },
      }).success,
      false,
    );
  });
});
