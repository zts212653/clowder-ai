/** F128 requester-withdrawn ProposalCard regression, split from the main suite for the line cap. */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('p', null, content),
}));
vi.mock('@/utils/api-client', () => ({
  apiFetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'not found' }) }),
}));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));
const chatStoreState = vi.hoisted(() => ({ threads: [], updateThreadPin: vi.fn() }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector?: (state: typeof chatStoreState) => unknown) => (selector ? selector(chatStoreState) : chatStoreState),
    { getState: () => chatStoreState },
  ),
}));

import { ProposalCard } from '@/components/rich/ProposalCard';
import type { RichCardBlock } from '@/stores/chat-types';

const PROPOSAL_ID = 'proposal_withdrawn';
const block: RichCardBlock = {
  id: `proposal-${PROPOSAL_ID}`,
  kind: 'card',
  v: 1,
  title: 'Thread proposal',
  bodyMarkdown: 'Requester can correct this proposal.',
  tone: 'info',
  actions: [
    { label: '批准并创建', action: 'propose:approve', payload: { proposalId: PROPOSAL_ID } },
    { label: '驳回', action: 'propose:reject', payload: { proposalId: PROPOSAL_ID } },
  ],
};

describe('ProposalCard requester withdrawal', () => {
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
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders requester withdrawal as terminal without user decision controls', async () => {
    await act(async () => root.render(React.createElement(ProposalCard, { block })));
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:proposal-updated', {
          detail: { proposalId: PROPOSAL_ID, status: 'withdrawn' },
        }),
      );
    });

    expect(container.textContent).toContain('已撤回');
    const labels = [...container.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).not.toContain('批准并创建');
    expect(labels).not.toContain('编辑');
    expect(labels).not.toContain('驳回');
  });
});
