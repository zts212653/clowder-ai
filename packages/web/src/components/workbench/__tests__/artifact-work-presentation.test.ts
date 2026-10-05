import { describe, expect, it } from 'vitest';
import {
  type ArtifactWorkPresentationState,
  type ArtifactWorkReturnHandle,
  createArtifactWorkPresentationState,
  reduceArtifactWorkPresentation,
} from '../artifact-work-presentation';

const RETURN_HANDLE: ArtifactWorkReturnHandle = {
  host: { owner: 'host', key: 'thread-a:world-cafe' },
  workbench: { owner: 'f307', key: 'surface-artifact:layout-7' },
  chatReadingRef: 'chat-reading:v1:opaque-a',
  client: { owner: 'artifact-review', key: 'review-7:selection-3' },
};

function begin(
  state: ArtifactWorkPresentationState = createArtifactWorkPresentationState(),
  threadId = 'thread-a',
  surfaceId = 'artifact:7',
) {
  return reduceArtifactWorkPresentation(state, {
    type: 'begin',
    initiator: 'user',
    threadId,
    surfaceId,
    returnHandle: RETURN_HANDLE,
  });
}

function scoped(state: ArtifactWorkPresentationState) {
  const session = state.session;
  if (!session) throw new Error('expected active artifact work session');
  return { generation: session.generation, threadId: session.threadId, surfaceId: session.surfaceId };
}

describe('F307 artifact work presentation', () => {
  it('begins in the default 30/70 split only for an explicit user action', () => {
    const initial = createArtifactWorkPresentationState();
    expect(
      reduceArtifactWorkPresentation(initial, {
        type: 'set-chat-basis',
        initiator: 'background',
        basis: 60,
      }).state,
    ).toBe(initial);
    const background = reduceArtifactWorkPresentation(initial, {
      type: 'begin',
      initiator: 'background',
      threadId: 'thread-a',
      surfaceId: 'artifact:7',
      returnHandle: RETURN_HANDLE,
    });
    expect(background).toEqual({ state: initial, effect: { kind: 'none' } });

    const opened = begin(initial);
    expect(opened.state).toMatchObject({
      generation: 1,
      desktopWorkChatBasis: 30,
      session: { generation: 1, threadId: 'thread-a', surfaceId: 'artifact:7', mode: 'split' },
    });
    expect(opened.state.session?.returnHandle).toBe(RETURN_HANDLE);
  });

  it('enters full-window only for the current user-owned session and keeps the split ratio', () => {
    const opened = begin().state;
    const scope = scoped(opened);
    const resized = reduceArtifactWorkPresentation(opened, {
      type: 'set-chat-basis',
      initiator: 'user',
      basis: 37,
    }).state;
    const background = reduceArtifactWorkPresentation(resized, {
      type: 'enter-full-window',
      initiator: 'background',
      ...scope,
    }).state;
    expect(background.session?.mode).toBe('split');

    const expanded = reduceArtifactWorkPresentation(background, {
      type: 'enter-full-window',
      initiator: 'user',
      ...scope,
    }).state;
    expect(expanded.session?.mode).toBe('full-window');
    expect(expanded.desktopWorkChatBasis).toBe(37);

    const returned = reduceArtifactWorkPresentation(expanded, {
      type: 'leave-full-window',
      initiator: 'user',
      ...scope,
    });
    expect(returned.state.session?.mode).toBe('split');
    expect(returned.state.desktopWorkChatBasis).toBe(37);
  });

  it('returns an exact chat target effect without replacing the chat owner state', () => {
    const split = begin().state;
    const scope = scoped(split);
    const expanded = reduceArtifactWorkPresentation(split, {
      type: 'enter-full-window',
      initiator: 'user',
      ...scope,
    }).state;
    const target = { threadId: 'thread-a', messageId: 'message-99' };

    const revealed = reduceArtifactWorkPresentation(expanded, {
      type: 'reveal-chat-target',
      initiator: 'user',
      ...scope,
      target,
    });

    expect(revealed.state.session?.mode).toBe('split');
    expect(revealed.effect).toEqual({
      kind: 'reveal-chat-target',
      generation: scope.generation,
      target,
    });
    expect(revealed.state.session?.returnHandle.chatReadingRef).toBe(RETURN_HANDLE.chatReadingRef);
  });

  it('returns the original owner refs only from the exact current session', () => {
    const first = begin().state;
    const firstScope = scoped(first);
    const second = begin(first, 'thread-b', 'artifact:8').state;
    const stale = reduceArtifactWorkPresentation(second, {
      type: 'close',
      initiator: 'host',
      ...firstScope,
    });
    expect(stale).toEqual({ state: second, effect: { kind: 'none' } });

    const current = reduceArtifactWorkPresentation(second, {
      type: 'close',
      initiator: 'host',
      ...scoped(second),
    });
    expect(current.state.session).toBeNull();
    expect(current.effect).toEqual({
      kind: 'restore-origin',
      generation: 2,
      returnHandle: RETURN_HANDLE,
    });
  });

  it('rejects malformed owner refs and cross-thread message targets', () => {
    const initial = createArtifactWorkPresentationState();
    const malformed = reduceArtifactWorkPresentation(initial, {
      type: 'begin',
      initiator: 'user',
      threadId: 'thread-a',
      surfaceId: 'artifact:7',
      returnHandle: { ...RETURN_HANDLE, host: { owner: '', key: 'thread-a' } },
    });
    expect(malformed).toEqual({ state: initial, effect: { kind: 'none' } });

    const split = begin().state;
    const scope = scoped(split);
    const expanded = reduceArtifactWorkPresentation(split, {
      type: 'enter-full-window',
      initiator: 'user',
      ...scope,
    }).state;
    const crossThread = reduceArtifactWorkPresentation(expanded, {
      type: 'reveal-chat-target',
      initiator: 'user',
      ...scope,
      target: { threadId: 'thread-b', messageId: 'message-99' },
    });
    expect(crossThread).toEqual({ state: expanded, effect: { kind: 'none' } });
  });

  it('fails closed on current navigation invalidation and ignores stale invalidations', () => {
    const first = begin().state;
    const firstScope = scoped(first);
    const second = begin(first, 'thread-b', 'artifact:8').state;
    const stale = reduceArtifactWorkPresentation(second, {
      type: 'invalidate',
      initiator: 'host',
      reason: 'thread-changed',
      ...firstScope,
    });
    expect(stale).toEqual({ state: second, effect: { kind: 'none' } });

    const invalidated = reduceArtifactWorkPresentation(second, {
      type: 'invalidate',
      initiator: 'host',
      reason: 'thread-changed',
      ...scoped(second),
    });
    expect(invalidated.state.session).toBeNull();
    expect(invalidated.effect).toEqual({ kind: 'safe-host-scene', generation: 2, reason: 'thread-changed' });
  });
});
