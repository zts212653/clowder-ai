import { useCallback, useEffect, useState } from 'react';

import type {
  ClientSnapshot,
  ClientTarget,
  CollectiveEventEnvelope,
  InviteResult,
  PairingIntentResult,
} from './client-types.js';
import { phaseForHuman } from './human-auth-flow.js';
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
  const { token, request, loadMe, invitationMode, bootstrap, authenticate } = useHumanAuthSession(
    snapshot,
    setSnapshot,
  );

  const refreshEvents = useCallback(async () => {
    const collective = snapshot.collective;
    if (!collective || !token.current) return;
    try {
      const result = await request<{ readonly events: readonly CollectiveEventEnvelope[] }>(
        `/api/events/human?collectiveId=${encodeURIComponent(collective.collectiveId)}`,
      );
      setSnapshot((current) => ({
        ...current,
        events: result.events,
        connection: 'online',
        error: undefined,
      }));
    } catch (error) {
      setSnapshot((current) => ({
        ...current,
        connection: 'offline',
        error: collectiveClientErrorMessage(error),
      }));
    }
  }, [request, snapshot.collective, token]);

  useEffect(() => {
    if (snapshot.phase !== 'ready') return;
    void refreshEvents();
    const interval = window.setInterval(() => void refreshEvents(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshEvents, snapshot.phase]);

  const createCollective = useCallback(
    async (name: string) => {
      await request('/api/collectives', { method: 'POST', body: JSON.stringify({ name }) });
      const me = await loadMe();
      setSnapshot((current) => ({
        ...current,
        phase: phaseForHuman(me),
        me,
        collective: me.collectives[0],
      }));
    },
    [loadMe, request],
  );

  const sendMessage = useCallback(
    async (body: string, destination: ClientTarget) => {
      const { collective, meta } = snapshot;
      if (!collective || !meta) return;
      setSnapshot((current) => ({
        ...current,
        delivery: { kind: 'requesting', label: '正在送往共同现场…' },
      }));
      try {
        await request('/api/events/human', {
          method: 'POST',
          body: JSON.stringify({
            serviceInstanceId: meta.serviceInstanceId,
            collectiveId: collective.collectiveId,
            clientEventId: crypto.randomUUID(),
            target: destination.target,
            ...(destination.replyToEventId ? { replyToEventId: destination.replyToEventId } : {}),
            body,
          }),
        });
        setSnapshot((current) => ({
          ...current,
          delivery: {
            kind: 'accepted',
            label: '已进入共同现场；这不代表某只猫已经接住',
          },
        }));
        await refreshEvents();
      } catch (error) {
        setSnapshot((current) => ({
          ...current,
          delivery: { kind: 'failed', label: '尚未送达，可以重试' },
          error: collectiveClientErrorMessage(error),
        }));
        throw error;
      }
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
    createCollective,
    sendMessage,
    createInvite,
    pairHost,
  };
}
