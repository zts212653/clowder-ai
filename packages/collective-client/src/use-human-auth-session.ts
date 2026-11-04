import { collectiveIdSchema } from '@cat-cafe/shared';
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  type ClientReadPolicy,
  CollectiveClientRequestError,
  collectiveClientErrorMessage,
  fetchClientJson,
} from './client-request.js';
import type { ClientSnapshot, CollectiveMe, HumanAuthBeginResult, SessionResult } from './client-types.js';
import { closeCollectiveScope, currentCollectiveScope, missingMembershipScope } from './collective-scope-recovery.js';
import { initializeHumanSession, selectedCollective } from './human-auth-boot.js';
import {
  entryModeFromHash,
  HUMAN_AUTH_WINDOW_NAME,
  humanAuthErrorMessage,
  phaseForHuman,
  trustedHumanAuthResult,
} from './human-auth-flow.js';
import { useProviderSetup } from './use-provider-setup.js';

export const SESSION_KEY = 'collective-session';

type EntryMode = ReturnType<typeof entryModeFromHash>;

function resolveHumanAuthIntent(phase: ClientSnapshot['phase'], invitationMode: EntryMode) {
  if (phase === 'bind-identity') return { intent: 'bind' as const };
  if (invitationMode !== 'invite') return { intent: 'login' as const };
  const inviteToken = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (!inviteToken) throw new Error('这个邀请链接不完整');
  return { intent: 'accept_invite' as const, inviteToken };
}

