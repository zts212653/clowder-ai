import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

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
          projectPath: '/home/user/my-project',
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
          projectPath: '/home/user/proj',
          reasonKind: 'needs_confirmation',
        }),
      );
    });

    expect(container.textContent).toContain('治理初始化待确认');
  });

  it('calls confirm then retry on button click', async () => {
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

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

    expect(mockApiFetch).toHaveBeenCalledWith('/api/governance/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: '/test/proj' }),
    });

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
        }),
      );
    });

    const button = container.querySelector('button')!;
    await act(async () => {
      button.click();
    });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
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
    const retryButton = container.querySelector('button');
    expect(retryButton).toBeTruthy();
    expect(retryButton?.textContent).toContain('重试');
  });

  it('extracts directory name from Windows backslash path', () => {
    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: 'C:\\workspace\\tmp',
          reasonKind: 'needs_bootstrap',
        }),
      );
    });

    // Should show "tmp", not the full "C:\workspace\tmp"
    expect(container.textContent).toContain('tmp');
    expect(container.textContent).not.toContain('C:\\workspace\\tmp');
  });

  it('resets to idle state when invocationId prop changes', async () => {
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

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

    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/test/proj',
          reasonKind: 'needs_bootstrap',
          invocationId: 'inv-B',
        }),
      );
    });

    const newButton = container.querySelector('button');
    expect(newButton).toBeTruthy();
    expect(newButton?.textContent).toContain('初始化治理并继续');
  });
});
