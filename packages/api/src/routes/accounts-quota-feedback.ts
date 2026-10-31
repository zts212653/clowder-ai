import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountQuotaObservation } from '@cat-cafe/shared';

export function quotaCredentialVersion(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('hex');
}

/** An old 401 describes that request, not the current credential. Never refresh here. */
export function projectQuotaRenewal(quota: AccountQuotaObservation | undefined, home: string | undefined) {
  if (!quota || quota.status !== 'unavailable') return quota;
  const renewal =
    quota.failure?.kind === 'renewal_required' ||
    (!quota.failure && quota.error === '登录凭据已过期，请让官方 Codex 完成续期后再查询');
  if (!renewal) return quota;
  const observation = { ...quota, failure: quota.failure ?? { kind: 'renewal_required' as const } };
  if (!home) return observation;
  try {
    const raw = readFileSync(join(home, 'auth.json'), 'utf8');
    if (raw.length > 262144) return observation;
    const auth = JSON.parse(raw) as { tokens?: { access_token?: string }; last_refresh?: string };
    if (!auth.tokens?.access_token) return observation;
    const version = quotaCredentialVersion(auth.tokens.access_token);
    const changed = quota.credentialVersion
      ? version !== quota.credentialVersion
      : !!auth.last_refresh && Date.parse(auth.last_refresh) > quota.observedAt;
    return changed ? { ...observation, renewedCredentialVersion: version } : observation;
  } catch {
    return observation;
  }
}

/** Bounded text-only upstream error; never persist or return bearer credentials. */
export async function officialQuotaFailure(response: Response, secrets: string[]) {
  const reader = response.body?.getReader();
  let text = '';
  if (reader) {
    const decoder = new TextDecoder();
    let size = 0;
    try {
      while (size < 8192) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 8192) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      /* HTTP status remains usable even when the error body fails. */
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  let code = '',
    message = '';
  try {
    const value = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    if (typeof value.error?.code === 'string') code = value.error.code;
    if (typeof value.error?.message === 'string') message = value.error.message;
  } catch {
    /* Do not render arbitrary HTML or proxy error pages. */
  }
  let detail = `HTTP ${response.status}${code ? ` · ${code}` : ''}${message ? ` · ${message}` : ''}`;
  for (const secret of secrets.filter(Boolean)) detail = detail.split(secret).join('[redacted]');
  detail = detail
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
    .slice(0, 500);
  const revoked = /^(token_revoked|refresh_token_reused|refresh_token_expired|session_invalidated|invalid_grant)$/.test(
    code,
  );
  const kind = revoked ? 'signin_required' : response.status === 401 ? 'renewal_required' : 'service_unreachable';
  return { kind, officialDetail: detail } satisfies NonNullable<AccountQuotaObservation['failure']>;
}
