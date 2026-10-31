import type { CodexLoginAttempt } from '@cat-cafe/shared';
import { resolveByAccountRef } from './account-resolver.js';
import { codexManagedStatus, readCodexAccountIdentity, sameCodexIdentity } from './codex-account-identity.js';
import { resolveCodexAccountLaunch } from './codex-account-launch.js';
import { assertCodexSharedStateRoots } from './codex-shared-state.js';

/** A reuse record is history, not authority to bind a deleted or different principal.
 * Project current availability on every read, including restart; never rewrite the history or copy auth.
 */
export function projectCodexAccountReuse(root: string, attempt: CodexLoginAttempt): CodexLoginAttempt {
  try {
    if (!attempt.duplicateAccountRef) throw new Error('missing target');
    const profile = resolveByAccountRef(root, attempt.duplicateAccountRef);
    if (
      !profile ||
      profile.authType !== 'oauth' ||
      profile.client !== 'openai' ||
      (profile.codex && codexManagedStatus(profile.codex) !== 'ready')
    )
      throw new Error('unavailable target');
    const launch = resolveCodexAccountLaunch(profile, { cwd: root });
    assertCodexSharedStateRoots(root, { launch });
    if (!sameCodexIdentity(attempt.identity, readCodexAccountIdentity(launch.credentialHome)))
      throw new Error('different identity');
    return { ...attempt, error: undefined };
  } catch {
    return { ...attempt, duplicateAccountRef: undefined, error: '此前复用的账号已不可用，请重新登录或选择其他账号。' };
  }
}