export function useHumanAuthSession(snapshot: ClientSnapshot, setSnapshot: Dispatch<SetStateAction<ClientSnapshot>>) {
  const token = useRef<string | null>(null);
  const authWindow = useRef<Window | null>(null);
  const sessionGeneration = useRef(0);

  // One browser-service request per instance; share the lane across effect replays and refreshes.
  const requestTail = useRef<Promise<void>>(Promise.resolve());
  const binaryRequest = useCallback(async (path: string, init?: RequestInit) => {
    if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Invalid Service path');
    const credential = token.current;
    const generation = sessionGeneration.current;
    if (!credential) throw new CollectiveClientRequestError(401, '请先登录');
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        ...init?.headers,
        authorization: `Bearer ${credential}`,
        'x-collective-message-content': '2',
      },
    });
    if (credential !== token.current || generation !== sessionGeneration.current) {
      await response.body?.cancel();
      throw new Error('身份已变化');
    }
    if (!response.ok) {
      const result = (await response.json()) as { error?: { code?: string; message?: string } };
      throw new CollectiveClientRequestError(
        response.status,
        result.error?.message ?? `请求失败（${response.status}）`,
        result.error?.code,
      );
    }
    return response;
  }, []);
  const request = useCallback(
    <Result>(path: string, init?: RequestInit, policy?: ClientReadPolicy): Promise<Result> => {
      const generation = sessionGeneration.current;
      const options: RequestInit = {
        ...init,
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-collective-message-content': '2',
          ...(token.current ? { authorization: `Bearer ${token.current}` } : {}),
          ...init?.headers,
        },
      };
      const result = requestTail.current.then(async () => {
        options.signal?.throwIfAborted();
        if (generation !== sessionGeneration.current) throw new Error('身份已变化');
        const { response, payload } = await fetchClientJson<Result>(path, options, policy);
        if (generation !== sessionGeneration.current) throw new Error('身份已变化');
        if (!response.ok) {
          throw new CollectiveClientRequestError(
            response.status,
            payload.error?.message ?? `请求失败（${response.status}）`,
            payload.error?.code,
          );
        }
        return payload;
      });
      // Settle the lane after either outcome, without retrying or hiding this request's failure.
      requestTail.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [],
  );

  const loadMe = useCallback(async () => {
    const credential = token.current;
    try {
      return await request<CollectiveMe>('/api/me');
    } catch (error) {
      if (error instanceof CollectiveClientRequestError && error.status === 401 && credential === token.current) {
        ++sessionGeneration.current;
        token.current = null;
        sessionStorage.removeItem(`${SESSION_KEY}:${location.origin}`);
        setSnapshot((current) => {
          const scope = currentCollectiveScope(current);
          const closed = scope ? closeCollectiveScope(current, scope, 'session_expired') : current;
          return {
            ...closed,
            phase: 'entry',
            me: undefined,
            collective: undefined,
            events: [],
            channels: undefined,
            collaboration: undefined,
            participants: undefined,
            members: undefined,
          };
        });
      }
      throw error;
    }
  }, [request, setSnapshot]);

  const enterSession = useCallback(
    async (sessionToken: string, collectiveId?: string) => {
      ++sessionGeneration.current;
      token.current = sessionToken;
      sessionStorage.setItem(`${SESSION_KEY}:${location.origin}`, sessionToken);
      const cleanUrl = new URL(location.href);
      cleanUrl.searchParams.delete('authCompleted');
      cleanUrl.searchParams.delete('authError');
      const parsedTarget = collectiveId !== undefined ? collectiveIdSchema.safeParse(collectiveId) : undefined;
      if (parsedTarget?.success) {
        cleanUrl.searchParams.set('collectiveId', parsedTarget.data);
        cleanUrl.searchParams.set('channelId', 'general');
        cleanUrl.searchParams.delete('view');
      }
      cleanUrl.hash = '';
      // The completion credential is one-time. Clear the callback before the profile read, while
      // retaining the target so a reload can resume after an offline/temporary failure.
      history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search);
      const me = await loadMe();
      if (collectiveId !== undefined) {
        if (!parsedTarget?.success || !me.collectives.some((item) => item.collectiveId === parsedTarget.data)) {
          ++sessionGeneration.current;
          token.current = null;
          sessionStorage.removeItem(`${SESSION_KEY}:${location.origin}`);
          cleanUrl.searchParams.delete('collectiveId');
          cleanUrl.searchParams.delete('channelId');
          history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search);
          setSnapshot((current) => ({
            ...current,
            phase: 'entry',
            me: undefined,
            collective: undefined,
            restrictedScope: undefined,
            events: [],
            channels: undefined,
            participants: undefined,
            members: undefined,
            collaboration: undefined,
            error: '邀请的共同体暂时不可用，请联系邀请人。',
          }));
          return;
        }
      }
      setSnapshot((current) => ({
        ...current,
        phase: phaseForHuman(me),
        me,
        collective: selectedCollective(me),
        restrictedScope: current.meta ? missingMembershipScope(current.meta.serviceInstanceId, me) : undefined,
        events: [],
        channels: undefined,
        collaboration: undefined,
        participants: undefined,
        members: undefined,
        error: undefined,
      }));
    },
    [loadMe, setSnapshot],
  );

  const invitationMode = useMemo(() => entryModeFromHash(location.hash), []);

  const restoreSavedSession = useCallback(async () => {
    token.current = sessionStorage.getItem(`${SESSION_KEY}:${location.origin}`);
    if (!token.current) return undefined;
    try {
      return await loadMe();
    } catch (error) {
      if (!(error instanceof CollectiveClientRequestError) || error.status !== 401) throw error;
      return undefined;
    }
  }, [loadMe]);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        await initializeHumanSession({
          request,
          enterSession,
          restoreSavedSession,
          invitationMode,
          setSnapshot,
          isCancelled: () => cancelled,
        });
      } catch (error) {
        if (!cancelled) {
          setSnapshot((current) => ({
            ...current,
            phase: 'unavailable',
            connection: 'offline',
            error: collectiveClientErrorMessage(error),
          }));
        }
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [enterSession, invitationMode, request, restoreSavedSession, setSnapshot]);

  useEffect(() => {
    const onAuthCompletion = async (event: MessageEvent<unknown>) => {
      const result = trustedHumanAuthResult(event, location.origin, authWindow.current);
      if (!result) return;
      const completedWindow = authWindow.current;
      authWindow.current = null;
      if (result.type === 'collective:human-auth-error') {
        setSnapshot((current) => ({ ...current, error: humanAuthErrorMessage(result.errorCode) }));
        completedWindow?.close();
        return;
      }
      try {
        await enterSession(result.sessionToken, result.collectiveId);
        completedWindow?.close();
      } catch (error) {
        setSnapshot((current) => ({ ...current, error: collectiveClientErrorMessage(error) }));
      }
    };
    window.addEventListener('message', onAuthCompletion);
    return () => window.removeEventListener('message', onAuthCompletion);
  }, [enterSession, setSnapshot]);

  const configureProvider = useProviderSetup({ providers: snapshot.providers, request, setSnapshot });

  const bootstrap = useCallback(
    async (displayName: string) => {
      const secret = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
      if (!secret) throw new Error('这个一次性初始化链接不完整');
      const result = await request<SessionResult>('/api/bootstrap', {
        method: 'POST',
        body: JSON.stringify({ secret, displayName }),
      });
      await enterSession(result.sessionToken);
    },
    [enterSession, request],
  );

  const authenticate = useCallback(async () => {
    const provider = snapshot.providers.find((candidate) => candidate.id === 'github');
    if (!provider?.ready) throw new Error('Human 登录尚未配置');
    const intent = resolveHumanAuthIntent(snapshot.phase, invitationMode);
    authWindow.current?.close();
    const openedWindow = window.open('about:blank', HUMAN_AUTH_WINDOW_NAME, 'popup,width=720,height=760');
    if (!openedWindow) throw new Error('浏览器阻止了登录窗口，请允许此页面打开窗口后重试');
    authWindow.current = openedWindow;
    try {
      const result = await request<HumanAuthBeginResult>('/api/auth/github/begin', {
        method: 'POST',
        body: JSON.stringify(intent),
      });
      const authorizationUrl = new URL(result.authorizationUrl);
      if (authorizationUrl.protocol !== 'https:') throw new Error('Human 登录地址不安全');
      openedWindow.location.assign(authorizationUrl.href);
    } catch (error) {
      openedWindow.close();
      if (authWindow.current === openedWindow) authWindow.current = null;
      throw error;
    }
  }, [invitationMode, request, snapshot.phase, snapshot.providers]);

  const switchAccount = useCallback(() => {
    ++sessionGeneration.current;
    token.current = null;
    authWindow.current?.close();
    authWindow.current = null;
    sessionStorage.removeItem(`${SESSION_KEY}:${location.origin}`);
    setSnapshot((current) => ({
      ...current,
      phase: 'entry',
      me: undefined,
      collective: undefined,
      restrictedScope: undefined,
      events: [],
      channels: undefined,
      collaboration: undefined,
      participants: undefined,
      members: undefined,
      notice: undefined,
      error: undefined,
      delivery: { kind: 'idle' },
    }));
  }, [setSnapshot]);

  return {
    token,
    request,
    binaryRequest,
    loadMe,
    invitationMode,
    bootstrap,
    authenticate,
    configureProvider,
    switchAccount,
  };
}

export { CollectiveClientRequestError, collectiveClientErrorMessage } from './client-request.js';
