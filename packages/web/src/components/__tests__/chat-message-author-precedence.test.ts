import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: '始皇帝',
    aliases: ['秦始皇'],
    mentionPatterns: ['@owner', '@me'],
    avatar: '/uploads/qin-owner.png',
    color: { primary: '#B76E4C', secondary: '#F8D7C6' },
  }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('span', null, content),
}));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));

describe('ChatMessage author precedence', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('treats catId messages as assistant even if type=user', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');
    const getCatById = vi.fn((id: string) => {
      if (id !== 'gpt52') return undefined;
      return {
        id: 'gpt52',
        displayName: '缅因猫',
        nickname: '砚砚',
        variantLabel: 'GPT-5.2',
        color: { primary: '#5B8C5A', secondary: '#E6F2E6' },
        mentionPatterns: [],
        breedId: 'maine-coon',
        clientId: 'openai',
        defaultModel: 'gpt-5.2',
        avatar: '/avatars/gpt52.png',
        roleDescription: '',
        personality: '',
      };
    });

    const msg = {
      id: 'm1',
      type: 'user' as const,
      catId: 'gpt52',
      content: 'cross-posted review',
      timestamp: Date.now(),
      contentBlocks: [],
    };

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: msg as never,
          getCatById: getCatById as never,
        }),
      );
    });

    expect(container.textContent).toContain('cross-posted review');
    expect(container.textContent).toContain('缅因猫（GPT-5.2）');
    expect(container.textContent).not.toContain('铲屎官');
  });

  it('uses configured co-creator name and avatar for plain user messages', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');
    const msg = {
      id: 'm2',
      type: 'user' as const,
      content: '你好',
      timestamp: Date.now(),
      contentBlocks: [],
    };

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: msg as never,
          getCatById: (() => undefined) as never,
        }),
      );
    });

    expect(container.textContent).toContain('始皇帝');
    expect(container.textContent).not.toContain('铲屎官');
    const avatar = container.querySelector('img[alt="始皇帝"]') as HTMLImageElement | null;
    expect(avatar?.getAttribute('src')).toBe('/uploads/qin-owner.png');
  });
});
