import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceTabBar } from '../workspace/WorkspaceTabBar';

describe('WorkspaceTabBar eval mode', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({ workspaceMode: 'dev', rightPanelMode: 'status' });
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('renders the eval tab as 评估 and switches workspace mode', async () => {
    root.render(<WorkspaceTabBar />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const tab = container.querySelector('[data-testid="workspace-tab-eval"]') as HTMLButtonElement | null;

    expect(tab).not.toBeNull();
    expect(tab?.textContent).toContain('评估');

    tab?.click();
    expect(useChatStore.getState().workspaceMode).toBe('eval');
    expect(useChatStore.getState().rightPanelMode).toBe('workspace');
  });
});
