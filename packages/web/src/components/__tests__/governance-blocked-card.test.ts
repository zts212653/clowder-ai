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

  it('renders a historical notice with direct retry and optional installer', () => {
    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/home/user/workspace/my-project',
          reasonKind: 'needs_bootstrap',
          invocationId: 'inv-123',
        }),
      );
    });

    expect(container.querySelector('[data-testid="governance-blocked-card"]')).toBeTruthy();
    expect(container.textContent).toContain('my-project');
    expect(container.textContent).toContain('历史治理阻塞已解除');
    expect(container.textContent).toContain('派遣不再要求目标仓先安装治理');

    const button = [...container.querySelectorAll('button')].find((node) => node.textContent === '直接重试派遣');
    expect(button).toBeTruthy();
    expect(container.querySelector('[data-testid="governance-installer"]')).toBeTruthy();
  });

  it('does not preserve old marker-specific readiness copy', () => {
    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/home/user/workspace/proj',
          reasonKind: 'needs_confirmation',
        }),
      );
    });

    expect(container.textContent).toContain('历史治理阻塞已解除');
    expect(container.textContent).not.toContain('治理初始化待确认');
  });

  it('retries dispatch without installing governance', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/test/proj',
          reasonKind: 'needs_bootstrap',
          invocationId: 'inv-456',
        }),
      );
    });

    const button = [...container.querySelectorAll('button')].find((node) => node.textContent === '直接重试派遣')!;
    await act(async () => {
      button.click();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/invocations/inv-456/retry', {
      method: 'POST',
    });
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('已重试派遣');
  });

  it('offers only optional governance when invocationId is not provided', async () => {
    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/test/proj',
          reasonKind: 'needs_bootstrap',
        }),
      );
    });

    expect(container.textContent).not.toContain('直接重试派遣');
    expect(container.querySelector('[data-testid="governance-installer"]')).toBeTruthy();
    expect(mockApiFetch).not.toHaveBeenCalled();
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

    const button = [...container.querySelectorAll('button')].find((node) => node.textContent === '直接重试派遣')!;
    await act(async () => {
      button.click();
    });

    expect(container.textContent).toContain('Path not allowed');
    const retryButton = [...container.querySelectorAll('button')].find((node) => node.textContent === '重试');
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
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/test/proj',
          reasonKind: 'needs_bootstrap',
          invocationId: 'inv-A',
        }),
      );
    });

    const button = [...container.querySelectorAll('button')].find((node) => node.textContent === '直接重试派遣')!;
    await act(async () => {
      button.click();
    });

    expect(container.textContent).toContain('已重试派遣');

    act(() => {
      root.render(
        React.createElement(GovernanceBlockedCard, {
          projectPath: '/test/proj',
          reasonKind: 'needs_bootstrap',
          invocationId: 'inv-B',
        }),
      );
    });

    const newButton = [...container.querySelectorAll('button')].find((node) => node.textContent === '直接重试派遣');
    expect(newButton).toBeTruthy();
  });
});
