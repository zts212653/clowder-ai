/**
 * F130: GovernanceBlockedCard — rendering and interaction tests
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// Lazy import after mocks are set up
const { GovernanceBlockedCard } = await import('@/components/GovernanceBlockedCard');

describe('GovernanceBlockedCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders project path and bootstrap button', () => {
    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/Users/test/workspace/my-project',
          reasonKind: 'needs_bootstrap',
          invocationId: 'inv-123',
        }),
      );
    });

    expect(container.querySelector('[data-testid="governance-blocked-card"]')).toBeTruthy();
    expect(container.textContent).toContain('my-project');
    expect(container.textContent).toContain('尚未初始化治理');

    const button = container.querySelector('button');
    expect(button).toBeTruthy();
    expect(button?.textContent).toContain('初始化治理并继续');
  });

  it('shows correct label for needs_confirmation', () => {
    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/Users/test/workspace/proj',
          reasonKind: 'needs_confirmation',
        }),
      );
    });

    expect(container.textContent).toContain('治理初始化待确认');
  });

  it('calls confirm then retry on button click', async () => {
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // confirm
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // retry

    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/test/proj',
          reasonKind: 'needs_bootstrap',
          invocationId: 'inv-456',
        }),
      );
    });

    const button = container.querySelector('button')!;
    await act(async () => {
      button.click();
    });

    // Step 1: confirm was called with correct projectPath
    expect(mockApiFetch).toHaveBeenCalledWith('/api/governance/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: '/test/proj' }),
    });

    // Step 2: retry was called with correct invocationId
    expect(mockApiFetch).toHaveBeenCalledWith('/api/invocations/inv-456/retry', {
      method: 'POST',
    });

    expect(container.textContent).toContain('治理初始化完成');
    expect(container.textContent).toContain('已自动重试');
  });

  it('skips retry when invocationId is not provided', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/test/proj',
          reasonKind: 'needs_bootstrap',
          // no invocationId
        }),
      );
    });

    const button = container.querySelector('button')!;
    await act(async () => {
      button.click();
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(1); // only confirm, no retry
    expect(container.textContent).toContain('治理初始化完成');
    expect(container.textContent).not.toContain('已自动重试');
  });

  it('shows error and retry button on confirm failure', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Path not allowed' }),
    });

    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/test/proj',
          reasonKind: 'needs_bootstrap',
          invocationId: 'inv-789',
        }),
      );
    });

    const button = container.querySelector('button')!;
    await act(async () => {
      button.click();
    });

    expect(container.textContent).toContain('Path not allowed');
    // Retry button should be available
    const retryButton = container.querySelector('button');
    expect(retryButton).toBeTruthy();
    expect(retryButton?.textContent).toContain('重试');
  });

  it('P2-1: button uses latest invocationId after prop update', async () => {
    // Simulate: card initially rendered with inv-A, then prop updates to inv-B
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // confirm
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // retry

    // Render with latest invocationId (frontend patches this on repeated events)
    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/test/proj',
          reasonKind: 'needs_bootstrap',
          invocationId: 'inv-B', // This is the latest, updated from inv-A
        }),
      );
    });

    const button = container.querySelector('button')!;
    await act(async () => {
      button.click();
    });

    // Retry should target inv-B, not inv-A
    expect(mockApiFetch).toHaveBeenCalledWith('/api/invocations/inv-B/retry', {
      method: 'POST',
    });
  });

  it('resets to idle state when invocationId prop changes', async () => {
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // confirm
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // retry

    // Render and complete bootstrap with inv-A
    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/test/proj',
          reasonKind: 'needs_bootstrap',
          invocationId: 'inv-A',
        }),
      );
    });

    const button = container.querySelector('button')!;
    await act(async () => {
      button.click();
    });

    expect(container.textContent).toContain('治理初始化完成');

    // Now invocationId changes to inv-B (patchMessage updates props)
    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/test/proj',
          reasonKind: 'needs_bootstrap',
          invocationId: 'inv-B',
        }),
      );
    });

    // Card should reset to idle — show bootstrap button again
    const newButton = container.querySelector('button');
    expect(newButton).toBeTruthy();
    expect(newButton?.textContent).toContain('初始化治理并继续');
  });
});
