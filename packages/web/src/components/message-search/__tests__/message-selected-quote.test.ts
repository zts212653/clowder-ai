import type { MessageSearchResult } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { messageSourceQuote } from '../message-source-read';

const text = '只有通过测试才上线。';
const selectedStart = text.indexOf('上线');
const comment = '我还没有批准。';
const row: MessageSearchResult = {
  threadId: 'sources',
  messageId: 'publisher',
  threadTitle: 'review',
  speaker: 'user',
  timestamp: 30,
  timelineOrderAt: 30,
  contentRevision: 'a'.repeat(64),
  publiclyQuotable: true,
  snippet: { text, start: 0, end: text.length, source: 'attachment-text' },
  highlights: [],
  match: 'selected',
  selection: {
    v: 1,
    quote: '上线',
    reason: '猫的推论',
    part: { kind: 'quote', blockIndex: 1 },
    range: { start: selectedStart, end: selectedStart + 2 },
    sourceDigest: 'b'.repeat(64),
    headingPath: [],
    context: {
      text,
      start: 0,
      end: text.length,
      quoteStart: selectedStart,
      quoteEnd: selectedStart + 2,
      truncatedBefore: false,
      truncatedAfter: false,
    },
    quotation: {
      text,
      truncated: false,
      origin: {
        threadId: 'earlier',
        messageId: 'original',
        contentRevision: 'c'.repeat(64),
        sourceDigest: 'd'.repeat(64),
        speaker: 'gemini-argon',
        timestamp: 20,
        headingPath: ['历史备选（未采用）'],
      },
    },
    comment: { text: comment, truncated: false },
  },
};
const source = {
  threadId: row.threadId,
  messageId: row.messageId,
  content: `我看过这个方案。\n\n${text}\n\n${comment}`,
  speaker: 'user',
  timestamp: 30,
  contentRevision: row.contentRevision,
  truncated: false,
};
const resolve = (id: string) => (id === 'user' ? 'co-creator' : id === 'gemini-argon' ? '烁烁' : id);

it('quotes the verified structure and conditions without crediting the whole composite to the publisher', () => {
  const value = messageSourceQuote(row, source, resolve);
  expect(value.kind).toBe('quote');
  if (value.kind !== 'quote' || value.source.kind !== 'message') throw new Error('wrong quote');
  expect(value.text).toContain('引自 烁烁');
  expect(value.text).toContain('历史备选（未采用）');
  expect(value.text).toContain(text);
  expect(value.text).toContain(`co-creator 当条批注：「${comment}」`);
  expect(value.text).not.toContain('猫的推论');
  expect(value.source).toMatchObject({ threadId: 'sources', messageId: 'publisher' });
  expect(value.source.displayLabel).toContain('结构化摘录');
  expect(value.source.senderCatId).toBeUndefined();
  expect(value.comment).toBeUndefined();
});

it('does not invent an original author or source link when only the current quotation is verified', () => {
  const selected = structuredClone(row);
  delete selected.selection!.quotation!.origin;
  const value = messageSourceQuote(selected, source, resolve);
  expect(value.kind).toBe('quote');
  if (value.kind !== 'quote') throw new Error('wrong quote');
  expect(value.text).toContain('未核实原出处作者');
  expect(value.text).not.toMatch(/烁烁|earlier|original/);
  expect(value.text).toContain(`co-creator 当条批注：「${comment}」`);
});
