import { collectiveIdSchema } from '@cat-cafe/shared';
import type { Dispatch, SetStateAction } from 'react';
import type { ClientRequest } from './client-request.js';
import type {
  ClientSnapshot,
  CollectiveMe,
  CollectiveMeta,
  HumanAuthProviderStatus,
  SessionResult,
} from './client-types.js';
import { missingMembershipScope } from './collective-scope-recovery.js';
import {
  entryModeFromHash,
  HUMAN_AUTH_WINDOW_NAME,
  humanAuthErrorMessage,
  parseHumanAuthErrorCode,
  phaseForHuman,
} from './human-auth-flow.js';
import { finishProviderSetupCallback } from './use-provider-setup.js';

export function selectedCollective(me?: CollectiveMe) {
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
  readonly enterSession: (sessionToken: string, collectiveId?: string) => Promise<void>;
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
  if (completed.collectiveId !== undefined && !collectiveIdSchema.safeParse(completed.collectiveId).success) {
    throw new Error('邀请的共同体信息无效，请联系邀请人。');
  }
  if (window.name === HUMAN_AUTH_WINDOW_NAME && window.opener) {
    // A page opened before an update only accepts the old message shape. New openers consume the
    // target-bearing message first and ignore the compatible second message from the same popup.
    window.opener.postMessage(
      {
        type: 'collective:human-auth-completion',
        serviceUrl: location.origin,
        sessionToken: completed.sessionToken,
        ...(completed.collectiveId !== undefined ? { collectiveId: completed.collectiveId } : {}),
      },
      location.origin,
    );
    if (completed.collectiveId !== undefined) {
      window.opener.postMessage(
        { type: 'collective:human-auth-completion', serviceUrl: location.origin, sessionToken: completed.sessionToken },
        location.origin,
      );
    }
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
  if (!context.isCancelled()) await context.enterSession(completed.sessionToken, completed.collectiveId);
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

export async function initializeHumanSession(context: AuthBootContext): Promise<void> {
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
