import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientSnapshot, InviteResult, PairingIntentResult } from './client-types.js';
import { phaseForHuman } from './human-auth-flow.js';
import { collectiveClientNamespace } from './human-send-custody.js';
import { readMembershipLeaveReadiness } from './leave-readiness.js';
import {
  announcePairingAvailability,
  resolvePairingAuthority,
  respondToPairingRequest,
  trustedPairingHostRequest,
} from './pairing-bridge.js';
import { useCollectiveArtifacts } from './use-collective-artifacts.js';
import { useCollectiveCollaboration } from './use-collective-collaboration.js';
import { useCollectiveRefresh } from './use-collective-refresh.js';
import { useCollectiveSend } from './use-collective-send.js';
import { CollectiveClientRequestError, useHumanAuthSession } from './use-human-auth-session.js';

const initialSnapshot: ClientSnapshot = {
  phase: 'loading',
  events: [],
  providers: [],
  connection: 'online',
  delivery: { kind: 'idle' },
};

export function useCollectiveClient() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot>(initialSnapshot);
  const activeCollectiveId = snapshot.collective?.collectiveId;
  const activeCollectiveName = snapshot.collective?.name;
  const activeCollectiveRole = snapshot.collective?.role;
  const currentNamespace = useRef<string>();
  currentNamespace.current = collectiveClientNamespace(snapshot);
  const { token, request, loadMe, invitationMode, bootstrap, authenticate, configureProvider } = useHumanAuthSession(
    snapshot,
    setSnapshot,
  );
  const { refreshEvents, recheckScope, cancelRefresh } = useCollectiveRefresh(
    snapshot,
    setSnapshot,
    request,
    loadMe,
    token,
  );

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
      url.searchParams.delete('channelId');
      history.replaceState(null, '', url);
      setSnapshot((current) => ({
        ...current,
        phase: phaseForHuman(me),
        me,
        collective,
        restrictedScope: undefined,
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

  const readLeaveReadiness = useCallback(async () => {
    if (!activeCollectiveId) throw new Error('当前没有可检查的共同体');
    return readMembershipLeaveReadiness(request, activeCollectiveId);
  }, [activeCollectiveId, request]);

  const leaveCollective = useCallback(async () => {
    if (!activeCollectiveId || activeCollectiveRole !== 'member') return;
    await request('/api/memberships/self-leave', {
      method: 'POST',
      body: JSON.stringify({ collectiveId: activeCollectiveId }),
    });
    await recheckScope();
    setSnapshot((current) => ({
      ...current,
      notice: `已离开${activeCollectiveName ?? '共同体'}；公开历史和署名仍会保留。`,
    }));
  }, [activeCollectiveId, activeCollectiveName, activeCollectiveRole, recheckScope, request]);

  const selectCollective = useCallback(
    (collectiveId: string) => {
      const collective = snapshot.me?.collectives.find((item) => item.collectiveId === collectiveId);
      if (!collective) return;
      if (snapshot.collective?.collectiveId === collectiveId) return;
      cancelRefresh();
      currentNamespace.current = collectiveClientNamespace({ ...snapshot, collective });
      const url = new URL(location.href);
      url.searchParams.set('collectiveId', collectiveId);
      url.searchParams.delete('channelId');
      history.replaceState(null, '', url);
      setSnapshot((current) => ({
        ...current,
        collective,
        restrictedScope: undefined,
        events: [],
        collaboration: undefined,
        participants: undefined,
        members: undefined,
        error: undefined,
        delivery: { kind: 'idle' },
      }));
    },
    [snapshot, cancelRefresh],
  );

  const pairHost = useCallback(async () => {
    const hostOrigin = new URLSearchParams(location.search).get('hostOrigin');
    if (!hostOrigin || window.parent === window) return;
    const authority = resolvePairingAuthority({
      phase: snapshot.restrictedScope ? 'unavailable' : snapshot.phase,
      hasSession: Boolean(snapshot.me),
      collective: snapshot.restrictedScope ? undefined : snapshot.collective,
    });
    const result = await respondToPairingRequest({
      ...authority,
      hostOrigin,
      serviceUrl: location.origin,
      createNonce: () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().slice(0, 8),
      requestIntent: async (input) => {
        try {
          return await request<PairingIntentResult>('/api/pairing-intents', {
            method: 'POST',
            body: JSON.stringify(input),
          });
        } catch (error) {
          if (!(error instanceof CollectiveClientRequestError) || error.status !== 401) throw error;
          try {
            await loadMe();
          } catch (verification) {
            if (verification instanceof CollectiveClientRequestError && verification.status === 401 && !token.current)
              throw verification;
          }
          throw new Error('暂时无法创建配对邀请');
        }
      },
      classifyError: (error) =>
        error instanceof CollectiveClientRequestError && error.status === 401 ? 'session_required' : 'pairing_failed',
      postToHost: (message, targetOrigin) => window.parent.postMessage(message, targetOrigin),
    });
    setSnapshot((current) =>
      result === 'paired'
        ? { ...current, notice: 'Clowder AI 正在安全托管连接凭据…', error: undefined }
        : { ...current, error: '暂时无法创建新的配对邀请' },
    );
  }, [loadMe, request, snapshot.collective, snapshot.me, snapshot.phase, snapshot.restrictedScope, token]);

  const announcePairingState = useCallback(() => {
    const hostOrigin = new URLSearchParams(location.search).get('hostOrigin');
    if (!hostOrigin || window.parent === window || snapshot.phase === 'loading') return;
    const authority = resolvePairingAuthority({
      phase: snapshot.restrictedScope ? 'unavailable' : snapshot.phase,
      hasSession: Boolean(snapshot.me),
      collective: snapshot.restrictedScope ? undefined : snapshot.collective,
    });
    announcePairingAvailability({
      ...authority,
      hostOrigin,
      serviceUrl: location.origin,
      postToHost: (message, targetOrigin) => window.parent.postMessage(message, targetOrigin),
    });
  }, [snapshot.collective, snapshot.me, snapshot.phase, snapshot.restrictedScope]);

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
  const artifacts = useCollectiveArtifacts(snapshot, request, refreshEvents);

  return {
    snapshot,
    artifacts,
    hostHumanSession: { request, refresh: refreshEvents },
    invitationMode,
    bootstrap,
    authenticate,
    configureProvider,
    createCollective,
    sendMessage,
    createInvite,
    readLeaveReadiness,
    leaveCollective,
    pairHost,
    selectCollective,
    ...collaboration,
  };
}
