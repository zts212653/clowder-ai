import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavigateEvent } from '@/hooks/useWorkspaceNavigate';
import { useWorkspaceNavigate } from '@/hooks/useWorkspaceNavigate';
import { getPendingWorkspaceNavigation, type WorkspaceNavigationReceipt } from '@/hooks/workspace-navigation-pending';
import { useChatStore } from '@/stores/chatStore';
import { createFakeHubSocket, type FakeHubSocket, withHubSocket } from '@/test-utils/fake-hub-socket';

Object.assign(globalThis as Record<string, unknown>, { React, IS_REACT_ACT_ENVIRONMENT: true });

// The page connection is owned by ThreadChatRuntimeProvider; the hook holds the ack room and
// one listener on it.
let fake: FakeHubSocket;

function Probe(props: { threadId: string | null; isChatRoute: boolean; isWorkspaceVisible?: boolean }) {
  useWorkspaceNavigate(props.threadId, {
    isChatRoute: props.isChatRoute,
    isWorkspaceVisible: props.isWorkspaceVisible,
  });
  return null;
}

describe('useWorkspaceNavigate delivery lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    fake = createFakeHubSocket();
    fake.connect();
    window.sessionStorage.clear();
    useChatStore.setState({
      currentProjectPath: '/work/cat-cafe',
      currentThreadId: 'default',
      presentationLock: null,
      workspaceWorktreeId: 'cat-cafe',
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      workspaceOpenTabs: [],
      workspaceWorktreeAliases: {},
      workspaceWorktreeAliasesProjectPath: null,
      rightPanelMode: 'status',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = withHubSocket(createRoot(container), fake.hub);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.sessionStorage.clear();
  });

  it('acknowledges non-chat delivery as queued and applies it when the target chat mounts', async () => {
    act(() => {
      root.render(<Probe threadId={null} isChatRoute={false} />);
    });
    expect(fake.listenerCount('workspace:navigate')).toBe(1);
    expect(fake.heldRooms()).toEqual(['workspace:navigate:ack']);

    const data: NavigateEvent = {
      action: 'open',
      path: 'docs/guide.md',
      line: 42,
      worktreeId: 'cat-cafe-feature',
      threadId: 'thread-target',
      eventId: 'event-queued',
    };
    const acknowledge = vi.fn<(receipt: WorkspaceNavigationReceipt) => void>();
    act(() => {
      fake.deliver('workspace:navigate', data, acknowledge);
    });

    expect(acknowledge).toHaveBeenCalledWith({
      status: 'queued',
      eventId: 'event-queued',
      reason: 'non_chat_route',
    });
    expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();

    useChatStore.setState({ currentThreadId: 'thread-target' });
    act(() => {
      root.render(<Probe threadId="thread-target" isChatRoute />);
    });
    await vi.waitFor(() => expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/guide.md'));

    const state = useChatStore.getState();
    expect(state.workspaceWorktreeId).toBe('cat-cafe-feature');
    expect(state.workspaceOpenFilePath).toBe('docs/guide.md');
    expect(state.workspaceOpenFileLine).toBe(42);
    expect(state.rightPanelMode).toBe('workspace');
  });

  it('acknowledges an active visible chat only after applying the Workspace state', async () => {
    useChatStore.setState({ currentThreadId: 'thread-target' });
    act(() => {
      root.render(<Probe threadId="thread-target" isChatRoute />);
    });
    expect(fake.listenerCount('workspace:navigate')).toBe(1);

    const acknowledge = vi.fn<(receipt: WorkspaceNavigationReceipt) => void>();
    act(() => {
      fake.deliver(
        'workspace:navigate',
        {
          action: 'open',
          path: 'docs/applied.md',
          worktreeId: 'cat-cafe',
          threadId: 'thread-target',
          eventId: 'event-applied',
        } satisfies NavigateEvent,
        acknowledge,
      );
    });

    expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/applied.md');
    expect(acknowledge).toHaveBeenCalledWith({ status: 'applied', eventId: 'event-applied' });
  });

  it('queues an active chat navigation while the Workspace panel is below its 768px breakpoint', async () => {
    useChatStore.setState({ currentThreadId: 'thread-target' });
    act(() => {
      root.render(<Probe threadId="thread-target" isChatRoute isWorkspaceVisible={false} />);
    });
    expect(fake.listenerCount('workspace:navigate')).toBe(1);

    const acknowledge = vi.fn<(receipt: WorkspaceNavigationReceipt) => void>();
    act(() => {
      fake.deliver(
        'workspace:navigate',
        {
          action: 'open',
          path: 'docs/narrow.md',
          worktreeId: 'cat-cafe',
          threadId: 'thread-target',
          eventId: 'event-narrow',
        } satisfies NavigateEvent,
        acknowledge,
      );
    });

    expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
    expect(acknowledge).toHaveBeenCalledWith({
      status: 'queued',
      eventId: 'event-narrow',
      reason: 'narrow_viewport',
    });
  });

  it('keeps Presentation Lock inside the apply boundary if lock state changes after the delivery precheck', async () => {
    useChatStore.setState({ currentThreadId: 'thread-target' });
    act(() => {
      root.render(<Probe threadId="thread-target" isChatRoute />);
    });
    expect(fake.listenerCount('workspace:navigate')).toBe(1);

    const unlockedState = useChatStore.getState();
    const lockedState = {
      ...unlockedState,
      presentationLock: {
        ownerThreadId: 'thread-target',
        ownerWorkspace: {
          worktreeId: 'cat-cafe',
          filePath: null,
          line: null,
          tabs: [],
        },
        worktreeId: 'cat-cafe',
        filePath: null,
        line: null,
        tabs: [],
        scrollTop: null,
      },
    };
    const getStateSpy = vi
      .spyOn(useChatStore, 'getState')
      .mockReturnValueOnce(unlockedState)
      .mockReturnValue(lockedState);
    const acknowledge = vi.fn<(receipt: WorkspaceNavigationReceipt) => void>();

    act(() => {
      fake.deliver(
        'workspace:navigate',
        {
          action: 'open',
          path: 'docs/locked-race.md',
          worktreeId: 'cat-cafe',
          threadId: 'thread-target',
          eventId: 'event-lock-race',
        } satisfies NavigateEvent,
        acknowledge,
      );
    });
    getStateSpy.mockRestore();

    expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
    expect(acknowledge).toHaveBeenCalledWith({
      status: 'blocked',
      eventId: 'event-lock-race',
      reason: 'presentation_lock',
    });
    expect(getPendingWorkspaceNavigation(window.sessionStorage, 'thread-target')?.eventId).toBe('event-lock-race');
  });

  it('keeps one listener and its room on the page connection while live delivery state changes', async () => {
    act(() => {
      root.render(<Probe threadId="thread-a" isChatRoute />);
    });
    expect(fake.listenerCount('workspace:navigate')).toBe(1);
    expect(fake.heldRooms()).toEqual(['workspace:navigate:ack']);

    act(() => {
      root.render(<Probe threadId={null} isChatRoute={false} />);
    });
    act(() => {
      root.render(<Probe threadId="thread-b" isChatRoute isWorkspaceVisible={false} />);
    });
    act(() => {
      useChatStore.setState({
        currentThreadId: 'thread-b',
        currentProjectPath: '/work/cat-cafe-feature',
        workspaceWorktreeAliases: { 'cat-cafe-feature': 'cat-cafe' },
        workspaceWorktreeAliasesProjectPath: '/work/cat-cafe-feature',
      });
      root.render(<Probe threadId="thread-b" isChatRoute />);
    });

    expect(fake.listenerCount('workspace:navigate')).toBe(1);
    expect(fake.heldRooms()).toEqual(['workspace:navigate:ack']);

    const acknowledge = vi.fn<(receipt: WorkspaceNavigationReceipt) => void>();
    act(() => {
      fake.deliver(
        'workspace:navigate',
        {
          action: 'open',
          path: 'docs/live-state.md',
          worktreeId: 'cat-cafe-feature',
          threadId: 'thread-b',
          eventId: 'event-live-state',
        } satisfies NavigateEvent,
        acknowledge,
      );
    });

    expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/live-state.md');
    expect(acknowledge).toHaveBeenCalledWith({ status: 'applied', eventId: 'event-live-state' });
  });

  it('retains a blocked request without stealing the locked file or the unlocked origin', async () => {
    useChatStore.setState({
      currentThreadId: 'thread-target',
      workspaceOpenFilePath: 'docs/original.md',
      workspaceOpenTabs: ['docs/original.md'],
      workspaceOpenFileLine: 7,
    });
    act(() => {
      useChatStore.getState().enablePresentationLock();
      root.render(<Probe threadId="thread-target" isChatRoute />);
    });
    expect(fake.listenerCount('workspace:navigate')).toBe(1);
    const data: NavigateEvent = {
      action: 'open',
      path: 'docs/requested.md',
      line: 42,
      worktreeId: 'cat-cafe',
      threadId: 'thread-target',
      eventId: 'event-locked-request',
    };
    const acknowledge = vi.fn<(receipt: WorkspaceNavigationReceipt) => void>();
    act(() => fake.deliver('workspace:navigate', data, acknowledge));

    expect(acknowledge).toHaveBeenCalledWith({
      status: 'blocked',
      eventId: data.eventId,
      reason: 'presentation_lock',
    });
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/original.md');
    expect(getPendingWorkspaceNavigation(window.sessionStorage, 'thread-target')).toEqual(data);
    act(() => useChatStore.getState().disablePresentationLock());
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/original.md');
    expect(getPendingWorkspaceNavigation(window.sessionStorage, 'thread-target')).toEqual(data);
  });
});
