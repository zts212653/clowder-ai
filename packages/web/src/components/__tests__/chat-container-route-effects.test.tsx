import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SidebarSnapshotRow, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { renderChatContainer, resetChatContainerMocks, storeState } from './chat-container-test-helpers';

const brandDisplayName = vi.hoisted(() => 'Synthetic Welcome Écran');
vi.mock('@cat-cafe/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cat-cafe/shared')>();
  return {
    ...actual,
    deploymentDefaults: {
      ...actual.deploymentDefaults,
      brand: { ...actual.deploymentDefaults.brand, displayName: brandDisplayName },
    },
  };
});

let host: HTMLDivElement;
let root: Root;
function sidebarRow(id: string, projectPath: string): SidebarSnapshotRow {
  return {
    id,
    projectPath,
    title: id,
    participants: [],
    pinned: false,
    favorited: false,
    labels: [],
    preferredCats: [],
    lastActiveAt: 1,
    systemKind: null,
    isHubThread: false,
    unreadCount: 0,
    hasUserMention: false,
    presence: { status: 'idle' },
  };
}
const render = async (threadId = 'thread-a') => {
  await act(async () => root.render(renderChatContainer(threadId)));
};
beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, '', '/thread/thread-a');
  localStorage.setItem('cat-cafe:first-run-quest-skipped', '1');
  resetChatContainerMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.history.replaceState(null, '', '/');
  localStorage.removeItem('cat-cafe:first-run-quest-skipped');
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ChatContainer selected deployment brand', () => {
  it('renders the configured display name in the empty-conversation welcome', async () => {
    await render();
    expect(host.textContent).toContain(`欢迎来到 ${brandDisplayName}!`);
  });
});

describe('ChatContainer URL research hint', () => {
  it('shows the hint for research=multi and removes it as the route query changes', async () => {
    window.history.replaceState(null, '', '/thread/thread-a?signal=art-1&research=multi');
    await render();
    expect(host.textContent).toContain('多猫研究模式');
    for (const query of ['?research=single', '?signal=art-1', '']) {
      window.history.replaceState(null, '', `/thread/thread-a${query}`);
      await render();
      expect(host.textContent).not.toContain('多猫研究模式');
    }
  });
});

describe('ChatContainer project restoration', () => {
  it('uses canonical sidebar metadata before a stale legacy thread cache', async () => {
    useSidebarProjectionStore.setState({ rows: [sidebarRow('thread-a', '/projects/canonical')] });
    await render();
    expect(storeState.setCurrentProject).toHaveBeenLastCalledWith('/projects/canonical');
    expect(storeState.setCurrentProject).not.toHaveBeenCalledWith('/tmp/demo-project');
  });

  it('restores the legacy project on route changes when canonical metadata is absent', async () => {
    storeState.threads[1].projectPath = '/projects/second';
    await render();
    expect(storeState.setCurrentProject).toHaveBeenLastCalledWith('/tmp/demo-project');
    await render('thread-b');
    expect(storeState.setCurrentProject).toHaveBeenLastCalledWith('/projects/second');
  });

  it.each(['', 'default'])('uses default for known threads with project %j', async (projectPath) => {
    useSidebarProjectionStore.setState({ rows: [sidebarRow('thread-a', projectPath)] });
    await render();
    expect(storeState.setCurrentProject).toHaveBeenLastCalledWith('default');
  });

  it('waits for an unknown real thread’s own metadata instead of resetting its project', async () => {
    await render('unknown-thread');
    expect(storeState.setCurrentProject).not.toHaveBeenCalled();
    await act(async () =>
      useSidebarProjectionStore.setState({ rows: [sidebarRow('unknown-thread', '/projects/arrived')] }),
    );
    expect(storeState.setCurrentProject).toHaveBeenLastCalledWith('/projects/arrived');
  });

  it('restores the virtual default conversation without waiting for metadata', async () => {
    await render('default');
    expect(storeState.setCurrentProject).toHaveBeenLastCalledWith('default');
  });
});
