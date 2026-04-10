/**
 * F122B AC-B8: ThreadExecutionBar shows per-cat active status with elapsed time.
 * B8/B9 polish: cat names from cat-config (formatCatName), colors from cat.color.primary.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCatDataCache } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { ThreadExecutionBar } from '../ThreadExecutionBar';

// Mock /api/cats to return dynamic cat data
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn((url: string) => {
    if (url === '/api/cats') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            cats: [
              {
                id: 'opus',
                displayName: '布偶猫',
                color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
                mentionPatterns: ['@opus'],
                clientId: 'anthropic',
                defaultModel: 'claude-opus-4-6',
                avatar: '🐱',
                roleDescription: 'test',
                personality: 'test',
              },
              {
                id: 'codex',
                displayName: '缅因猫',
                color: { primary: '#4CAF50', secondary: '#C8E6C9' },
                mentionPatterns: ['@codex'],
                clientId: 'openai',
                defaultModel: 'gpt-5.3-codex',
                avatar: '🐱',
                roleDescription: 'test',
                personality: 'test',
              },
            ],
          }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  }),
}));

describe('ThreadExecutionBar (F122B AC-B8 + B8/B9 polish)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    _resetCatDataCache();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      activeInvocations: {},
      hasActiveInvocation: false,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
  });

  it('renders nothing when no active invocations', () => {
    act(() => root.render(React.createElement(ThreadExecutionBar)));
    expect(container.textContent).toBe('');
  });

  it('renders active cat with display name from cat-config', async () => {
    useChatStore.setState({
      activeInvocations: {
        'inv-1': { catId: 'opus', mode: 'execute', startedAt: Date.now() - 5000 },
      },
      hasActiveInvocation: true,
    });
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const text = container.textContent ?? '';
    expect(text).toContain('执行中');
    // Should show display name (布偶猫) not raw catId (opus)
    expect(text).toContain('布偶猫');
    expect(text).toMatch(/0:0[0-9]/);
  });

  it('renders multiple active cats with their respective display names', async () => {
    useChatStore.setState({
      activeInvocations: {
        'inv-1': { catId: 'opus', mode: 'execute', startedAt: Date.now() - 30000 },
        'inv-2': { catId: 'codex', mode: 'execute', startedAt: Date.now() - 10000 },
      },
      hasActiveInvocation: true,
    });
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const text = container.textContent ?? '';
    expect(text).toContain('布偶猫');
    expect(text).toContain('缅因猫');
  });

  it('uses dynamic cat color from cat-config (not hardcoded)', async () => {
    useChatStore.setState({
      activeInvocations: {
        'inv-1': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
      },
      hasActiveInvocation: true,
    });
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const dot = container.querySelector('.animate-pulse') as HTMLElement;
    expect(dot).toBeTruthy();
    expect(dot.style.backgroundColor).toBe('rgb(76, 175, 80)'); // #4CAF50
  });

  it('deduplicates same cat from multiple invocations', async () => {
    useChatStore.setState({
      activeInvocations: {
        'inv-1': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
        'inv-2': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      hasActiveInvocation: true,
    });
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const text = container.textContent ?? '';
    const nameCount = (text.match(/布偶猫/g) ?? []).length;
    expect(nameCount).toBe(1);
  });

  it('falls back to catId when cat not in config', async () => {
    useChatStore.setState({
      activeInvocations: {
        'inv-1': { catId: 'unknown-cat', mode: 'execute', startedAt: Date.now() },
      },
      hasActiveInvocation: true,
    });
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const text = container.textContent ?? '';
    expect(text).toContain('unknown-cat');
  });

  it('background thread invocation has startedAt after thread switch (R1 P1-1)', async () => {
    const fiveSecondsAgo = Date.now() - 5000;
    useChatStore.setState({
      currentThreadId: 'thread-bg',
      activeInvocations: {
        'inv-bg': { catId: 'codex', mode: 'execute', startedAt: fiveSecondsAgo },
      },
      hasActiveInvocation: true,
    });
    await act(async () => root.render(React.createElement(ThreadExecutionBar)));

    const text = container.textContent ?? '';
    expect(text).toContain('缅因猫');
    expect(text).not.toContain('0:00');
  });
});
