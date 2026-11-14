import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage } from '@/stores/chat-types';
import { ChatMessageRow } from '../../ChatMessageRow';

vi.mock('../../MessageActions', () => ({ MessageActions: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../MessageActionSlot', () => ({ MessageActionSlot: () => null }));
vi.mock('../../ChatMessage', () => ({ ChatMessage: () => <div data-testid="ordinary-message">Ordinary</div> }));
vi.mock('../../suggestions/SuggestionRow', () => ({
  SuggestionRow: () => null,
  SuggestionAvatar: ({ watcher }: { watcher: boolean }) => <span data-watcher={String(watcher)} />,
}));

const watcher = {
  kind: 'nudge' as const,
  sourceInvocationId: 'ordinary-work',
  sourceMessageId: 'original-message',
  watcherInvocationId: 'watcher-work',
};
const message: ChatMessage = {
  id: 'watcher-message',
  type: 'assistant',
  catId: 'codex61-sol',
  timestamp: 1794318983970,
  content: '@gemini-argon\n\nA helpful precedent.\n\n[原话](/thread/thread-proof?messageId=original-message)',
  extra: { watcher, targetCats: ['gemini-argon'] },
};
const getCatById = (id: string) =>
  ({
    id,
    displayName: id === 'gemini-argon' ? '暹罗猫' : '缅因猫 Sol',
    nickname: id === 'gemini-argon' ? '烁烁' : '小太阳',
  }) as CatData;

describe('watcher nudge in the real message-row owner', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  function render(row: ChatMessage, timelineMessages = [row]) {
    act(() =>
      root.render(
        <ChatMessageRow
          message={row}
          threadId="thread-proof"
          timelineMessages={timelineMessages}
          getCatById={getCatById}
          onEditCat={() => {}}
          onEditCoCreator={() => {}}
          selectionMode={false}
          selected={false}
          selectionEligible
          onEnterSelection={() => {}}
          onToggleSelection={() => {}}
          forwardingDisabled={false}
          eager
        />,
      ),
    );
  }

  it.each(['message', 'messageId'])('shows the watcher role and canonical source for a %s citation', (key) => {
    render({ ...message, content: message.content.replace('?messageId=', `?${key}=`) });
    const nudge = host.querySelector('[data-testid="watcher-nudge"]');
    expect(nudge?.textContent).toContain('守望猫 · 小太阳');
    expect(nudge?.textContent).toContain('→ 暹罗猫');
    expect(nudge?.querySelector('[data-watcher="true"]')).not.toBeNull();
    expect(nudge?.querySelector('time')?.getAttribute('dateTime')).toBe(new Date(message.timestamp).toISOString());
    expect(nudge?.querySelector('a')?.getAttribute('href')).toBe('/thread/thread-proof?message=original-message');
    expect(nudge?.querySelector('p')?.textContent).toBe('A helpful precedent.');
    expect(host.querySelector('[data-testid="ordinary-message"]')).toBeNull();
  });

  it('keeps ordinary messages from the same member ordinary', () => {
    render({ ...message, extra: undefined });
    expect(host.querySelector('[data-testid="watcher-nudge"]')).toBeNull();
    expect(host.querySelector('[data-testid="ordinary-message"]')).not.toBeNull();
  });

  it('keeps a delivered-and-replied receipt inside the compact watcher line', () => {
    const delivered: ChatMessage = {
      ...message,
      lifecycle: {
        kind: 'input',
        orderKey: `1:${message.id}`,
        dispatchRefs: [
          { targetId: 'gemini-argon', phase: 'settled', statusMessageId: 'reply', dispatchedAt: message.timestamp },
        ],
      },
    };
    const reply: ChatMessage = {
      id: 'reply',
      type: 'assistant',
      catId: 'gemini-argon',
      timestamp: message.timestamp + 1,
      content: '采纳并更正',
      lifecycle: {
        kind: 'response',
        orderKey: '2:reply',
        invocationId: 'recipient-work',
        targetId: 'gemini-argon',
        inputEntryIds: ['queue'],
        inputMessageIds: [message.id],
        status: 'completed',
        startedAt: message.timestamp,
      },
    };
    render(delivered, [delivered, reply]);
    const nudge = host.querySelector('[data-testid="watcher-nudge"]');
    const receipt = nudge?.querySelector('[data-testid="message-dispatch-avatars"]');
    expect(receipt).not.toBeNull();
    expect(receipt?.textContent).toContain('已回复');
    expect(receipt?.textContent).toContain('看回复');
    expect(receipt?.classList.contains('pl-10')).toBe(false);
    expect(receipt?.classList.contains('-mt-3')).toBe(false);
    expect(receipt?.classList.contains('mb-4')).toBe(false);
  });
});
