/**
 * F32-b Phase 4 R24 P2-1: Regression test — ChatMessage must receive getCatById
 * as a prop, NOT call useCatData() internally.
 *
 * If someone moves useCatData() back into ChatMessage, this test will fail
 * because the spy will detect a direct hook call from within the component.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

// ── Spy on useCatData — must NOT be called by ChatMessage ──
const useCatDataSpy = vi.fn(() => ({
  cats: [],
  isLoading: false,
  getCatById: () => undefined,
  getCatsByBreed: () => new Map(),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: useCatDataSpy,
}));

// ── Stub TTS hook (ChatMessage uses it) ──
vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

// ── Stub heavy sub-components to keep the test fast ──
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

describe('ChatMessage getCatById prop injection (R24 P2-1)', () => {
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
    useCatDataSpy.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('does not call useCatData() — uses getCatById prop instead', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');
    const getCatById = vi.fn(() => ({
      id: 'opus',
      displayName: '布偶猫',
      color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
      breedId: 'ragdoll',
      clientId: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      avatar: '/avatars/opus.png',
      mentionPatterns: [],
      roleDescription: '',
      personality: '',
    }));

    const messages = [
      {
        id: '1',
        type: 'assistant' as const,
        catId: 'opus',
        content: 'msg-1',
        timestamp: Date.now(),
        contentBlocks: [],
      },
      {
        id: '2',
        type: 'assistant' as const,
        catId: 'opus',
        content: 'msg-2',
        timestamp: Date.now(),
        contentBlocks: [],
      },
      {
        id: '3',
        type: 'assistant' as const,
        catId: 'codex',
        content: 'msg-3',
        timestamp: Date.now(),
        contentBlocks: [],
      },
    ];

    act(() => {
      root.render(
        React.createElement(
          'div',
          null,
          ...messages.map((msg) =>
            React.createElement(ChatMessage, { key: msg.id, message: msg as never, getCatById: getCatById as never }),
          ),
        ),
      );
    });

    // ChatMessage must use the injected getCatById, not call useCatData
    expect(useCatDataSpy).not.toHaveBeenCalled();
    expect(getCatById.mock.calls.length).toBeGreaterThanOrEqual(messages.length);
  });

  it('renders correctly for user messages without needing cat data', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');
    const getCatById = vi.fn(() => undefined);

    const userMsg = {
      id: 'u1',
      type: 'user' as const,
      content: 'Hello cats!',
      timestamp: Date.now(),
      contentBlocks: [],
    };

    act(() => {
      root.render(React.createElement(ChatMessage, { message: userMsg as never, getCatById: getCatById as never }));
    });

    expect(useCatDataSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Hello cats!');
  });
});
