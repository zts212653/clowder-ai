import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const storeState = {
  hubState: { open: true, tab: 'quota' },
  closeHub: () => {},
  currentThreadId: 'thread-active',
  catInvocations: {},
  threadStates: {},
};

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      {
        id: 'codex',
        displayName: '缅因猫',
        nickname: '砚砚',
        color: { primary: '#4A90E2', secondary: '#E6F2FF' },
        mentionPatterns: ['@codex'],
        clientId: 'openai',
        defaultModel: 'gpt-5.3-codex',
        avatar: '/avatars/codex.png',
        roleDescription: '代码审查',
        personality: '严谨',
      },
    ],
    isLoading: false,
    getCatById: (id: string) =>
      id === 'codex'
        ? {
            id: 'codex',
            displayName: '缅因猫',
            nickname: '砚砚',
            color: { primary: '#4A90E2', secondary: '#E6F2FF' },
            mentionPatterns: ['@codex'],
            clientId: 'openai',
            defaultModel: 'gpt-5.3-codex',
            avatar: '/avatars/codex.png',
            roleDescription: '代码审查',
            personality: '严谨',
          }
        : undefined,
    getCatsByBreed: () => new Map(),
    refresh: () => Promise.resolve([]),
  }),
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

import { CatCafeHub, resolveRequestedHubTab } from '@/components/CatCafeHub';
import { HubRoutingPolicyTab } from '@/components/HubRoutingPolicyTab';

describe('CatCafeHub quota tab', () => {
  it('maps legacy quota tab id to routing tab id', () => {
    expect(resolveRequestedHubTab('quota', () => undefined)).toBe('routing');
    expect(resolveRequestedHubTab('routing', () => undefined)).toBe('routing');
  });

  it('renders 配額看板 as a hub tab label', () => {
    const html = renderToStaticMarkup(React.createElement(CatCafeHub));
    expect(html).toContain('配额看板');
  });

  it('renders routing policy summary plus quota board', () => {
    const html = renderToStaticMarkup(React.createElement(HubRoutingPolicyTab));
    expect(html).toContain('配额看板');
    expect(html).toContain('路由策略（猫粮约束子模块）');
    expect(html).toContain('@codex');
  });
});
