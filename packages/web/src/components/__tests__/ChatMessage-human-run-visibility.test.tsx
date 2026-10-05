import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';
import { SHELL_PRESENTATION_STORAGE_KEY } from '../shell/shell-presentation';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }));

/**
 * F322 B segment 1 (human message) — a run of your own messages shows its time once, under the last one that is on
 * screen. What is "on screen" is decided by what the real ChatMessage draws, not by what the data looks like (Sol6.1's
 * review of #4983 found two rows the renderer draws nothing for that the grouping still treated as run breakers). These
 * go through the real renderer, real receipt lineage and the real cloud-notice link; nothing here mocks the judgement.
 */
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
  resetCoCreatorConfigCacheForTest();
  primeCoCreatorConfigCache({ name: 'You', aliases: [], mentionPatterns: ['@co-creator'] });
  window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useChatStore.setState({ currentThreadId: 'thread-review', messages: [], threads: [] });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  resetCoCreatorConfigCacheForTest();
});

const own = (id: string): Message => ({ id, type: 'user', content: id, timestamp: 1 });
function renderTimeline(messages: Message[]) {
  act(() =>
    root.render(
      <>
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            timelineMessages={messages}
            threadId="thread-review"
            getCatById={() => undefined}
          />
        ))}
      </>,
    ),
  );
}
const time = (id: string) => container.querySelector(`[data-message-id="${id}"] [data-testid="human-message-time"]`);
function expectOneVisibleRun() {
  expect(container.querySelectorAll('[data-testid="message-bubble"]')).toHaveLength(2);
  expect(time('a')).toBeNull();
  expect(time('b')).not.toBeNull();
}

it('skips an unseen recall and keeps one visible human run', () => {
  renderTimeline([
    own('a'),
    { ...own('hidden'), extra: { recall: { version: 1, exposure: 'none', recalledAt: 2 } } },
    own('b'),
  ]);
  expect(container.querySelector('[data-message-id="hidden"]')).toBeNull();
  expectOneVisibleRun();
});

it('skips an empty finished cat message, which the renderer draws nothing for', () => {
  renderTimeline([own('a'), { id: 'hidden', type: 'assistant', catId: 'opus', content: '', timestamp: 2 }, own('b')]);
  expect(container.querySelector('[data-message-id="hidden"]')).toBeNull();
  expectOneVisibleRun();
});

it('skips a cloud notice that is carried inside the message it answers', () => {
  const notice: Message = {
    id: 'hidden',
    type: 'connector',
    content: 'not sent',
    timestamp: 2,
    replyTo: 'a',
    source: {
      connector: 'cloud-bridge-status',
      label: '云端猫投递',
      icon: '☁️',
      meta: {
        presentation: 'system_notice',
        cloudBridgeRecovery: {
          v: 1,
          kind: 'needs_binding',
          sourceMessageId: 'a',
          targetCatId: 'gpt-pro',
          dispatchInvocationId: 'dispatch-1',
        },
      },
    },
  };
  renderTimeline([own('a'), notice, own('b')]);
  expect(container.querySelector('[data-message-id="hidden"]')).toBeNull();
  expectOneVisibleRun();
});

it('steps over a body that real receipt lineage folded into the reply', () => {
  const folded: Message = {
    ...own('folded'),
    extra: {
      queueReceipt: {
        version: 1,
        entryId: 'entry-folded',
        reminderAttempts: [],
        targets: [
          {
            catId: 'opus',
            state: 'handled',
            invocationId: 'child-1',
            seenAt: 1,
            outcome: {
              invocationId: 'child-1',
              disposition: 'responded',
              handledAt: 2,
              evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-1' },
            },
          },
        ],
      },
    },
  };
  const terminal: Message = {
    id: 'terminal',
    type: 'assistant',
    catId: 'opus',
    content: '已回复',
    timestamp: 3,
    extra: { turnExecution: { invocationId: 'child-1', parentInvocationId: 'parent-1', executionKind: 'ordinary' } },
  };
  renderTimeline([own('a'), folded, own('b'), terminal]);
  const anchor = container.querySelector('[data-message-id="folded"]');
  expect(anchor?.getAttribute('aria-hidden')).toBe('true');
  expect(anchor?.querySelector('[data-testid="message-bubble"]')).toBeNull();
  expect(time('a')).toBeNull();
  expect(time('b')).not.toBeNull();
});

it.each([
  { id: 'active', type: 'assistant', catId: 'opus', content: '', timestamp: 2, isStreaming: true },
  { id: 'thinking', type: 'assistant', catId: 'opus', content: '', timestamp: 2, thinking: '正在想' },
] satisfies Message[])('a visible cat surface ($id) still ends the human run', (middle) => {
  renderTimeline([own('a'), middle, own('b')]);
  expect(container.querySelector(`[data-message-id="${middle.id}"] [data-testid="message-bubble"]`)).not.toBeNull();
  expect(time('a')).not.toBeNull();
});

it('a visible summary card ends the human run: the time is under the message before the card', () => {
  const card: Message = {
    id: 'card',
    type: 'summary',
    content: '',
    timestamp: 2,
    summary: {
      id: 's1',
      topic: '本周结论',
      conclusions: ['定下设计方向'],
      openQuestions: ['谁来验收'],
      createdBy: 'opus',
    },
  };
  renderTimeline([own('a'), card, own('b')]);

  expect(container.querySelector('[data-message-id="card"]')?.textContent).toContain('本周结论');
  expect(time('a')).not.toBeNull();
  expect(time('b')).not.toBeNull();
});

it('a summary record with nothing attached draws nothing, so the run goes on across it', () => {
  renderTimeline([own('a'), { id: 'empty', type: 'summary', content: 'x', timestamp: 2 }, own('b')]);

  expect(container.querySelector('[data-message-id="empty"]')).toBeNull();
  expectOneVisibleRun();
});
