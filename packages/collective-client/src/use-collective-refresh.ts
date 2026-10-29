import {
  collectiveChannelListSchema,
  collectiveCollaborationProjectionSchema,
  collectiveMemberDirectorySchema,
} from '@cat-cafe/shared';
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback, useEffect, useRef } from 'react';
import { type ClientRequest, CollectiveClientRequestError, collectiveClientErrorMessage } from './client-request.js';
import type { ClientSnapshot, CollectiveEventEnvelope, CollectiveMe, CollectiveParticipant } from './client-types.js';
import { closeCollectiveScope, currentCollectiveScope } from './collective-scope-recovery.js';
import { phaseForHuman } from './human-auth-flow.js';

async function readCollectiveProjection(
  request: ClientRequest,
  collectiveId: string,
  signal: AbortSignal,
  channelsSupported: boolean,
) {
  const query = `?collectiveId=${encodeURIComponent(collectiveId)}`;
  const [result, declared, members, collaboration, channels] = await Promise.all([
    request<{ events: readonly CollectiveEventEnvelope[] }>(`/api/events/human${query}`, { signal }),
    request<{ participants: readonly CollectiveParticipant[] }>(`/api/participants${query}`, { signal }),
    request<unknown>(`/api/members${query}`, { signal }).then((value) => collectiveMemberDirectorySchema.parse(value)),
    request<unknown>(`/api/collaboration${query}`, { signal }).then((value) =>
      collectiveCollaborationProjectionSchema.parse(value),
    ),
    channelsSupported
      ? request<unknown>(`/api/channels${query}`, { signal }).then(
          (value) => collectiveChannelListSchema.parse(value).channels,
        )
      : Promise.resolve(undefined),
  ]);
  return {
    events: result.events,
    participants: declared.participants,
    members,
    collaboration,
    ...(channels ? { channels } : {}),
  };
}

async function reconcileDeniedScope(
  loadMe: () => Promise<CollectiveMe>,
  collectiveId: string,
  close: (reason: 'checking' | 'membership_lost' | 'unavailable', me?: CollectiveMe) => void,
) {
  close('checking');
  try {
    const me = await loadMe();
    close(me.collectives.some((item) => item.collectiveId === collectiveId) ? 'unavailable' : 'membership_lost', me);
  } catch {
    // loadMe alone may retire a credential on its authoritative 401. Other failures keep the credential.
    close('unavailable');
  }
}

export function useCollectiveRefresh(
  snapshot: ClientSnapshot,
  setSnapshot: Dispatch<SetStateAction<ClientSnapshot>>,
  request: ClientRequest,
  loadMe: () => Promise<CollectiveMe>,
  token: MutableRefObject<string | null>,
) {
  const scope = currentCollectiveScope(snapshot);
  const key = scope && `${scope.serviceInstanceId}:${scope.collectiveId}:${scope.humanId}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const generation = useRef(0);
  const pending = useRef<AbortController>();
  const cancelRefresh = useCallback(() => {
    ++generation.current;
    pending.current?.abort();
  }, []);
  const run = useCallback(
    async (verifyMembership = false) => {
      const target = currentCollectiveScope(latest.current);
      if (!target || !token.current) return;
      const credential = token.current;
      const revision = ++generation.current;
      pending.current?.abort();
      const abort = new AbortController();
      pending.current = abort;
      const fresh = () =>
        !abort.signal.aborted &&
        revision === generation.current &&
        key === currentKey.current &&
        credential === token.current;
      const close = (reason: 'checking' | 'membership_lost' | 'unavailable', me?: CollectiveMe) => {
        if (fresh()) setSnapshot((current) => closeCollectiveScope(current, target, reason, me ?? current.me));
      };
      try {
        let me: CollectiveMe | undefined;
        if (verifyMembership || latest.current.restrictedScope) {
          close('checking');
          me = await loadMe();
          if (!fresh()) return;
          if (!me.collectives.some((item) => item.collectiveId === target.collectiveId))
            return close('membership_lost', me);
        }
        const projection = await readCollectiveProjection(
          request,
          target.collectiveId,
          abort.signal,
          latest.current.meta?.capabilities?.channels === 1,
        );
        if (!fresh()) return;
        setSnapshot((current) => ({
          ...current,
          ...(me
            ? {
                me,
                collective: me.collectives.find((item) => item.collectiveId === target.collectiveId),
                phase: phaseForHuman(me),
              }
            : {}),
          restrictedScope: undefined,
          ...projection,
          connection: 'online',
          error: undefined,
        }));
      } catch (error) {
        if (!fresh()) return;
        if (error instanceof CollectiveClientRequestError && (error.status === 401 || error.status === 403)) {
          await reconcileDeniedScope(loadMe, target.collectiveId, close);
        } else {
          setSnapshot((current) => ({
            ...current,
            ...(current.restrictedScope ? { restrictedScope: { ...target, reason: 'unavailable' as const } } : {}),
            connection: 'offline',
            error: collectiveClientErrorMessage(error),
          }));
        }
      }
    },
    [key, loadMe, request, setSnapshot, token],
  );

  useEffect(() => {
    if (snapshot.phase !== 'ready' || !key) return;
    if (!latest.current.restrictedScope) void run();
    const interval = window.setInterval(() => {
      if (!latest.current.restrictedScope) void run();
    }, 1800);
    return () => {
      window.clearInterval(interval);
      cancelRefresh();
    };
  }, [cancelRefresh, key, run, snapshot.phase]);
  return {
    refreshEvents: useCallback(() => run(), [run]),
    recheckScope: useCallback(() => run(true), [run]),
    cancelRefresh,
  };
}
