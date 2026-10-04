import { collectiveCollaborationProjectionSchema, collectiveMemberDirectorySchema } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClientSnapshot,
  CollectiveEventEnvelope,
  CollectiveParticipant,
  InviteResult,
  PairingIntentResult,
} from './client-types.js';
import { phaseForHuman } from './human-auth-flow.js';
import { collectiveClientNamespace } from './human-send-custody.js';
import {
  announcePairingAvailability,
  resolvePairingAuthority,
  respondToPairingRequest,
  trustedPairingHostRequest,
} from './pairing-bridge.js';
import { useCollectiveCollaboration } from './use-collective-collaboration.js';
import { useCollectiveSend } from './use-collective-send.js';
import {
  CollectiveClientRequestError,
  collectiveClientErrorMessage,
  SESSION_KEY,
  useHumanAuthSession,
} from './use-human-auth-session.js';

const POLL_INTERVAL_MS = 1_800;

const initialSnapshot: ClientSnapshot = {
  phase: 'loading',
  events: [],
  providers: [],
  connection: 'online',
  delivery: { kind: 'idle' },
};

export function useCollectiveClient() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot>(initialSnapshot);
  const currentNamespace = useRef<string>();
  currentNamespace.current = collectiveClientNamespace(snapshot);
  const refreshGeneration = useRef(0);
  const refreshAbort = useRef<AbortController>();
  const { token, request, loadMe, invitationMode, bootstrap, authenticate, configureProvider } = useHumanAuthSession(
    snapshot,
    setSnapshot,
  );
  const refreshCollective = snapshot.collective;
  const refreshNamespace = collectiveClientNamespace({
    collective: snapshot.collective,
    me: snapshot.me,
    meta: snapshot.meta,
  });

  const refreshEvents = useCallback(async () => {
    const collective = refreshCollective;
    if (!collective || !token.current) return;
    const namespace = refreshNamespace;
    const generation = ++refreshGeneration.current;
    refreshAbort.current?.abort();
    const abort = new AbortController();
    refreshAbort.current = abort;
    try {
      const [result, declared, directory, collaboration] = await Promise.all([
        request<{ readonly events: readonly CollectiveEventEnvelope[] }>(
          `/api/events/human?collectiveId=${encodeURIComponent(collective.collectiveId)}`,
          { signal: abort.signal },
        ),
        request<{ readonly participants: readonly CollectiveParticipant[] }>(
          `/api/participants?collectiveId=${encodeURIComponent(collective.collectiveId)}`,
          { signal: abort.signal },
        ),
        request<unknown>(`/api/members?collectiveId=${encodeURIComponent(collective.collectiveId)}`, {
          signal: abort.signal,
        }).then((value) => collectiveMemberDirectorySchema.parse(value)),
        request<unknown>(`/api/collaboration?collectiveId=${encodeURIComponent(collective.collectiveId)}`, {
          signal: abort.signal,
        }).then((value) => collectiveCollaborationProjectionSchema.parse(value)),
      ]);
      if (abort.signal.aborted || namespace !== currentNamespace.current || generation !== refreshGeneration.current)
        return;
      setSnapshot((current) => ({
        ...current,
        events: result.events,
        participants: declared.participants,
        members: directory,
        collaboration,
        connection: 'online',
        error: undefined,
      }));
    } catch (error) {
      if (abort.signal.aborted || namespace !== currentNamespace.current || generation !== refreshGeneration.current)
        return;
      setSnapshot((current) => ({
        ...current,
        connection: 'offline',
        error: collectiveClientErrorMessage(error),
      }));
    }
  }, [refreshCollective, refreshNamespace, request, token]);

  useEffect(() => {
    if (snapshot.phase !== 'ready') return;
    void refreshEvents();
    const interval = window.setInterval(() => void refreshEvents(), POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      refreshAbort.current?.abort();
    };
  }, [refreshEvents, snapshot.phase]);

  const createCollective = useCallback(
    async (name: string) => {
      const created = await request<{ collectiveId: string }>('/api/collectives', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      const me = await loadMe();
      const collective = me.collectives.find((item) => item.collectiveId === created.collectiveId);
      if (!collective) throw new Error('新建的 Collective 暂不可用');
      const url = new URL(location.href);
      url.searchParams.set('collectiveId', created.collectiveId);
      history.replaceState(null, '', url);
      setSnapshot((current) => ({
        ...current,
        phase: phaseForHuman(me),
        me,
        collective,
        events: [],
        collaboration: undefined,
        participants: undefined,
        members: undefined,
      }));
    },
    [loadMe, request],
  );

  const sendMessage = useCollectiveSend({ snapshot, setSnapshot, currentNamespace, request, refresh: refreshEvents });

  const createInvite = useCallback(async () => {
    if (!snapshot.collective) return;
    const result = await request<InviteResult>('/api/invites', {
      method: 'POST',
      body: JSON.stringify({ collectiveId: snapshot.collective.collectiveId }),
    });
    const inviteUrl = `${location.origin}/#invite=${encodeURIComponent(result.inviteToken)}`;
    setSnapshot((current) => ({ ...current, notice: inviteUrl }));
  }, [request, snapshot.collective]);

  const leaveCollective = useCallback(async () => {
    const collective = snapshot.collective;
    if (!collective || collective.role !== 'member') return;
    if (!window.confirm('退出后，你的 Café 会立即停止读取和发送；公开历史与署名会保留。确认退出？')) return;
    try {
      await request('/api/memberships/self-leave', {
        method: 'POST',
        body: JSON.stringify({ collectiveId: collective.collectiveId }),
      });
      const me = await loadMe();
      const nextCollective = me.collectives[0];
      ++refreshGeneration.current;
      refreshAbort.current?.abort();
      const url = new URL(location.href);
      if (nextCollective) url.searchParams.set('collectiveId', nextCollective.collectiveId);
      else url.searchParams.delete('collectiveId');
      history.replaceState(null, '', url);
      setSnapshot((current) => ({
        ...current,
        phase: phaseForHuman(me),
        me,
        collective: nextCollective,
        events: [],
        collaboration: undefined,
        participants: undefined,
        members: undefined,
        delivery: { kind: 'idle' },
        connection: 'online',
        notice: '已退出共同家园；公开历史与署名仍会保留。',
        error: undefined,
      }));
    } catch (error) {
      setSnapshot((current) => ({ ...current, error: collectiveClientErrorMessage(error) }));
    }
  }, [loadMe, request, snapshot.collective]);

  const selectCollective = useCallback(
    (collectiveId: string) => {
      const collective = snapshot.me?.collectives.find((item) => item.collectiveId === collectiveId);
      if (!collective) return;
      ++refreshGeneration.current;
      refreshAbort.current?.abort();
      currentNamespace.current = collectiveClientNamespace({ ...snapshot, collective });
      const url = new URL(location.href);
      url.searchParams.set('collectiveId', collectiveId);
      history.replaceState(null, '', url);
      setSnapshot((current) => ({
        ...current,
        collective,
        events: [],
        collaboration: undefined,
        participants: undefined,
        members: undefined,
        error: undefined,
        delivery: { kind: 'idle' },
      }));
    },
    [snapshot],
  );

  const pairHost = useCallback(async () => {
    const hostOrigin = new URLSearchParams(location.search).get('hostOrigin');
    if (!hostOrigin || window.parent === window) return;
    const authority = resolvePairingAuthority({
      phase: snapshot.phase,
      hasSession: Boolean(snapshot.me),
      collective: snapshot.collective,
    });
    const result = await respondToPairingRequest({
      ...authority,
      hostOrigin,
      serviceUrl: location.origin,
      createNonce: () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().slice(0, 8),
      requestIntent: (input) =>
        request<PairingIntentResult>('/api/pairing-intents', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      classifyError: (error) =>
        error instanceof CollectiveClientRequestError && error.status === 401 ? 'session_required' : 'pairing_failed',
      postToHost: (message, targetOrigin) => window.parent.postMessage(message, targetOrigin),
    });
    if (result === 'session_required') {
      token.current = null;
      sessionStorage.removeItem(`${SESSION_KEY}:${location.origin}`);
      setSnapshot((current) => ({
        ...current,
        phase: 'entry',
        me: undefined,
        collective: undefined,
        events: [],
        collaboration: undefined,
        participants: undefined,
        members: undefined,
        error: 'Collective 会话已失效，请重新登录',
      }));
      return;
    }
    setSnapshot((current) =>
      result === 'paired'
        ? { ...current, notice: 'Clowder AI 正在安全托管连接凭据…', error: undefined }
        : { ...current, error: '暂时无法创建新的配对邀请' },
    );
  }, [request, snapshot.collective, snapshot.me, snapshot.phase, token]);

  const announcePairingState = useCallback(() => {
    const hostOrigin = new URLSearchParams(location.search).get('hostOrigin');
    if (!hostOrigin || window.parent === window || snapshot.phase === 'loading') return;
    const authority = resolvePairingAuthority({
      phase: snapshot.phase,
      hasSession: Boolean(snapshot.me),
      collective: snapshot.collective,
    });
    announcePairingAvailability({
      ...authority,
      hostOrigin,
      serviceUrl: location.origin,
      postToHost: (message, targetOrigin) => window.parent.postMessage(message, targetOrigin),
    });
  }, [snapshot.collective, snapshot.me, snapshot.phase]);

  useEffect(() => announcePairingState(), [announcePairingState]);

  useEffect(() => {
    const hostOrigin = new URLSearchParams(location.search).get('hostOrigin');
    if (!hostOrigin || window.parent === window) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      const hostRequest = trustedPairingHostRequest(event, hostOrigin, window.parent);
      if (hostRequest?.type === 'collective:request-pairing') void pairHost();
      if (hostRequest?.type === 'collective:request-pairing-status') announcePairingState();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [announcePairingState, pairHost]);

  const collaboration = useCollectiveCollaboration({
    snapshot,
    setSnapshot,
    currentNamespace,
    request,
    refresh: refreshEvents,
  });

  return {
    snapshot,
    hostHumanSession: { request, refresh: refreshEvents },
    invitationMode,
    bootstrap,
    authenticate,
    configureProvider,
    createCollective,
    sendMessage,
    createInvite,
    leaveCollective,
    pairHost,
    selectCollective,
    ...collaboration,
  };
}
