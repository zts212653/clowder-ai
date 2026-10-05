import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

// Architecture cell: hub-action-surface. This controller changes projection only; owners keep their state.

export function toggleArtifactWorkFullWindow(threadId: string, surface: WorkspaceSurfaceDescriptor): void {
  const store = useF307ExperienceWorkbenchStore.getState();
  store.exitMainAreaAttention();
  let session = store.artifactWorkPresentation.session;
  if (session?.threadId === threadId && session.surfaceId === surface.id && session.mode === 'full-window') {
    store.dispatchArtifactWorkPresentation({
      type: 'leave-full-window',
      initiator: 'user',
      generation: session.generation,
      threadId: session.threadId,
      surfaceId: session.surfaceId,
    });
    return;
  }
  if (session?.threadId !== threadId || session?.surfaceId !== surface.id) {
    store.dispatchArtifactWorkPresentation({
      type: 'begin',
      initiator: 'user',
      threadId,
      surfaceId: surface.id,
      returnHandle: {
        host: { owner: 'chat-container', key: threadId },
        workbench: { owner: 'f307-experience-workbench', key: surface.id },
        chatReadingRef: null,
        client: surface.ownerStateRef,
      },
    });
    session = useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session;
  }
  if (session?.threadId !== threadId || session.surfaceId !== surface.id) return;
  useF307ExperienceWorkbenchStore.getState().dispatchArtifactWorkPresentation({
    type: 'enter-full-window',
    initiator: 'user',
    generation: session.generation,
    threadId: session.threadId,
    surfaceId: session.surfaceId,
  });
}
