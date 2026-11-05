import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';
import { messageRendersNothing } from '../message-render-visibility';
import { SHELL_PRESENTATION_STORAGE_KEY } from '../shell/shell-presentation';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }));

const threadId = 'receipt-containment';
const targetId = 'codex61-sol';
const holdMeta = { taskId: 'hold-task', jobId: 'managed-job', catId: targetId };
const initial: Message = {
  id: 'initial',
  type: 'assistant',
  from: { kind: 'agent', catId: 'gpt-dot' },
  content: 'initial instruction',
  timestamp: 1,
};
const response: Message = {
  id: 'response',
  type: 'assistant',
  from: { kind: 'agent', catId: targetId },
  catId: targetId,
  content: 'working response',
  timestamp: 2,
  lifecycle: {
    kind: 'response',
    orderKey: '2:response',
    invocationId: 'invocation',
    targetId,
    inputEntryIds: ['first-entry', 'agent-entry', 'wake-entry'],
    inputMessageIds: ['initial', 'agent-append', 'hold-wake'],
    startedAt: 2,
    status: 'processing',
  },
};
const inputLifecycle = (id: string): NonNullable<Message['lifecycle']> => ({
  kind: 'input',
  orderKey: `3:${id}`,
  dispatchRefs: [
    {
      targetId,
      phase: 'dispatched',
      statusMessageId: response.id,
      dispatchedAt: 3,
      appendAcceptance: 'accepted',
      inputRead: { status: 'read', at: 5 },
    },
  ],
});
const agent: Message = {
  id: 'agent-append',
  type: 'assistant',
  from: { kind: 'agent', catId: 'gpt-dot' },
  catId: 'gpt-dot',
  content: 'follow-up instruction',
  timestamp: 3,
  lifecycle: inputLifecycle('agent-append'),
};
const card: Message = {
  id: 'hold-card',
  type: 'connector',
  from: { kind: 'system', service: 'managed-command-wake' },
  content: 'command card',
  timestamp: 0,
  source: { connector: 'hold-ball', label: '持球通知', icon: 'info', meta: { ...holdMeta, managedJobCard: true } },
};
const wake: Message = {
  id: 'hold-wake',
  type: 'connector',
  from: { kind: 'system', service: 'managed-command-wake' },
  content: 'command completed',
  timestamp: 4,
  lifecycle: inputLifecycle('hold-wake'),
  source: { connector: 'hold-ball', label: '持球通知', icon: 'info', meta: { ...holdMeta, phase: 'wake' } },
};
const timeline = [card, initial, response, agent, wake];
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useChatStore.setState({ currentThreadId: threadId, messages: timeline, threads: [], queue: [] });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  resetCoCreatorConfigCacheForTest();
});

function renderRows(rows: Message[], messages = timeline) {
  act(() =>
    root.render(
      <>
        {rows.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            threadId={threadId}
            timelineMessages={messages}
            getCatById={() => undefined}
          />
        ))}
      </>,
    ),
  );
}

it.each(['classic', 'v2'])('does not leave a folded command receipt below the preceding agent in %s', (shell) => {
  window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, shell);
  renderRows([agent, wake]);
  expect(container.querySelector('[data-message-id="hold-wake"]')?.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelectorAll('[data-testid="message-dispatch-avatars"]')).toHaveLength(1);
  expect(messageRendersNothing(wake, timeline, { currentThreadId: threadId })).toBe(true);

  // Folding the transport row must retain the distinct exact input/read evidence in its response.
  renderRows([response]);
  const retained = container.querySelector('[data-appended-input-id="hold-wake"] [data-append-delivery-state]');
  expect(retained?.getAttribute('data-append-delivery-state')).toBe('read');
  expect(container.querySelector('[data-appended-input-id="agent-append"]')).not.toBeNull();
});

it.each(['classic', 'v2'])('keeps an unabsorbed connector receipt within its own visible row in %s', (shell) => {
  window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, shell);
  renderRows(
    [wake],
    timeline.filter((message) => message.id !== card.id),
  );
  expect(
    container.querySelectorAll('[data-message-id="hold-wake"] [data-testid="message-dispatch-avatars"]'),
  ).toHaveLength(1);
});

it.each(['classic', 'v2'])('also folds an absorbed command rendered as a system notice in %s', (shell) => {
  window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, shell);
  const notice: Message = {
    ...wake,
    source: {
      connector: 'hold-ball',
      label: '持球通知',
      icon: 'info',
      meta: { ...holdMeta, phase: 'wake', presentation: 'system_notice' },
    },
  };
  const messages = [card, initial, response, agent, notice];
  renderRows([notice], messages);
  expect(container.querySelector('[data-message-id="hold-wake"]')?.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('[data-testid="message-dispatch-avatars"]')).toBeNull();
  expect(messageRendersNothing(notice, messages, { currentThreadId: threadId })).toBe(true);
});

it('keeps a visible system-notice receipt within the notice and hides a hidden scheduler receipt', () => {
  const notice: Message = {
    ...wake,
    source: { connector: 'calendar', label: '通知', icon: 'info', meta: { presentation: 'system_notice' } },
  };
  renderRows([notice], [initial, response, agent, notice]);
  expect(
    container.querySelectorAll('[data-message-id="hold-wake"] [data-testid="message-dispatch-avatars"]'),
  ).toHaveLength(1);
  const hidden: Message = { ...notice, extra: { scheduler: { hiddenTrigger: true } } };
  renderRows([hidden], [initial, response, agent, hidden]);
  expect(container.querySelector('[data-testid="message-dispatch-avatars"]')).toBeNull();
  expect(messageRendersNothing(hidden, [hidden], { currentThreadId: threadId })).toBe(true);
});

it.each([
  ['classic', 'text_frustration'],
  ['classic', 'retry_burst'],
  ['v2', 'text_frustration'],
  ['v2', 'retry_burst'],
])('retains the exact receipt when only the %s %s feedback body is retired', (shell, signalType) => {
  window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, shell);
  const retired: Message = {
    ...wake,
    content: 'Retired detection text',
    source: { connector: 'frustration-auto-issue', label: '问题检测', icon: 'search' },
    extra: {
      rich: {
        v: 1,
        blocks: [
          {
            id: 'retired',
            kind: 'card',
            v: 1,
            title: 'Retired detection card',
            meta: { kind: 'frustration_auto_issue', issueId: 'retired-issue', signalType },
          },
        ],
      },
    },
  };
  const messages = [initial, response, agent, retired];
  renderRows([retired], messages);
  const source = container.querySelector('[data-message-id="hold-wake"]');
  expect(source?.querySelectorAll('[data-testid="message-dispatch-avatars"]')).toHaveLength(1);
  expect(source?.querySelector('[data-dispatch-target]')?.getAttribute('data-dispatch-target')).toBe(targetId);
  expect(source?.closest('[aria-hidden="true"]')).toBeNull();
  expect(container.textContent).not.toContain('Retired detection');
  expect(messageRendersNothing(retired, messages, { currentThreadId: threadId })).toBe(false);

  // Full-row scheduler hiding still wins over the body-only retirement branch.
  const hidden: Message = { ...retired, extra: { ...retired.extra, scheduler: { hiddenTrigger: true } } };
  renderRows([hidden], [initial, response, agent, hidden]);
  expect(container.querySelector('[data-testid="message-dispatch-avatars"]')).toBeNull();
  expect(messageRendersNothing(hidden, [hidden], { currentThreadId: threadId })).toBe(true);
});
