import type {
  CollectiveClientWorldDirectory,
  CollectiveHostWorldDirectoryInit,
  CollectiveHostWorldSelection,
} from '@cat-cafe/shared';
import { collectiveHostWorldDirectoryInitSchema, collectiveHostWorldSelectionSchema } from '@cat-cafe/shared';

import type { ClientSnapshot } from './client-types.js';

export type ReadyWorldDirectory = Extract<CollectiveClientWorldDirectory, { state: 'ready' }>;

export function projectWorldDirectory(
  snapshot: Pick<ClientSnapshot, 'phase' | 'meta' | 'me' | 'collective' | 'connection'>,
  bridgeId: string,
  revision: number,
): CollectiveClientWorldDirectory | undefined {
  const base = {
    type: 'collective:client-world-directory' as const,
    bridgeId,
    revision,
  };
  if (snapshot.phase === 'loading') return undefined;
  if (snapshot.phase === 'unavailable') {
    return {
      ...base,
      state: 'unavailable',
      code: 'client_unavailable',
      ...(snapshot.meta ? { serviceInstanceId: snapshot.meta.serviceInstanceId } : {}),
    };
  }
  if (!snapshot.meta) return { ...base, state: 'unavailable', code: 'service_unavailable' };
  if (snapshot.connection === 'offline') {
    return {
      ...base,
      state: 'unavailable',
      code: 'service_unavailable',
      serviceInstanceId: snapshot.meta.serviceInstanceId,
    };
  }
  if (!snapshot.me) {
    return {
      ...base,
      state: 'session_required',
      serviceInstanceId: snapshot.meta.serviceInstanceId,
    };
  }
  return {
    ...base,
    state: 'ready',
    serviceInstanceId: snapshot.meta.serviceInstanceId,
    humanId: snapshot.me.human.humanId,
    ...(snapshot.collective ? { currentCollectiveId: snapshot.collective.collectiveId } : {}),
    memberships: snapshot.me.collectives.map(({ collectiveId, name, role }) => ({ collectiveId, name, role })),
  };
}

export function worldSelectionMatches(
  selection: CollectiveHostWorldSelection,
  directory: ReadyWorldDirectory,
): boolean {
  return (
    selection.bridgeId === directory.bridgeId &&
    selection.directoryRevision === directory.revision &&
    selection.serviceInstanceId === directory.serviceInstanceId &&
    selection.humanId === directory.humanId &&
    directory.memberships.some((membership) => membership.collectiveId === selection.collectiveId)
  );
}

export function trustedWorldDirectoryHostMessage(
  event: { readonly origin: string; readonly source: unknown; readonly data: unknown },
  hostOrigin: string,
  parent: unknown,
): CollectiveHostWorldDirectoryInit | CollectiveHostWorldSelection | undefined {
  if (event.origin !== hostOrigin || event.source !== parent) return undefined;
  const init = collectiveHostWorldDirectoryInitSchema.safeParse(event.data);
  if (init.success) return init.data;
  const selection = collectiveHostWorldSelectionSchema.safeParse(event.data);
  return selection.success ? selection.data : undefined;
}
