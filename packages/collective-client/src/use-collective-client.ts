import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClientSnapshot,
  ClientTarget,
  CollectiveEventEnvelope,
  CollectiveParticipant,
  InviteResult,
  PairingIntentResult,
} from './client-types.js';
import { phaseForHuman } from './human-auth-flow.js';
import { acknowledgeHumanSend, collectiveClientNamespace, prepareHumanSend } from './human-send-custody.js';
import {
  announcePairingAvailability,
  resolvePairingAuthority,
  respondToPairingRequest,
  trustedPairingHostRequest,
} from './pairing-bridge.js';
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
  const sending = useRef<{ fingerprint: string; promise: Promise<void> }>();
  const { token, request, loadMe, invitationMode, bootstrap, authenticate, configureProvider } = useHumanAuthSession(
    snapshot,
    setSnapshot,
  );

  const refreshEvents = useCallback(async () => {
    const collective = snapshot.collective;
    if (!collective || !token.current) return;
    const namespace = collectiveClientNamespace(snapshot);
    const generation = ++refreshGeneration.current;
    refreshAbort.current?.abort();
    const abort = new AbortController();
    refreshAbort.current = abort;
    try {
      const [result, declared] = await Promise.all([
        request<{ readonly events: readonly CollectiveEventEnvelope[] }>(
          `/api/events/human?collectiveId=${encodeURIComponent(collective.collectiveId)}`,
          { signal: abort.signal },
        ),
        request<{ readonly participants: readonly CollectiveParticipant[] }>(
          `/api/participants?collectiveId=${encodeURIComponent(collective.collectiveId)}`,
          { signal: abort.signal },
        ),
      ]);
      if (abort.signal.aborted || namespace !== currentNamespace.current || generation !== refreshGeneration.current)
        return;
      setSnapshot((current) => ({
        ...current,
        events: result.events,
        participants: declared.participants,
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
  }, [request, snapshot.collective, snapshot.meta, snapshot.me, token]);

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
      }));
    },
    [loadMe, request],
  );

  const sendMessage = useCallback(
    (body: string, destination: ClientTarget) => {
      const { collective, meta } = snapshot;
      const namespace = collectiveClientNamespace(snapshot);
      if (!collective || !meta || !namespace) return Promise.reject(new Error('请先登录并选择 Collective'));
      const fingerprint = JSON.stringify([namespace, body, destination]);
      if (sending.current)
        return sending.current.fingerprint === fingerprint
          ? sending.current.promise
          : Promise.reject(new Error('上一条消息仍在送达，请稍后再发。'));
      const operation = prepareHumanSend(localStorage, namespace, {
        serviceInstanceId: meta.serviceInstanceId,
        collectiveId: collective.collectiveId,
        ...(destination.target ? { target: destination.target } : {}),
        ...(destination.location ? { location: destination.location } : {}),
        ...(destination.recipient ? { recipient: destination.recipient } : {}),
        ...(destination.replyToEventId ? { replyToEventId: destination.replyToEventId } : {}),
        ...(destination.workRequest ? { workRequest: destination.workRequest } : {}),
        body,
      });
      const send = async () => {
        setSnapshot((current) => ({
          ...current,
          delivery: { kind: 'requesting', label: '正在送往共同现场…' },
        }));
        try {
          await request('/api/events/human', {
            method: 'POST',
            body: JSON.stringify(operation),
          });
          acknowledgeHumanSend(localStorage, namespace, operation.clientEventId);
          if (namespace !== currentNamespace.current) return;
          setSnapshot((current) => ({
            ...current,
            delivery: {
              kind: 'accepted',
              label: '已进入共同现场；这不代表某只猫已经接住',
            },
          }));
          await refreshEvents();
        } catch (error) {
          if (namespace !== currentNamespace.current) throw error;
          setSnapshot((current) => ({
            ...current,
            delivery: { kind: 'failed', label: '尚未确认送达，可以重试' },
            error: collectiveClientErrorMessage(error),
          }));
          throw error;
        }
      };
      const promise = send().finally(() => {
        sending.current = undefined;
      });
      sending.current = { fingerprint, promise };
      return promise;
    },
    [refreshEvents, request, snapshot],
  );

  const createInvite = useCallback(async () => {
    if (!snapshot.collective) return;
    const result = await request<InviteResult>('/api/invites', {
      method: 'POST',
      body: JSON.stringify({ collectiveId: snapshot.collective.collectiveId }),
    });
    const inviteUrl = `${location.origin}/#invite=${encodeURIComponent(result.inviteToken)}`;
    setSnapshot((current) => ({ ...current, notice: inviteUrl }));
  }, [request, snapshot.collective]);

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
        participants: [],
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

  return {
    snapshot,
    invitationMode,
    bootstrap,
    authenticate,
    configureProvider,
    createCollective,
    sendMessage,
    createInvite,
    pairHost,
    selectCollective,
  };
}
