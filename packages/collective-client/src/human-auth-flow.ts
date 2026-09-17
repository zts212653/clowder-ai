import type { ClientPhase, CollectiveMe } from './client-types.js';

export { trustedGitHubAppRegistrationUrl } from './github-app-manifest.js';

export type EntryMode = 'bootstrap' | 'invite' | 'missing';

export const HUMAN_AUTH_WINDOW_NAME = 'collective-human-auth';
export const PROVIDER_SETUP_WINDOW_NAME = 'collective-provider-setup';

export interface HumanAuthCompletionMessage {
  readonly type: 'collective:human-auth-completion';
  readonly serviceUrl: string;
  readonly sessionToken: string;
}

const HUMAN_AUTH_ERROR_CODES = [
  'authorization_denied',
  'authorization_expired',
  'identity_conflict',
  'provider_unavailable',
  'authorization_failed',
] as const;

export type HumanAuthErrorCode = (typeof HUMAN_AUTH_ERROR_CODES)[number];

export interface HumanAuthErrorMessage {
  readonly type: 'collective:human-auth-error';
  readonly serviceUrl: string;
  readonly errorCode: HumanAuthErrorCode;
}

export type HumanAuthResultMessage = HumanAuthCompletionMessage | HumanAuthErrorMessage;

const PROVIDER_SETUP_ERROR_CODES = ['authorization_denied', 'provider_unavailable'] as const;

export type ProviderSetupErrorCode = (typeof PROVIDER_SETUP_ERROR_CODES)[number];

export type ProviderSetupResultMessage =
  | {
      readonly type: 'collective:provider-setup-completion';
      readonly serviceUrl: string;
    }
  | {
      readonly type: 'collective:provider-setup-error';
      readonly serviceUrl: string;
      readonly errorCode: ProviderSetupErrorCode;
    };

export function trustedProviderSetupResult(
  event: { readonly origin: string; readonly source: unknown; readonly data: unknown },
  serviceOrigin: string,
  setupWindow: unknown,
): ProviderSetupResultMessage | undefined {
  if (event.origin !== serviceOrigin || event.source !== setupWindow) return undefined;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return undefined;
  const data = event.data as Record<string, unknown>;
  if (data.serviceUrl !== serviceOrigin) return undefined;
  if (data.type === 'collective:provider-setup-completion') {
    return Object.keys(data).every((key) => ['type', 'serviceUrl'].includes(key))
      ? { type: data.type, serviceUrl: serviceOrigin }
      : undefined;
  }
  if (
    data.type !== 'collective:provider-setup-error' ||
    Object.keys(data).some((key) => !['type', 'serviceUrl', 'errorCode'].includes(key)) ||
    typeof data.errorCode !== 'string' ||
    !PROVIDER_SETUP_ERROR_CODES.some((code) => code === data.errorCode)
  ) {
    return undefined;
  }
  return { type: data.type, serviceUrl: serviceOrigin, errorCode: data.errorCode as ProviderSetupErrorCode };
}

export function providerSetupErrorMessage(code: ProviderSetupErrorCode): string {
  return code === 'authorization_denied'
    ? 'GitHub 登录应用创建已取消；准备好后可以重新开始'
    : 'GitHub 登录应用暂时无法完成，请稍后重试';
}

export function trustedHumanAuthResult(
  event: { readonly origin: string; readonly source: unknown; readonly data: unknown },
  serviceOrigin: string,
  authWindow: unknown,
): HumanAuthResultMessage | undefined {
  if (event.origin !== serviceOrigin || event.source !== authWindow) return undefined;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return undefined;
  const data = event.data as Record<string, unknown>;
  if (data.serviceUrl !== serviceOrigin) return undefined;
  if (data.type === 'collective:human-auth-error') {
    if (Object.keys(data).some((key) => !['type', 'serviceUrl', 'errorCode'].includes(key))) return undefined;
    const errorCode = parseHumanAuthErrorCode(data.errorCode);
    return errorCode ? { type: data.type, serviceUrl: serviceOrigin, errorCode } : undefined;
  }
  if (Object.keys(data).some((key) => !['type', 'serviceUrl', 'sessionToken'].includes(key))) return undefined;
  if (
    data.type !== 'collective:human-auth-completion' ||
    typeof data.sessionToken !== 'string' ||
    data.sessionToken.length < 16 ||
    data.sessionToken.length > 512
  ) {
    return undefined;
  }
  return data as unknown as HumanAuthCompletionMessage;
}

export function parseHumanAuthErrorCode(value: unknown): HumanAuthErrorCode | undefined {
  return typeof value === 'string' && HUMAN_AUTH_ERROR_CODES.some((code) => code === value)
    ? (value as HumanAuthErrorCode)
    : undefined;
}

export function humanAuthErrorMessage(code: HumanAuthErrorCode): string {
  const messages: Record<HumanAuthErrorCode, string> = {
    authorization_denied: '登录已取消；你可以留在这里，准备好后再试',
    authorization_expired: '这次登录已失效，请重新开始',
    identity_conflict: '这个 GitHub 身份已经属于另一位成员',
    provider_unavailable: 'GitHub 登录暂时不可用，请稍后重试',
    authorization_failed: '这次登录没有完成，请重新尝试',
  };
  return messages[code];
}

export function entryModeFromHash(hash: string): EntryMode {
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  if (fragment.has('bootstrap')) return 'bootstrap';
  if (fragment.has('invite')) return 'invite';
  return 'missing';
}

export function phaseForHuman(me: CollectiveMe): ClientPhase {
  if (!me.auth) return me.collectives.length > 0 ? 'bind-identity' : 'create-collective';
  return me.collectives.length > 0 ? 'ready' : 'create-collective';
}
