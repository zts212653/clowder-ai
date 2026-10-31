import { beforeEach, describe, expect, it } from 'vitest';
import { type ArtifactWorkReturnHandle, createArtifactWorkPresentationState } from '../artifact-work-presentation';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { createArtifactSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-initial-state';

const SURFACE = createArtifactSurface({
  threadId: 'thread-a',
  artifact: {
    type: 'image',
    name: 'Workspace draft',
    catId: 'codex-sol',
    createdAt: 1790960000000,
    sourceMessageId: 'message-artifact',
    ref: 'artifact-workspace-draft',
  },
});

const RETURN_HANDLE: ArtifactWorkReturnHandle = {
  host: { owner: 'host', key: 'thread-a:world-cafe' },
  workbench: { owner: 'f307', key: SURFACE.id },
  chatReadingRef: 'chat-reading:v1:opaque-a',
  client: { owner: 'artifact-review', key: 'artifact-workspace-draft:selection' },
};

describe('F307 artifact presentation store integration', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([SURFACE]),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
      focusSurfaceId: null,
      artifactWorkPresentation: createArtifactWorkPresentationState(),
    });
  });

  it('persists the independent Artifact split preference without persisting the transient session', () => {
    useF307ExperienceWorkbenchStore.getState().dispatchArtifactWorkPresentation({
      type: 'set-chat-basis',
      initiator: 'user',
      basis: 38,
    });
    expect(window.localStorage.getItem('cat-cafe:artifactWorkChatBasis')).toBe('38');

    useF307ExperienceWorkbenchStore.setState({
      artifactWorkPresentation: createArtifactWorkPresentationState(),
      hydrated: false,
    });
    useF307ExperienceWorkbenchStore.getState().hydrate();
    expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation).toMatchObject({
      desktopWorkChatBasis: 38,
      session: null,
    });
  });

  it('keeps the transient presentation in the canonical F307 store without changing persisted topology', () => {
    const before = useF307ExperienceWorkbenchStore.getState();
    const effect = before.dispatchArtifactWorkPresentation({
      type: 'begin',
      initiator: 'user',
      threadId: 'thread-a',
      surfaceId: SURFACE.id,
      returnHandle: RETURN_HANDLE,
    });

    const after = useF307ExperienceWorkbenchStore.getState();
    expect(effect).toEqual({ kind: 'none' });
    expect(after.layout).toBe(before.layout);
    expect(after.artifactWorkPresentation.session).toMatchObject({ mode: 'split', surfaceId: SURFACE.id });

    const session = after.artifactWorkPresentation.session;
    if (!session) throw new Error('expected active artifact presentation');
    after.dispatchArtifactWorkPresentation({
      type: 'enter-full-window',
      initiator: 'user',
      generation: session.generation,
      threadId: session.threadId,
      surfaceId: session.surfaceId,
    });

    const expanded = useF307ExperienceWorkbenchStore.getState();
    expect(expanded.artifactWorkPresentation.session?.mode).toBe('full-window');
    expect(expanded.mainAreaAttentionSurfaceId).toBeNull();
    expect(expanded.layout).toBe(before.layout);
  });
});
