import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mockAgentHookRefresh,
  mockGovRefetch,
  mockUseAgentHookHealth,
  renderChatContainer,
  resetChatContainerMocks,
  setMockGovernanceStatus,
  staleAgentHookHealth,
  storeState,
} from './chat-container-test-helpers';

describe('ChatContainer governance refetch', () => {
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
    resetChatContainerMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('does not refetch governance status when switching threads within the same project', async () => {
    await act(async () => {
      root.render(renderChatContainer('thread-a'));
    });

    expect(mockGovRefetch).not.toHaveBeenCalled();

    await act(async () => {
      root.render(renderChatContainer('thread-b'));
    });

    expect(mockGovRefetch).not.toHaveBeenCalled();
  });

  it('does not render stale agent hook health outside project threads', async () => {
    mockUseAgentHookHealth.mockReturnValue({
      health: staleAgentHookHealth,
      error: null,
      syncing: false,
      synced: false,
      syncAttempted: false,
      sync: vi.fn(),
      refresh: mockAgentHookRefresh,
    });

    await act(async () => {
      root.render(renderChatContainer('thread-a'));
    });

    expect(container.textContent).toContain('Agent 运行环境需要同步');

    storeState.currentProjectPath = 'default';
    await act(async () => {
      root.render(renderChatContainer('thread-b'));
    });

    expect(mockUseAgentHookHealth).toHaveBeenCalledWith({ enabled: false, projectPath: 'default' });
    expect(container.textContent).not.toContain('Agent 运行环境需要同步');
  });

  it('refreshes governance and agent-hook health after project setup completes', async () => {
    setMockGovernanceStatus({ isEmptyDir: true, isGitRepo: false, gitAvailable: true });

    await act(async () => {
      root.render(renderChatContainer('thread-a'));
    });

    const complete = container.querySelector<HTMLButtonElement>('[data-testid="project-setup-complete"]');
    expect(complete).not.toBeNull();

    await act(async () => {
      complete?.click();
    });

    expect(mockGovRefetch).toHaveBeenCalledTimes(1);
    expect(mockAgentHookRefresh).toHaveBeenCalledTimes(1);
  });
});
