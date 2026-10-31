import { apiFetch } from '@/utils/api-client';
import type { ProfileItem } from '../hub-accounts.types';

export class AccountRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function accountRequest<T = unknown>(
  path: string,
  body: Record<string, unknown>,
  method = 'POST',
): Promise<T> {
  const response = await apiFetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result: unknown = await response.json();
  const error =
    result && typeof result === 'object' && 'error' in result ? (result as { error?: unknown }).error : undefined;
  if (!response.ok)
    throw new AccountRequestError(typeof error === 'string' ? error : '账号操作失败，请重试', response.status);
  return result as T;
}

/** Keep a created row available for retry even when native login cannot be started. */
export async function startCreatedCodexAccountLogin(
  profile: ProfileItem,
): Promise<{ profile: ProfileItem; loginError?: string }> {
  try {
    const result = await accountRequest<{ codex: NonNullable<ProfileItem['codex']> }>(
      `/api/accounts/${profile.id}/codex/login/start`,
      {},
    );
    return { profile: { ...profile, codex: { ...profile.codex!, ...result.codex } } };
  } catch (error) {
    return { profile, loginError: error instanceof Error ? error.message : '终端登录未能启动' };
  }
}
