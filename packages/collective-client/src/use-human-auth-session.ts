import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef } from 'react';

import type {
  ClientSnapshot,
  CollectiveMe,
  CollectiveMeta,
  HumanAuthBeginResult,
  HumanAuthProviderStatus,
  SessionResult,
} from './client-types.js';
import {
  entryModeFromHash,
  HUMAN_AUTH_WINDOW_NAME,
  humanAuthErrorMessage,
  parseHumanAuthErrorCode,
  phaseForHuman,
  trustedHumanAuthResult,
} from './human-auth-flow.js';

export const SESSION_KEY = 'collective-session';

export type ClientRequest = <Result>(path: string, init?: RequestInit) => Promise<Result>;

export function collectiveClientErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CollectiveClientRequestError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail);
  }
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
  const [meta, authProviders] = await Promise.all([
    context.request<CollectiveMeta>('/api/meta'),
    context.request<{ readonly providers: readonly HumanAuthProviderStatus[] }>('/api/auth/providers'),
  ]);
  context.setSnapshot((current) => ({ ...current, meta, providers: authProviders.providers }));
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
    collective: me?.collectives[0],
    phase: me ? phaseForHuman(me) : 'entry',
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

  const request = useCallback(async <Result>(path: string, init?: RequestInit): Promise<Result> => {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(token.current ? { authorization: `Bearer ${token.current}` } : {}),
        ...init?.headers,
      },
    });
    const payload = (await response.json()) as Result & { error?: { message?: string } };
    if (!response.ok) {
      throw new CollectiveClientRequestError(
        response.status,
        payload.error?.message ?? `请求失败（${response.status}）`,
      );
    }
    return payload;
  }, []);

  const loadMe = useCallback(async () => request<CollectiveMe>('/api/me'), [request]);

  const enterSession = useCallback(
    async (sessionToken: string) => {
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
        collective: me.collectives[0],
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
    } catch {
      sessionStorage.removeItem(`${SESSION_KEY}:${location.origin}`);
      token.current = null;
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

  return { token, request, loadMe, invitationMode, bootstrap, authenticate };
}
