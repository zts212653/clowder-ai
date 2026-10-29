import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef } from 'react';
import { type ClientRequest, CollectiveClientRequestError, collectiveClientErrorMessage } from './client-request.js';
import type {
  ClientSnapshot,
  CollectiveMe,
  CollectiveMeta,
  HumanAuthBeginResult,
  HumanAuthProviderStatus,
  SessionResult,
} from './client-types.js';
import { closeCollectiveScope, currentCollectiveScope, missingMembershipScope } from './collective-scope-recovery.js';
import {
  entryModeFromHash,
  HUMAN_AUTH_WINDOW_NAME,
  humanAuthErrorMessage,
  parseHumanAuthErrorCode,
  phaseForHuman,
  trustedHumanAuthResult,
} from './human-auth-flow.js';
import { finishProviderSetupCallback, useProviderSetup } from './use-provider-setup.js';

export const SESSION_KEY = 'collective-session';

function selectedCollective(me?: CollectiveMe) {
  const id = new URLSearchParams(location.search).get('collectiveId');
  return id
    ? me?.collectives.find((item) => item.collectiveId === id)
    : me?.collectives.length === 1
      ? me.collectives[0]
      : undefined;
}

type SnapshotSetter = Dispatch<SetStateAction<ClientSnapshot>>;
type EntryMode = ReturnType<typeof entryModeFromHash>;

interface AuthBootContext {
  readonly request: ClientRequest;
  readonly enterSession: (sessionToken: string) => Promise<void>;
  readonly restoreSavedSession: () => Promise<CollectiveMe | undefined>;
  readonly invitationMode: EntryMode;
  readonly setSnapshot: SnapshotSetter;
  readonly isCancelled: () => boolean;
}

async function finishAuthCompletion(context: AuthBootContext): Promise<void> {
  const completed = await context.request<SessionResult>('/api/auth/completions/exchange', {
    method: 'POST',
    body: '{}',
  });
  if (window.name === HUMAN_AUTH_WINDOW_NAME && window.opener) {
    window.opener.postMessage(
      { type: 'collective:human-auth-completion', serviceUrl: location.origin, sessionToken: completed.sessionToken },
      location.origin,
    );
    if (!context.isCancelled()) {
      context.setSnapshot((current) => ({
        ...current,
        phase: 'loading',
        notice: '身份验证完成，正在回到 Collective…',
      }));
    }
    window.setTimeout(() => window.close(), 100);
    return;
  }
  if (!context.isCancelled()) await context.enterSession(completed.sessionToken);
}

function finishAuthError(errorCode: ReturnType<typeof parseHumanAuthErrorCode>, context: AuthBootContext): boolean {
  if (!errorCode) return false;
  const error = humanAuthErrorMessage(errorCode);
  if (window.name === HUMAN_AUTH_WINDOW_NAME && window.opener) {
    window.opener.postMessage(
      { type: 'collective:human-auth-error', serviceUrl: location.origin, errorCode },
      location.origin,
    );
    if (!context.isCancelled()) context.setSnapshot((current) => ({ ...current, phase: 'entry', error }));
    window.setTimeout(() => window.close(), 100);
    return true;
  }
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete('authError');
  history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
  return false;
}

async function initializeHumanSession(context: AuthBootContext): Promise<void> {
  const meta = await context.request<CollectiveMeta>('/api/meta');
  if (context.isCancelled()) return;
  const authProviders = await context.request<{ readonly providers: readonly HumanAuthProviderStatus[] }>(
    '/api/auth/providers',
  );
  if (context.isCancelled()) return;
  context.setSnapshot((current) => ({ ...current, meta, providers: authProviders.providers }));
  if (finishProviderSetupCallback(context)) return;
  const callbackSearch = new URLSearchParams(location.search);
  if (callbackSearch.get('authCompleted') === '1') return finishAuthCompletion(context);
  const authErrorCode = parseHumanAuthErrorCode(callbackSearch.get('authError'));
  if (finishAuthError(authErrorCode, context)) return;
  const authError = authErrorCode ? humanAuthErrorMessage(authErrorCode) : undefined;
  if (context.invitationMode === 'invite' || (context.invitationMode === 'bootstrap' && meta.bootstrapNeeded)) {
    if (!context.isCancelled()) context.setSnapshot((current) => ({ ...current, phase: 'entry', error: authError }));
    return;
  }
  const me = await context.restoreSavedSession();
  if (context.isCancelled()) return;
  context.setSnapshot((current) => ({
    ...current,
    meta,
    me,
    collective: selectedCollective(me),
    restrictedScope: me ? missingMembershipScope(meta.serviceInstanceId, me) : undefined,
    phase: me ? phaseForHuman(me) : 'entry',
    events: [],
    channels: undefined,
    collaboration: undefined,
    participants: undefined,
    members: undefined,
    error: authError,
  }));
}

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
  const request = useCallback(<Result>(path: string, init?: RequestInit): Promise<Result> => {
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
      const response = await fetch(path, options);
      const payload = (await response.json()) as Result & { error?: { code?: string; message?: string } };
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
  }, []);

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
    async (sessionToken: string) => {
      ++sessionGeneration.current;
      token.current = sessionToken;
      sessionStorage.setItem(`${SESSION_KEY}:${location.origin}`, sessionToken);
      const cleanUrl = new URL(location.href);
      cleanUrl.searchParams.delete('authCompleted');
      cleanUrl.searchParams.delete('authError');
      cleanUrl.hash = '';
      history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search);
      const me = await loadMe();
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
        await enterSession(result.sessionToken);
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
