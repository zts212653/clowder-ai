import type { CodexAccountIdentity } from '@cat-cafe/shared';
import { resolveByAccountRef } from './account-resolver.js';
import { inspectAccountCatalog } from './account-store-snapshot.js';
import { readCodexAccountIdentity, sameCodexIdentity } from './codex-account-identity.js';
import { resolveCodexAccountLaunch } from './codex-account-launch.js';

/** Re-read durable principals at adoption, not only when native login finishes.
 * The default account has no managed metadata; read its canonical selected file home.
 */
export function findDuplicateCodexAccount(
  root: string,
  ref: string,
  identity: CodexAccountIdentity,
): string | undefined {
  const refs = new Set(['codex', ...Object.keys(inspectAccountCatalog(root).entries)]);
  for (const other of refs) {
    if (other === ref) continue;
    const profile = resolveByAccountRef(root, other);
    if (!profile || profile.client !== 'openai' || profile.authType !== 'oauth') continue;
    if (
      sameCodexIdentity(profile.codex?.identity, identity) ||
      sameCodexIdentity(
        readCodexAccountIdentity(resolveCodexAccountLaunch(profile, { cwd: root }).credentialHome),
        identity,
      )
    )
      return other;
  }
  return undefined;
}
