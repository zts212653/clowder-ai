import { serializeContextAttachmentsPrompt } from '@cat-cafe/shared';
import { beforeEach, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { addAssetToChat } from '../asset-canon-chat';
import { item } from './asset-canon.fixtures';

beforeEach(() => {
  useChatStore.setState({ pendingChatInsert: null });
});
it('queues an exact file version and film reference, preserving words and other chips without sending', () => {
  useChatStore.setState({
    pendingChatInsert: {
      threadId: 'film',
      text: '原来的话',
      contextAttachments: [{ v: 1, id: 'thread', kind: 'thread', threadId: 'another', title: '另一条对话' }],
    },
  });
  expect(addAssetToChat('film', item)).toBeNull();
  const queued = useChatStore.getState().pendingChatInsert!;
  expect(queued.text).toBe('原来的话');
  expect(queued.contextAttachments).toHaveLength(2);
  const attachment = queued.contextAttachments![1]!;
  expect(attachment).toMatchObject({
    kind: 'asset',
    indexedVersionRef: item.record.indexedVersionRef,
    work: item.work,
  });
  expect(serializeContextAttachmentsPrompt([attachment])).toContain('"ownerRevision":4');
  expect(serializeContextAttachmentsPrompt([attachment])).not.toContain('"path"');
  expect(addAssetToChat('film', item)).toBeNull();
  expect(useChatStore.getState().pendingChatInsert!.contextAttachments).toHaveLength(2);
  expect(
    addAssetToChat('film', {
      ...item,
      work: { ...item.work!, reference: { ...item.work!.reference, ownerRevision: 5 } },
    }),
  ).toBeNull();
  expect(useChatStore.getState().pendingChatInsert!.contextAttachments).toHaveLength(3);
});
it('refuses to overwrite a recall acknowledgment', () => {
  const pending = { threadId: 'film', text: '恢复的草稿', authoritative: true };
  useChatStore.setState({ pendingChatInsert: pending });
  expect(addAssetToChat('film', item)).toContain('正在恢复');
  expect(useChatStore.getState().pendingChatInsert).toEqual(pending);
});
