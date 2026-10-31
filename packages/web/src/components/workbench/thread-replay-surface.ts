import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

export const THREAD_REPLAY_OWNER = 'f252-thread-replay';

function threadIdentity(value: string): boolean {
  return value.trim().length > 0 && value.length <= 2048 && !value.includes('\0');
}

/** F252 owns playback; the descriptor carries only the exact conversation identity. */
export function createThreadReplaySurface(
  threadId: string,
  title = '线程回放',
  contextLabel: string | null = '',
): WorkspaceSurfaceDescriptor | null {
  if (!threadIdentity(threadId)) return null;
  return {
    id: `thread-replay:${encodeURIComponent(threadId)}`,
    type: 'thread-replay',
    renderer: 'thread-replay',
    title,
    context: contextLabel?.trim() ?? '',
    objectRef: { kind: 'thread-replay', id: threadId },
    ownerStateRef: { owner: THREAD_REPLAY_OWNER, key: threadId },
    resultTargetRef: { owner: THREAD_REPLAY_OWNER, key: threadId },
    capabilities: { split: true, sidecar: true, pin: true, closePolicy: 'detach-host', restorePolicy: 'descriptor' },
  };
}

/** Consistent references identify the owner; they never authorize message access. */
export function resolveThreadReplayThreadId(surface: WorkspaceSurfaceDescriptor): string | null {
  const threadId = surface.objectRef.id;
  return surface.type === 'thread-replay' &&
    surface.renderer === 'thread-replay' &&
    surface.objectRef.kind === 'thread-replay' &&
    threadIdentity(threadId) &&
    surface.id === `thread-replay:${encodeURIComponent(threadId)}` &&
    surface.ownerStateRef.owner === THREAD_REPLAY_OWNER &&
    surface.ownerStateRef.key === threadId &&
    surface.resultTargetRef?.owner === THREAD_REPLAY_OWNER &&
    surface.resultTargetRef.key === threadId
    ? threadId
    : null;
}
