/**
 * Red tests: Cancel invariant for invocation stall scenarios.
 *
 * Bug: "猫猫正在回复中" displayed for 30+ minutes with no cancel button.
 *
 * Root cause (frontend):
 * 1. ChatInput shows "猫猫正在回复中" based on hasActiveInvocation alone
 *    but has no cancel entry point in that banner.
 * 2. ThinkingIndicator's alive_but_silent state (2min+) shows warning
 *    but has no cancel button — only suspected_stall (5min+) has cancel.
 * 3. showThinkingIndicator has extra gates (intentMode / activeInvocationCount)
 *    that can prevent it from rendering even when hasActiveInvocation=true,
 *    creating a UX dead zone where the user sees "replying" but has no control.
 *
 * Invariant to lock:
 * - alive_but_silent MUST have a cancel button
 * - ChatInput "猫猫正在回复中" banner MUST include cancel affordance
 */

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

vi.mock('@/utils/api-client', () => ({ apiFetch: mockApiFetch }));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => (id === 'codex' ? { displayName: '缅因猫 (Codex)', catId: 'codex' } : null),
  }),
}));

const storeState: Record<string, unknown> = {
  targetCats: ['codex'],
  activeInvocations: { 'inv-1': { catId: 'codex', mode: 'execute', startedAt: Date.now() - 300_000 } },
  catStatuses: {},
  catInvocations: {},
  currentThreadId: 'thread-1',
};

function liveExecution(): ActiveExecutionProjection {
  return {
    executionId: 'inv-1',
    threadId: 'thread-1',
    threadTitle: 'Test thread',
    catId: 'codex',
    kind: 'live_invocation',
    startedAt: Date.now() - 300_000,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId: 'thread-1', catId: 'codex', executionId: 'inv-1' },
    },
  };
}

function seedExecutionProjection(): void {
  const execution = liveExecution();
  useActiveExecutionStore.setState({
    anchorThreadId: 'thread-1',
    projectPath: '/project/cafe',
    executionsByKey: { [activeExecutionKey(execution)]: execution },
    hydration: 'ready',
    hydrationError: null,
  });
}

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(storeState) : storeState),
    { getState: () => storeState },
  ),
}));

describe('Invocation stall cancel invariant', () => {
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
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(url.endsWith('/executions/active') ? { projectPath: '/project/cafe', executions: [] } : {}),
      }),
    );
    storeState.targetCats = ['codex'];
    storeState.activeInvocations = { 'inv-1': { catId: 'codex', mode: 'execute', startedAt: Date.now() - 300_000 } };
    storeState.catStatuses = {};
    storeState.catInvocations = {};
    storeState.currentThreadId = 'thread-1';
    useActiveExecutionStore.getState().reset();
    seedExecutionProjection();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RED TEST 1: alive_but_silent MUST have cancel button
  // ─────────────────────────────────────────────────────────────────────────
  it('alive_but_silent state shows cancel button (not just suspected_stall)', async () => {
    storeState.catStatuses = { codex: 'alive_but_silent' };
    storeState.catInvocations = {
      codex: {
        livenessWarning: {
          level: 'alive_but_silent',
          state: 'busy-silent',
          silenceDurationMs: 150_000,
          cpuTimeMs: 4200,
          processAlive: true,
          receivedAt: Date.now(),
        },
      },
    };

    const { ThinkingIndicator } = await import('../ThinkingIndicator');
    act(() => {
      root.render(React.createElement(ThinkingIndicator));
    });

    // Invariant: alive_but_silent MUST have a cancel button
    const cancelBtn = container.querySelector('[aria-label="Stop codex live_invocation inv-1"]');
    expect(cancelBtn).toBeTruthy();
    expect(cancelBtn?.textContent).toContain('取消');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RED TEST 2: alive_but_silent cancel uses the exact execution-scoped endpoint
  // ─────────────────────────────────────────────────────────────────────────
  it('alive_but_silent cancel button targets the projected execution identity', async () => {
    storeState.catStatuses = { codex: 'alive_but_silent' };
    storeState.catInvocations = {
      codex: {
        livenessWarning: {
          level: 'alive_but_silent',
          state: 'busy-silent',
          silenceDurationMs: 150_000,
          cpuTimeMs: 4200,
          processAlive: true,
          receivedAt: Date.now(),
        },
      },
    };

    const { ThinkingIndicator } = await import('../ThinkingIndicator');
    act(() => {
      root.render(React.createElement(ThinkingIndicator));
    });

    const cancelBtn = container.querySelector('[aria-label="Stop codex live_invocation inv-1"]') as HTMLButtonElement;
    expect(cancelBtn).toBeTruthy();

    await act(async () => {
      cancelBtn.click();
      await Promise.resolve();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/thread-1/executions/live/inv-1/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catId: 'codex' }),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ChatInput "猫猫正在回复中" banner cancel invariant (structural contract)
//
// P1-1 from review: ChatInput banner shows "猫猫正在回复中" but had no
// cancel affordance. ChatInput is too complex to render in isolation (many
// hooks), so we verify the contract structurally: when hasActiveInvocation
// renders the banner, it MUST contain a cancel/stop button.
// ─────────────────────────────────────────────────────────────────────────
describe('ChatInput active invocation banner cancel invariant (structural)', () => {
  it('banner block contains a cancel button gated on onStop', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const source = await readFile(join(import.meta.dirname, '..', 'ChatInput.tsx'), 'utf-8');

    // Find the hasActiveInvocation banner block
    const bannerIdx = source.indexOf('hasActiveInvocation && (');
    expect(bannerIdx).toBeGreaterThan(-1);

    // Extract through the banner's cancel button. The click handler itself may contain `)}`.
    const afterBanner = source.slice(bannerIdx);
    const closingIdx = afterBanner.indexOf('</button>');
    expect(closingIdx).toBeGreaterThan(-1);
    const bannerBlock = afterBanner.slice(0, closingIdx + '</button>'.length);

    // INVARIANT: banner MUST have a testid for identification
    expect(bannerBlock).toContain('data-testid="active-invocation-banner"');

    // INVARIANT: banner MUST contain a cancel button gated on onStop
    expect(bannerBlock).toContain('data-testid="banner-cancel-btn"');
    expect(bannerBlock).toContain('onStop');
    expect(bannerBlock).toContain("createExplicitStopIntent(event, 'chat_input_banner')");
    expect(bannerBlock).toContain('取消');
  });

  it('banner cancel button is gated on onStop (not always visible)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const source = await readFile(join(import.meta.dirname, '..', 'ChatInput.tsx'), 'utf-8');

    // Find the cancel button inside the banner
    const bannerIdx = source.indexOf('hasActiveInvocation && (');
    const afterBanner = source.slice(bannerIdx);
    const cancelIdx = afterBanner.indexOf('banner-cancel-btn');
    expect(cancelIdx).toBeGreaterThan(-1);

    // The cancel button must be gated — look for {onStop && before it
    const beforeCancel = afterBanner.slice(0, cancelIdx);
    expect(beforeCancel).toContain('{onStop && (');
  });
});
