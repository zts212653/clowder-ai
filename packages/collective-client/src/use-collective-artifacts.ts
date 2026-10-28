import type { CollectiveModificationProjection } from '@cat-cafe/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { type ClientRequest, CollectiveClientRequestError, collectiveClientErrorMessage } from './client-request.js';
import type { ClientSnapshot } from './client-types.js';
import {
  collectiveArtifactClient,
  type SharedArtifact,
  type SharedArtifactOpenOptions,
} from './collective-artifact-client.js';
import { collectiveClientNamespace } from './human-send-custody.js';
import { participantRecipient } from './participant-identity.js';
import type { CollectiveWorkResultFileAddress } from './work-result-file-link.js';

export function useCollectiveArtifacts(
  snapshot: ClientSnapshot,
  request: ClientRequest,
  refreshDiscussion?: () => Promise<void>,
) {
  const namespace = collectiveClientNamespace(snapshot);
  const currentNamespace = useRef(namespace);
  currentNamespace.current = namespace;
  const serviceInstanceId = snapshot.meta?.serviceInstanceId;
  const collectiveId = snapshot.collective?.collectiveId;
  const api = useMemo(
    () =>
      namespace && serviceInstanceId && collectiveId
        ? collectiveArtifactClient(request, { serviceInstanceId, collectiveId }, namespace)
        : undefined,
    [namespace, serviceInstanceId, collectiveId, request],
  );
  const [catalogue, setCatalogue] = useState<SharedArtifact[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'access_denied'>('loading');
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<{
    artifactId: string;
    ownerRevision?: number;
    options?: SharedArtifactOpenOptions;
    requestId?: string;
    request?: CollectiveModificationProjection;
  }>();
  const [publicationSource, setPublicationSource] = useState<string>();
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!api || namespace !== currentNamespace.current) return;
    const current = ++generation.current;
    try {
      const result = await api.list();
      if (current !== generation.current || namespace !== currentNamespace.current) return;
      setCatalogue(result);
      setStatus('ready');
      setError(undefined);
    } catch (failure) {
      if (current !== generation.current || namespace !== currentNamespace.current) return;
      setCatalogue([]);
      setStatus(
        failure instanceof CollectiveClientRequestError && failure.status === 403 ? 'access_denied' : 'unavailable',
      );
      setError(collectiveClientErrorMessage(failure));
    }
  }, [api, namespace]);
  useEffect(() => {
    setCatalogue([]);
    setSelected(undefined);
    setPublicationSource(undefined);
    setStatus('loading');
    if (!api || snapshot.phase !== 'ready') return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1800);
    return () => {
      ++generation.current;
      window.clearInterval(interval);
    };
  }, [api, refresh, snapshot.phase]);
  const open = useCallback(
    (artifact: SharedArtifact, ownerRevision?: number, options?: SharedArtifactOpenOptions) =>
      setSelected({
        artifactId: artifact.artifactId,
        ...(ownerRevision ? { ownerRevision } : {}),
        ...(options ? { options } : {}),
      }),
    [],
  );
  const close = useCallback(() => setSelected(undefined), []);
  const compare = useCallback(
    (requestId?: string, request?: CollectiveModificationProjection) =>
      setSelected((current) => (current ? { ...current, requestId, request } : current)),
    [],
  );
  const beginPublication = useCallback((eventId: string) => setPublicationSource(eventId), []);
  const closePublication = useCallback(() => setPublicationSource(undefined), []);
  const resolveWorkResultFile = useCallback(
    async (address: CollectiveWorkResultFileAddress) => {
      if (!api || namespace !== currentNamespace.current) throw new Error('作品服务当前不可用。');
      const artifact = await api.openWorkResult(address.fileId);
      if (namespace !== currentNamespace.current) throw new Error('共同体已经切换，请从当前页面重新打开结果。');
      setCatalogue((current) => [artifact, ...current.filter((item) => item.artifactId !== artifact.artifactId)]);
      setStatus('ready');
      setError(undefined);
      return artifact;
    },
    [api, namespace],
  );
  return {
    api,
    catalogue,
    status,
    error,
    selected,
    publicationSource,
    refresh,
    open,
    close,
    compare,
    beginPublication,
    closePublication,
    resolveWorkResultFile,
    refreshDiscussion,
    humanId: snapshot.me?.human.humanId,
    members: snapshot.members,
    reworkRecipient: (target: { humanId: string; catId: string }, channelId: string, requestEventId: string) => {
      const original = snapshot.events.find((event) => event.eventId === requestEventId)?.recipient;
      if (original?.kind !== 'agent' || original.humanId !== target.humanId || original.agentId !== target.catId)
        return undefined;
      const participant = snapshot.participants?.find(
        (item) =>
          item.humanId === target.humanId &&
          item.catId === target.catId &&
          item.connectionId === original.connectionId &&
          item.availability === 'declared' &&
          item.channelIds.includes(channelId),
      );
      return participant ? { recipient: participantRecipient(participant), label: participant.displayName } : undefined;
    },
    humanName: (humanId: string) => {
      const current = snapshot.members?.humans.find((human) => human.humanId === humanId);
      if (current) return current.displayName;
      const historical = snapshot.events.find(
        (event) => event.actor.kind === 'human' && event.actor.humanId === humanId,
      );
      return historical?.actor.kind === 'human' ? historical.actor.displayName : '共同体成员';
    },
    catName: (humanId: string, catId: string) =>
      snapshot.participants?.find((participant) => participant.humanId === humanId && participant.catId === catId)
        ?.displayName ?? catId,
    sourceMessage: (eventId: string) => snapshot.events.find((event) => event.eventId === eventId),
  };
}
export type CollectiveArtifactState = ReturnType<typeof useCollectiveArtifacts> & {
  documentHosted?: boolean;
  returnToSource?: (channelId: string, eventId: string) => void;
  returnLabel?: string;
  openWorkResultFile?: (address: CollectiveWorkResultFileAddress) => Promise<void>;
};
export const CollectiveArtifactContext = createContext<CollectiveArtifactState | undefined>(undefined);
export const useSharedArtifacts = () => useContext(CollectiveArtifactContext);
