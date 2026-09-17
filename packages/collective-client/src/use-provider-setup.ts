import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from 'react';

import { type ClientRequest, collectiveClientErrorMessage } from './client-request.js';
import type { ClientSnapshot, HumanAuthProviderStatus } from './client-types.js';
import { prepareGitHubAppManifestSubmission } from './github-app-manifest.js';
import {
  PROVIDER_SETUP_WINDOW_NAME,
  providerSetupErrorMessage,
  trustedProviderSetupResult,
} from './human-auth-flow.js';

type SnapshotSetter = Dispatch<SetStateAction<ClientSnapshot>>;

export function finishProviderSetupCallback(context: {
  readonly setSnapshot: SnapshotSetter;
  readonly isCancelled: () => boolean;
}): boolean {
  const callbackSearch = new URLSearchParams(location.search);
  const configured = callbackSearch.get('providerConfigured') === '1';
  const rawError = callbackSearch.get('providerSetupError');
  const errorCode = rawError === 'authorization_denied' || rawError === 'provider_unavailable' ? rawError : undefined;
  if (!configured && !errorCode) return false;
  if (window.name === PROVIDER_SETUP_WINDOW_NAME && window.opener) {
    window.opener.postMessage(
      configured
        ? { type: 'collective:provider-setup-completion', serviceUrl: location.origin }
        : { type: 'collective:provider-setup-error', serviceUrl: location.origin, errorCode },
      location.origin,
    );
    if (!context.isCancelled()) {
      context.setSnapshot((current) => ({
        ...current,
        phase: 'loading',
        notice: configured ? 'GitHub 登录应用已创建，正在返回 Collective…' : undefined,
        error: errorCode ? providerSetupErrorMessage(errorCode) : undefined,
      }));
    }
    window.setTimeout(() => window.close(), 100);
    return true;
  }
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete('providerConfigured');
  cleanUrl.searchParams.delete('providerSetupError');
  history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
  return false;
}

export function useProviderSetup({
  providers,
  request,
  setSnapshot,
}: {
  readonly providers: readonly HumanAuthProviderStatus[];
  readonly request: ClientRequest;
  readonly setSnapshot: SnapshotSetter;
}): () => Promise<void> {
  const providerSetupWindow = useRef<Window | null>(null);

  useEffect(() => {
    const onProviderSetupCompletion = async (event: MessageEvent<unknown>) => {
      const result = trustedProviderSetupResult(event, location.origin, providerSetupWindow.current);
      if (!result) return;
      const completedWindow = providerSetupWindow.current;
      providerSetupWindow.current = null;
      completedWindow?.close();
      if (result.type === 'collective:provider-setup-error') {
        setSnapshot((current) => ({ ...current, error: providerSetupErrorMessage(result.errorCode) }));
        return;
      }
      try {
        const authProviders = await request<{ readonly providers: readonly HumanAuthProviderStatus[] }>(
          '/api/auth/providers',
        );
        if (!authProviders.providers.some((provider) => provider.id === 'github' && provider.ready)) {
          throw new Error('GitHub 登录应用尚未就绪，请重新尝试');
        }
        setSnapshot((current) => ({
          ...current,
          providers: authProviders.providers,
          notice: 'GitHub 登录应用已创建；现在可以继续建立 Human 身份',
          error: undefined,
        }));
      } catch (error) {
        setSnapshot((current) => ({ ...current, error: collectiveClientErrorMessage(error) }));
      }
    };
    window.addEventListener('message', onProviderSetupCompletion);
    return () => window.removeEventListener('message', onProviderSetupCompletion);
  }, [request, setSnapshot]);

  return useCallback(async () => {
    const provider = providers.find((candidate) => candidate.id === 'github');
    if (provider?.ready) return;
    assertProviderSetupSupported(provider);
    providerSetupWindow.current?.close();
    const openedWindow = window.open('about:blank', PROVIDER_SETUP_WINDOW_NAME, 'popup,width=720,height=760');
    if (!openedWindow) throw new Error('浏览器阻止了设置窗口，请允许此页面打开窗口后重试');
    providerSetupWindow.current = openedWindow;
    try {
      const bootstrapSecret = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
      const result = await request<unknown>('/api/setup/github-app/begin', {
        method: 'POST',
        body: JSON.stringify(bootstrapSecret ? { bootstrapSecret } : {}),
      });
      submitGitHubAppManifest(openedWindow, result);
    } catch (error) {
      openedWindow.close();
      if (providerSetupWindow.current === openedWindow) providerSetupWindow.current = null;
      throw error;
    }
  }, [providers, request]);
}

function assertProviderSetupSupported(provider: HumanAuthProviderStatus | undefined): void {
  if (!provider?.setupSupported) throw new Error('此 Service 不支持在页面中创建 GitHub 登录应用');
}

function submitGitHubAppManifest(openedWindow: Window, result: unknown): void {
  const submission = prepareGitHubAppManifestSubmission(result);
  const form = openedWindow.document.createElement('form');
  form.method = submission.method;
  form.action = submission.action;
  for (const field of submission.fields) {
    const input = openedWindow.document.createElement('input');
    input.type = 'hidden';
    input.name = field.name;
    input.value = field.value;
    form.append(input);
  }
  openedWindow.document.body.append(form);
  form.submit();
}
