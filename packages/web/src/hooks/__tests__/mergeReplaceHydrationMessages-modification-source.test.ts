import type { ContentModificationSourceMessageV1 } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { mergeReplaceHydrationMessages } from '../useChatHistory';

it('retains the server-owned modification-source carrier across live/history reconciliation', () => {
  const metadata: ContentModificationSourceMessageV1 = {
    v: 1,
    requestId: 'f309-modification-' + 'a'.repeat(64),
    requestFingerprint: 'sha256:' + 'b'.repeat(64),
    contentTitle: '晨光封面',
    targetCatId: 'codex-astra',
    targetName: '小星星',
    executionThreadTitle: '封面共创',
    completionRule: 'file-writeback-applied',
  };
  const current: ChatMessage = {
    id: 'human-source',
    type: 'user',
    content: '请移除角落的标志',
    timestamp: 1,
    extra: { targetCats: ['codex-astra'] },
  };
  const history: ChatMessage = { ...current, extra: { contentModificationRequestV1: metadata } };
  expect(
    mergeReplaceHydrationMessages([history], [current], {}).messages[0]?.extra?.contentModificationRequestV1,
  ).toEqual(metadata);
});
