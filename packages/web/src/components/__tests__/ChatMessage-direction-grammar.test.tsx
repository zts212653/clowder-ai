import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { refreshMentionData, resetMentionDataForTest } from '@/lib/mention-highlight';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';

/**
 * F314-17 through the real chat surface: the direction pill on a cat's callback message shows the
 * cats the API routes (shared A2A grammar), not every handle the text contains.
 */
const cat = (id: string, displayName: string, handle: string) =>
  ({
    id,
    displayName,
    color: { primary: '#8B5CF6', secondary: '#7C3AED' },
    mentionPatterns: [handle],
  }) as unknown as CatData;
const cats = [cat('opus', '宪宪', '@opus'), cat('codex', '砚砚', '@codex'), cat('kimi', '墨墨', '@kimi')];
const getCatById = (id: string) => cats.find((c) => c.id === id);

describe('ChatMessage direction pill follows the A2A routing grammar', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    refreshMentionData(cats);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: 'thread-direction', messages: [], threads: [], isLoadingThreads: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetMentionDataForTest();
  });

  const renderCallback = (content: string, sender = 'codex') => {
    const message: ChatMessageData = {
      id: `direction-${content.length}`,
      type: 'assistant',
      from: { kind: 'agent', catId: sender },
      catId: sender,
      origin: 'callback',
      content,
      timestamp: 1,
    };
    useChatStore.setState({ messages: [message] });
    act(() => {
      root.render(<ChatMessage message={message} threadId="thread-direction" getCatById={getCatById} />);
    });
    return container.textContent ?? '';
  };

  it('draws no pill for a mention inside prose or a code block', () => {
    expect(renderCallback('ask @opus in prose')).not.toContain('→');
    expect(renderCallback('```\n@opus\n```')).not.toContain('→');
  });

  it('draws the pill for a line-start handle followed directly by CJK text', () => {
    expect(renderCallback('@opus请继续')).toContain('→ @宪宪');
  });

  it('still draws an available target after a disabled member on the same line (review of #6458)', () => {
    refreshMentionData([{ ...cats[0], roster: { available: false } } as unknown as CatData, ...cats.slice(1)]);
    const text = renderCallback('@opus @codex', 'kimi');
    expect(text).toContain('→ @砚砚');
    expect(text).not.toContain('→ @宪宪');
  });
});
