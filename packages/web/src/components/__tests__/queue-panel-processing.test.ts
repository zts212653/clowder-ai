// @vitest-environment jsdom
/** Pending Queue controls; response recovery belongs to ExecutionRow and the original response. */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { queueTargetLabelsFromHistory } from '../QueueEntryRow';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [] }) }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorConfig: () => ({ name: 'owner' }) }));
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const THREAD = 'thread-1';
function entry(id = 'q1', targets = ['opus']): QueueEntry {
  return {
    id,
    threadId: THREAD,
    userId: 'owner',
    from: { kind: 'user', userId: 'owner' },
    content: 'pending ' + id,
    messageId: 'm-' + id,
    mergedMessageIds: [],
    targetCats: targets,
    intent: 'execute',
    status: 'queued',
    createdAt: 1,
  };
}
function source(): ChatMessage {
  return {
    id: 'm-q1',
    type: 'user',
    content: 'source',
    timestamp: 1,
    lifecycle: {
      kind: 'input',
      orderKey: '1:m-q1',
      dispatchRefs: [{ targetId: 'opus', statusMessageId: 'response', phase: 'dispatched', dispatchedAt: 2 }],
    },
  };
}
function response(status: 'processing' | 'completed' | 'failed' | 'canceled' = 'processing'): ChatMessage {
  return {
    id: 'response',
    type: 'assistant',
    catId: 'opus',
    content: 'result',
    timestamp: 2,
    lifecycle: {
      kind: 'response',
      orderKey: '2:response',
      targetId: 'opus',
      invocationId: 'child',
      inputEntryIds: ['q1'],
      inputMessageIds: ['m-q1'],
      status,
      startedAt: 2,
    },
  };
}
describe('pending Queue and exact History ownership', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useChatStore.setState({
      currentThreadId: THREAD,
      queue: [],
      messages: [],
      threadStates: {},
      activeInvocations: {},
      catInvocations: {},
      catStatuses: {},
      hasActiveInvocation: false,
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });
  function render(thread = THREAD) {
    act(() => root.render(React.createElement(QueuePanel, { threadId: thread })));
  }
  it('keeps pending controls and no model-read labels', () => {
    useChatStore.setState({ queue: [entry()] });
    render();
    expect(container.textContent).toContain('pending q1');
    expect(container.querySelector('[data-testid="steer-q1"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/已读|未读|等待读取|已唤醒/);
  });
  it.each([
    'processing',
    'completed',
    'failed',
    'canceled',
  ] as const)('a delivered %s response never becomes a Queue entry', (status) => {
    useChatStore.setState({ messages: [source(), response(status)], queue: [] });
    render();
    expect(container.innerHTML).toBe('');
    expect(queueTargetLabelsFromHistory('m-q1', [source(), response(status)])).toEqual({ opus: '已投递' });
  });
  it('mixed-target pending work keeps its already delivered sibling visible as delivered', () => {
    useChatStore.setState({ queue: [entry('q1', ['opus', 'codex'])], messages: [source(), response()] });
    render();
    expect(container.querySelector('[data-queue-target-row="opus"]')?.textContent).toContain('已投递');
    expect(container.querySelector('[data-queue-target-row="codex"]')?.textContent).not.toContain('已投递');
  });
  it('a late accepted receipt supersedes a retained uncertain failure in shared-source Queue display', () => {
    const message = source();
    if (!message.lifecycle || message.lifecycle.kind !== 'input') throw new Error('fixture');
    message.lifecycle = {
      ...message.lifecycle,
      dispatchRefs: [
        {
          targetId: 'opus',
          statusMessageId: 'response',
          phase: 'dispatched',
          dispatchedAt: 2,
          appendAcceptance: 'accepted',
          inputRead: { status: 'read', at: 3 },
        },
      ],
      appendFailures: [
        {
          targetId: 'opus',
          invocationId: 'child',
          responseMessageId: 'response',
          acceptance: 'unknown',
          reason: 'provider_rejected',
          at: 4,
        },
      ],
    };
    useChatStore.setState({ queue: [entry('q1', ['codex'])], messages: [message, response('completed')] });
    render();
    expect(container.querySelector('[data-queue-target-row="opus"]')?.textContent).toContain('已投递');
    expect(container.querySelector('[data-queue-target-row="opus"]')?.textContent).not.toContain('未确认');
  });
  it.each([
    ['written', false, 'processing', '已写入，等待后续轮'],
    ['written', true, 'processing', '本轮已读，等待完成'],
    ['written', true, 'failed', '已读，结果未确认'],
    ['pending', false, 'processing', '正在确认投递'],
    ['pending', false, 'failed', '投递结果未确认'],
  ] as const)('shows the actual Native receipt stage: %s / read=%s / %s', (acceptance, read, status, label) => {
    const message = source();
    if (!message.lifecycle || message.lifecycle.kind !== 'input') throw new Error('fixture');
    message.lifecycle = {
      ...message.lifecycle,
      dispatchRefs: [
        {
          targetId: 'opus',
          statusMessageId: 'response',
          phase: 'dispatched',
          dispatchedAt: 2,
          appendAcceptance: acceptance,
          inputRead: read ? { status: 'read', at: 3 } : { status: 'pending' },
        },
      ],
      ...(status === 'failed'
        ? {
            appendFailures: [
              {
                targetId: 'opus',
                invocationId: 'child',
                responseMessageId: 'response',
                acceptance: 'unknown',
                reason: 'provider_rejected',
                at: 4,
              },
            ],
          }
        : {}),
    };
    useChatStore.setState({ queue: [entry()], messages: [message, response(status)] });
    render();
    expect(container.querySelector('[data-queue-target-row="opus"]')?.textContent).toContain(label);
    expect(container.querySelector('[data-queue-target-row="opus"]')?.textContent).not.toContain('已投递');
    expect(container.querySelector('[data-testid="steer-q1"]')).not.toBeNull();
  });
  it.each([
    'foreign-target',
    'foreign-source',
    'duplicate-response',
  ])('does not borrow %s as a delivery witness', (kind) => {
    const r = response();
    if (r.lifecycle?.kind !== 'response') throw new Error('fixture');
    r.lifecycle = {
      ...r.lifecycle,
      ...(kind === 'foreign-target' ? { targetId: 'codex' } : {}),
      ...(kind === 'foreign-source' ? { inputMessageIds: ['other'] } : {}),
    };
    expect(queueTargetLabelsFromHistory('m-q1', [source(), r, ...(kind === 'duplicate-response' ? [r] : [])])).toEqual(
      {},
    );
  });
  it('does not borrow the current thread Queue for an unknown thread', () => {
    useChatStore.setState({ queue: [entry()] });
    render('other');
    expect(container.innerHTML).toBe('');
  });
  it('reads a background thread Queue from that thread', () => {
    useChatStore.getState().setQueue('other', [{ ...entry('background'), threadId: 'other' }]);
    useChatStore.setState({ queue: [entry()] });
    render('other');
    expect(container.textContent).toContain('pending background');
    expect(container.textContent).not.toContain('pending q1');
  });
  it('routine scheduler controls stay hidden while ordinary producer inputs remain visible', () => {
    useChatStore.setState({
      queue: [
        { ...entry('timer'), sourceCategory: 'scheduled', content: '[定时任务] routine internal wake' },
        entry('business'),
      ],
    });
    render();
    expect(container.textContent).not.toContain('routine internal wake');
    expect(container.textContent).toContain('pending business');
  });
});
