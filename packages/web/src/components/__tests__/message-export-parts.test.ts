import type { ResolvedMessageSelectionItem } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { projectMessagePartsForImage } from '../message-export-parts';

const message: ChatMessage = {
  id: 'source',
  type: 'assistant',
  catId: 'codex61-sol',
  timestamp: 1,
  content: '两件都弄好了：',
  extra: {
    stream: { cliStdout: 'private stdout' },
    rich: {
      v: 1,
      blocks: [
        { id: 'result', kind: 'card', v: 1, title: '审批卡统一结果行' },
        { id: 'quota', kind: 'card', v: 1, title: '额度表 · 本周' },
      ],
    },
  },
};
const base = {
  status: 'available' as const,
  messageId: 'source',
  sourceThreadId: 'test',
  from: { kind: 'agent' as const, catId: 'codex61-sol' },
  timestamp: 1,
};
const card: ResolvedMessageSelectionItem = {
  ...base,
  kind: 'rich_block',
  readableContent: '审批卡统一结果行',
  richBlock: message.extra!.rich!.blocks[0],
};
it('filters a partial image to the resolved body and selected cards without mutating live messages', () => {
  const image = projectMessagePartsForImage(message, [
    { ...base, kind: 'quote', readableContent: '两件都弄好了：' },
    card,
  ]);
  expect(image.extra?.rich?.blocks.map((block) => block.id)).toEqual(['result']);
  expect(image.content).toBe('两件都弄好了：');
  expect(message.extra?.rich?.blocks).toHaveLength(2);
});
it('does not revive body, attachments or CLI for a card-only image', () => {
  const image = projectMessagePartsForImage(message, [card]);
  expect(image.content).toBe('');
  expect(image.contentBlocks).toEqual([]);
  expect(image.extra?.stream).toBeUndefined();
  expect(image.extra?.rich?.blocks.map((block) => block.id)).toEqual(['result']);
});
