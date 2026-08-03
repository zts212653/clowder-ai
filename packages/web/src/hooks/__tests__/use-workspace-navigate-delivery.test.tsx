import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavigateEvent } from '@/hooks/useWorkspaceNavigate';
import { useWorkspaceNavigate } from '@/hooks/useWorkspaceNavigate';
import type { WorkspaceNavigationReceipt } from '@/hooks/workspace-navigation-pending';
import { useChatStore } from '@/stores/chatStore';

Object.assign(globalThis as Record<string, unknown>, { React, IS_REACT_ACT_ENVIRONMENT: true });

const socketState = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler)),
    off: vi.fn((event: string) => handlers.delete(event)),
    disconnect: vi.fn(),
  };
  return {
    handlers,
    socket,
    connect: vi.fn(() => socket),
  };
});

vi.mock('socket.io-client', () => ({
  io: () => socketState.connect(),
}));

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
    socketState.handlers.clear();
    socketState.socket.emit.mockClear();
    socketState.socket.on.mockClear();
    socketState.socket.off.mockClear();
    socketState.socket.disconnect.mockClear();
    socketState.connect.mockClear();
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
    root = createRoot(container);
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
    await vi.waitFor(() => expect(socketState.handlers.has('workspace:navigate')).toBe(true));
    expect(socketState.socket.emit).toHaveBeenCalledWith('join_room', 'workspace:navigate:ack');

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
      socketState.handlers.get('workspace:navigate')?.(data, acknowledge);
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
    await vi.waitFor(() => expect(socketState.handlers.has('workspace:navigate')).toBe(true));

    const acknowledge = vi.fn<(receipt: WorkspaceNavigationReceipt) => void>();
    act(() => {
      socketState.handlers.get('workspace:navigate')?.(
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
    await vi.waitFor(() => expect(socketState.handlers.has('workspace:navigate')).toBe(true));

    const acknowledge = vi.fn<(receipt: WorkspaceNavigationReceipt) => void>();
    act(() => {
      socketState.handlers.get('workspace:navigate')?.(
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
    await vi.waitFor(() => expect(socketState.handlers.has('workspace:navigate')).toBe(true));

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
      socketState.handlers.get('workspace:navigate')?.(
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
    expect(acknowledge).toHaveBeenCalledWith({ status: 'blocked', eventId: 'event-lock-race' });
  });

  it('keeps one app-scoped socket while live delivery state changes', async () => {
    act(() => {
      root.render(<Probe threadId="thread-a" isChatRoute />);
    });
    await vi.waitFor(() => expect(socketState.handlers.has('workspace:navigate')).toBe(true));
    expect(socketState.connect).toHaveBeenCalledTimes(1);

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

    expect(socketState.connect).toHaveBeenCalledTimes(1);
    expect(socketState.socket.disconnect).not.toHaveBeenCalled();

    const acknowledge = vi.fn<(receipt: WorkspaceNavigationReceipt) => void>();
    act(() => {
      socketState.handlers.get('workspace:navigate')?.(
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
});
