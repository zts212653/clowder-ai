import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const pushSpy = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushSpy }) }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (s: { threads: { id: string; title: string }[]; uiThinkingExpandedByDefault: boolean }) => unknown,
  ) =>
    selector({
      uiThinkingExpandedByDefault: false,
      threads: [{ id: 'thread_mm72eyvc12345678', title: 'F052 跨线程调度测试' }],
    }),
}));

vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));
vi.mock('@/components/ConnectorBubble', () => ({ ConnectorBubble: () => null }));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MarkdownContent', () => ({ MarkdownContent: () => null }));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));

describe('ChatMessage Postmark v2 source pill', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    pushSpy.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders threadId short + thread title, with tooltip and click-to-navigate', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');

    const sourceThreadId = 'thread_mm72eyvc12345678';
    const message = {
      id: 'm1',
      type: 'assistant',
      catId: 'gpt52',
      content: '',
      timestamp: Date.now(),
      isStreaming: false,
      extra: { crossPost: { sourceThreadId } },
    };

    const getCatById = vi.fn(() => ({
      id: 'gpt52',
      displayName: '缅因猫',
      variantLabel: 'GPT-5.2',
      breedId: 'maine-coon',
      clientId: 'openai',
      defaultModel: 'gpt-5.2',
      avatar: '/avatars/gpt52.png',
      mentionPatterns: [],
      roleDescription: '',
      personality: '',
      color: { primary: '#7C3AED', secondary: '#EDE9FE' },
    }));

    act(() => {
      root.render(React.createElement(ChatMessage, { message: message as never, getCatById: getCatById as never }));
    });

    const pill = Array.from(container.querySelectorAll('a')).find(
      (a) => (a.textContent ?? '').includes('mm72eyvc') && (a.textContent ?? '').includes('F052 跨线程调度测试'),
    );
    expect(pill).toBeTruthy();
    expect(pill?.textContent).toContain('📮');
    // sender label: variantLabel is 'GPT-5.2', so catStyle.label = '缅因猫（GPT-5.2）'
    expect(pill?.textContent).toContain('缅因猫（GPT-5.2）');
    expect(pill?.getAttribute('title')).toBe(sourceThreadId);
    expect(pill?.className).toContain('bg-[#FDF6ED]');
    expect(pill?.className).toContain('border-[#E8DCCF]');
    expect(pill?.className).toContain('text-[#8D6E63]');
    expect(pill?.className).toContain('hover:bg-[#F5EDE0]');

    act(() => {
      pill?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(pushSpy).toHaveBeenCalledWith(`/thread/${sourceThreadId}`);
  });
});
