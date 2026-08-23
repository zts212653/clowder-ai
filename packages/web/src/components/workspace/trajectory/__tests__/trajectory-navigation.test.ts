import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import {
  decodeTrajectoryOriginRef,
  encodeTrajectoryOriginRef,
  hydrateInvocationTrajectoryFromCurrentUrl,
  readTrajectoryTarget,
  restoreTrajectoryOrigin,
} from '../trajectory-navigation';

describe('F299 typed trajectory origin navigation', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/thread/thread-a?workspaceMode=trajectory&inv=inv-a');
    useChatStore.setState({ currentThreadId: 'thread-a', rightPanelOpen: true, workspaceMode: 'trajectory' });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('round-trips message and Eval origins without copying source content', () => {
    const message = {
      kind: 'message' as const,
      threadId: 'thread-message',
      messageId: 'message-17',
      viewportOffsetPx: 42,
    };
    const evalOrigin = {
      kind: 'eval' as const,
      threadId: 'thread-eval',
      eventId: 'verdict-a',
      viewportOffsetPx: 18,
    };
    expect(decodeTrajectoryOriginRef(encodeTrajectoryOriginRef(message))).toEqual(message);
    expect(decodeTrajectoryOriginRef(encodeTrajectoryOriginRef(evalOrigin))).toEqual(evalOrigin);
    expect(encodeTrajectoryOriginRef(message)).not.toContain('source content');
  });

  it('rejects malformed origin and treats a direct link as source-less detail', () => {
    expect(decodeTrajectoryOriginRef('message:{broken')).toBeUndefined();
    const target = readTrajectoryTarget(
      new URL('http://localhost/thread/thread-a?workspaceMode=trajectory&inv=inv-direct'),
    );
    expect(target).toEqual({ invocationId: 'inv-direct' });
  });

  it('hydrates a source-less direct link into the visible Workspace host', () => {
    window.history.replaceState({}, '', '/thread/thread-a?workspaceMode=trajectory&inv=inv-direct');
    useChatStore.setState({ rightPanelMode: 'status', rightPanelOpen: false, workspaceMode: 'dev' });

    expect(hydrateInvocationTrajectoryFromCurrentUrl()).toEqual({
      invocationId: 'inv-direct',
    });
    expect(useChatStore.getState()).toMatchObject({
      rightPanelMode: 'workspace',
      rightPanelOpen: true,
      workspaceMode: 'trajectory',
    });
  });

  it('restores an exact message identity and viewport offset', () => {
    const chat = document.createElement('div');
    chat.dataset.chatContainer = '';
    chat.scrollTop = 100;
    chat.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
    const boundary = document.createElement('div');
    boundary.dataset.messageViewportId = 'message-17';
    boundary.getBoundingClientRect = () => ({ top: 200, bottom: 240 }) as DOMRect;
    const message = document.createElement('div');
    message.dataset.messageId = 'message-17';
    boundary.appendChild(message);
    chat.appendChild(boundary);
    document.body.appendChild(chat);

    restoreTrajectoryOrigin({
      kind: 'message',
      threadId: 'thread-a',
      messageId: 'message-17',
      viewportOffsetPx: 40,
    });

    expect(chat.scrollTop).toBe(260);
    expect(useChatStore.getState().rightPanelOpen).toBe(false);
    expect(new URL(window.location.href).searchParams.get('inv')).toBeNull();
  });

  it('restores an exact Eval card and viewport offset', () => {
    const scroll = document.createElement('div');
    scroll.dataset.evalWorkspaceScroll = '';
    scroll.scrollTop = 50;
    scroll.getBoundingClientRect = () => ({ top: 20, bottom: 500 }) as DOMRect;
    const card = document.createElement('article');
    card.dataset.evalEventId = 'eval-17';
    card.tabIndex = -1;
    card.getBoundingClientRect = () => ({ top: 180, bottom: 260 }) as DOMRect;
    scroll.appendChild(card);
    document.body.appendChild(scroll);

    restoreTrajectoryOrigin({
      kind: 'eval',
      threadId: 'thread-a',
      eventId: 'eval-17',
      viewportOffsetPx: 30,
    });

    expect(scroll.scrollTop).toBe(180);
    expect(useChatStore.getState().workspaceMode).toBe('eval');
    expect(document.activeElement).toBe(card);
  });
});
