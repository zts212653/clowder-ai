import React, { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { ChatMessage } from '../ChatMessage';
import { MessageActions } from '../MessageActions';
import { writeShellLanguage } from '../shell/shell-language';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

vi.mock('@/hooks/useTts', () => ({ useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }) }));
vi.mock('@/hooks/useTextSelectionAction', () => ({ useTextSelectionAction: () => null }));
vi.mock('../useMessageAnnotationMarkers', () => ({ useMessageAnnotationMarkers: () => [] }));

const cat = {
  id: 'opus',
  displayName: '布偶猫',
  nickname: '宪宪',
  breedId: 'ragdoll',
  avatar: '/avatars/opus.png',
  color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
} as CatData;
describe('approved 1398 classic message markup across F322 integration', () => {
  let h: ReplyLayersHarness;
  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    primeCoCreatorConfigCache({
      name: 'You',
      aliases: [],
      mentionPatterns: ['@co-creator'],
      avatar: '/avatars/owner.jpg',
    });
    h = new ReplyLayersHarness();
    writeShellLanguage('en');
  });
  afterEach(() => {
    h.dispose();
    writeShellLanguage('zh');
  });
  for (const kind of ['assistant', 'human', 'cross-thread'] as const)
    it(`preserves the complete ${kind} row and its action owner`, async () => {
      const message =
        kind === 'human'
          ? streamReply({
              type: 'user',
              from: { kind: 'user', userId: 'operator' },
              catId: undefined,
              origin: undefined,
              content: 'Human message',
              toolEvents: [],
              metadata: undefined,
              extra: undefined,
            })
          : streamReply({
              content: 'Classic reply',
              toolEvents: [],
              extra: kind === 'cross-thread' ? { crossPost: { sourceThreadId: 'thread-source' } } : undefined,
            });
      await act(async () =>
        h.root.render(
          <MessageActions message={message} threadId="thread-1" selectionEligible onEnterSelection={() => {}}>
            <ChatMessage
              message={message}
              threadId="thread-1"
              timelineMessages={[message]}
              getCatById={(id) => (id === 'opus' ? cat : undefined)}
            />
          </MessageActions>,
        ),
      );
      expect(h.container.innerHTML).toMatchSnapshot();
    });
});
