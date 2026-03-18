/**
 * F122B AC-B7: QueuePanel renders agent-sourced entries with handoff format.
 * Agent entries show: paw icon + "callerCat → targetCat" + "自动" tag + purple bg.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

const NOW = Date.now();

const USER_ENTRY: QueueEntry = {
  id: 'q-user',
  threadId: 'thread-1',
  userId: 'u1',
  content: '帮我看看这个 PR',
  messageId: 'm1',
  mergedMessageIds: [],
  source: 'user',
  targetCats: ['opus'],
  intent: 'execute',
  status: 'queued',
  createdAt: NOW,
};

const AGENT_ENTRY: QueueEntry = {
  id: 'q-agent',
  threadId: 'thread-1',
  userId: 'system',
  content: '[Multi-Mention from codex] 帮我确认 API 设计',
  messageId: 'm2',
  mergedMessageIds: [],
  source: 'agent',
  targetCats: ['opus'],
  intent: 'execute',
  status: 'queued',
  createdAt: NOW + 1,
  autoExecute: true,
  callerCatId: 'codex',
};

describe('QueuePanel agent entry rendering (F122B AC-B7)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      messages: [],
      currentThreadId: 'thread-1',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
  });

  it('renders agent entry with caller→target format', () => {
    useChatStore.setState({ queue: [USER_ENTRY, AGENT_ENTRY] });
    act(() => root.render(React.createElement(QueuePanel, { threadId: 'thread-1' })));

    const text = container.textContent ?? '';
    // Agent entry should show handoff format
    expect(text).toContain('codex → opus');
    // User entry should show 铲屎官
    expect(text).toContain('铲屎官');
  });

  it('renders "自动" tag for autoExecute agent entries', () => {
    useChatStore.setState({ queue: [AGENT_ENTRY] });
    act(() => root.render(React.createElement(QueuePanel, { threadId: 'thread-1' })));

    const text = container.textContent ?? '';
    expect(text).toContain('自动');
  });

  it('agent entry has purple background class', () => {
    useChatStore.setState({ queue: [AGENT_ENTRY] });
    act(() => root.render(React.createElement(QueuePanel, { threadId: 'thread-1' })));

    const agentRow = container.querySelector('.bg-\\[\\#F3EEFA\\]');
    expect(agentRow).not.toBeNull();
  });

  it('user entry does NOT have agent background or "自动" tag', () => {
    useChatStore.setState({ queue: [USER_ENTRY] });
    act(() => root.render(React.createElement(QueuePanel, { threadId: 'thread-1' })));

    const text = container.textContent ?? '';
    expect(text).not.toContain('自动');
    expect(text).not.toContain('→');
    const agentRow = container.querySelector('.bg-\\[\\#F3EEFA\\]');
    expect(agentRow).toBeNull();
  });

  it('badge count includes both user and agent entries', () => {
    useChatStore.setState({ queue: [USER_ENTRY, AGENT_ENTRY] });
    act(() => root.render(React.createElement(QueuePanel, { threadId: 'thread-1' })));

    const text = container.textContent ?? '';
    // Badge should show "2"
    expect(text).toContain('2');
  });
});
