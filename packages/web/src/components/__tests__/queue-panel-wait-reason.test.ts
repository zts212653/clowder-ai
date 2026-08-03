/**
 * QueuePanel A2A queue visibility (2026-06-02): the queue header explains WHY entries wait
 * (behind the active turn) so the user can tell "waiting for the current turn" from "stuck".
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { computeQueueWaitInfo, formatElapsed, QueuePanel } from '../QueuePanel';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

const TEST_CATS = [
  { id: 'codex', displayName: '缅因猫', variantLabel: 'sol' },
  { id: 'opus', displayName: '布偶猫', variantLabel: 'Fable' },
];

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: TEST_CATS,
    getCatById: (id: string) => TEST_CATS.find((cat) => cat.id === id),
  }),
}));

const NOW = Date.now();

const QUEUED_ENTRY: QueueEntry = {
  id: 'q1',
  threadId: 'thread-1',
  userId: 'u1',
  content: 'queued message',
  messageId: 'm1',
  mergedMessageIds: [],
  source: 'user',
  targetCats: ['opus'],
  intent: 'execute',
  status: 'queued',
  createdAt: NOW,
};

describe('formatElapsed', () => {
  it('renders seconds under a minute', () => {
    expect(formatElapsed(45_000)).toBe('45s');
  });
  it('renders minutes under an hour', () => {
    expect(formatElapsed(12 * 60_000)).toBe('12m');
  });
  it('renders hours with zero-padded minutes', () => {
    expect(formatElapsed(63 * 60_000)).toBe('1h03m');
  });
  it('clamps negative to 0s', () => {
    expect(formatElapsed(-5000)).toBe('0s');
  });
});

describe('computeQueueWaitInfo', () => {
  it('returns null when nothing is active and the queued work has no explicit target', () => {
    expect(computeQueueWaitInfo({}, [], NOW)).toBeNull();
    expect(computeQueueWaitInfo(undefined, [], NOW)).toBeNull();
  });

  it('keeps an idle explicit target as dispatch truth instead of borrowing another cat', () => {
    expect(computeQueueWaitInfo({}, ['opus'], NOW)).toEqual({
      kind: 'target_dispatch',
      catIds: ['opus'],
    });
  });

  it('reports the targeted active cat + elapsed', () => {
    const info = computeQueueWaitInfo({ inv1: { catId: 'opus', startedAt: NOW - 65_000 } }, ['opus'], NOW);
    expect(info?.kind).toBe('active_turn');
    if (info?.kind !== 'active_turn') throw new Error('expected active_turn');
    expect(info?.catId).toBe('opus');
    expect(info?.elapsedLabel).toBe('1m');
  });

  // 砚砚 P1 regression: a longer-running NON-target active cat (codex) must NOT be shown as the
  // blocker when the visible queued entry actually targets a different cat (opus). Per-cat slot.
  it('attributes the TARGET cat, not the oldest unrelated active cat (砚砚 P1)', () => {
    const info = computeQueueWaitInfo(
      {
        invCodex: { catId: 'codex', startedAt: NOW - 600_000 }, // older, but NOT the queued target
        invOpus: { catId: 'opus', startedAt: NOW - 30_000 }, // the queued entry's target
      },
      ['opus'],
      NOW,
    );
    expect(info?.kind).toBe('active_turn');
    if (info?.kind !== 'active_turn') throw new Error('expected active_turn');
    expect(info?.catId).toBe('opus');
    expect(info?.elapsedLabel).toBe('30s');
  });

  it('picks the OLDEST among multiple TARGET active cats', () => {
    const info = computeQueueWaitInfo(
      {
        invA: { catId: 'opus', startedAt: NOW - 120_000 },
        invB: { catId: 'sonnet', startedAt: NOW - 5_000 },
      },
      ['opus', 'sonnet'],
      NOW,
    );
    expect(info?.kind).toBe('active_turn');
    if (info?.kind !== 'active_turn') throw new Error('expected active_turn');
    expect(info?.catId).toBe('opus');
    expect(info?.elapsedLabel).toBe('2m');
  });

  it('does not attribute an explicit-target entry to an unrelated active cat', () => {
    const info = computeQueueWaitInfo({ invCodex: { catId: 'codex', startedAt: NOW - 90_000 } }, ['opus'], NOW);
    expect(info).toEqual({
      kind: 'target_dispatch',
      catIds: ['opus'],
    });
  });

  it('falls back to the oldest active turn only for broadcast work', () => {
    const info = computeQueueWaitInfo({ invCodex: { catId: 'codex', startedAt: NOW - 90_000 } }, [], NOW);
    expect(info?.kind).toBe('active_turn');
    if (info?.kind !== 'active_turn') throw new Error('expected active_turn');
    expect(info.catId).toBe('codex');
    expect(info.elapsedLabel).toBe('1m');
  });

  it('null elapsedLabel when startedAt is missing', () => {
    const info = computeQueueWaitInfo({ inv1: { catId: 'opus' } }, ['opus'], NOW);
    expect(info?.kind).toBe('active_turn');
    if (info?.kind !== 'active_turn') throw new Error('expected active_turn');
    expect(info?.catId).toBe('opus');
    expect(info?.elapsedLabel).toBeNull();
  });
});

describe('QueuePanel wait-reason render', () => {
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
    useChatStore.setState({
      messages: [],
      queue: [],
      queuePaused: false,
      currentThreadId: 'thread-1',
      activeInvocations: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('shows "等待 {cat} 当前回合（已运行 …）" when an invocation is active and entries are queued', () => {
    useChatStore.setState({
      queue: [QUEUED_ENTRY],
      activeInvocations: { inv1: { catId: 'opus', mode: 'execute', startedAt: NOW - 90_000 } },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });
    const html = container.innerHTML;
    expect(html).toContain('等待');
    expect(html).toContain('布偶猫（Fable）');
    expect(html).not.toContain('等待 <span class="font-medium text-cafe-secondary">opus</span>');
    expect(html).toContain('当前回合');
    expect(html).toContain('已运行');
  });

  it('shows an idle explicit target as waiting for dispatch, not a current turn', () => {
    useChatStore.setState({ queue: [QUEUED_ENTRY], activeInvocations: {} });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });
    expect(container.textContent).toContain('等待 布偶猫（Fable） 调度');
    expect(container.innerHTML).not.toContain('当前回合');
    expect(container.querySelector('[data-testid="queue-recover"]')?.textContent).toBe('恢复');
  });

  // 砚砚 P1 end-to-end: queued entry targets opus; codex is active LONGER but is not the target.
  // The panel must attribute the wait to opus (the target), not codex.
  it('shows the TARGET cat (opus), not an older unrelated active cat (codex)', () => {
    useChatStore.setState({
      queue: [QUEUED_ENTRY], // targetCats: ['opus']
      activeInvocations: {
        invCodex: { catId: 'codex', mode: 'execute', startedAt: NOW - 600_000 },
        invOpus: { catId: 'opus', mode: 'execute', startedAt: NOW - 30_000 },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });
    const html = container.innerHTML;
    expect(html).toContain('当前回合');
    expect(html).toContain('布偶猫（Fable）');
    expect(html).not.toContain('缅因猫（sol）');
  });

  it('never says a Sol-targeted entry is waiting for an unrelated active GPT-5.5 turn', () => {
    const solEntry = { ...QUEUED_ENTRY, targetCats: ['codex-sol'] };
    useChatStore.setState({
      queue: [solEntry],
      activeInvocations: {
        invCodex55: { catId: 'codex', mode: 'execute', startedAt: NOW - 360_000 },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });
    expect(container.textContent).toContain('等待 codex-sol 调度');
    expect(container.textContent).not.toContain('缅因猫（sol）');
    expect(container.textContent).not.toContain('当前回合');
  });
});
