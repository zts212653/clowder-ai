import type { ExecutionAccountSnapshot } from '@cat-cafe/shared';
import type { RuntimeProviderProfile } from './account-resolver.js';
import type { CodexAccountLaunchDescriptor } from './codex-account-launch.js';
/** Freeze the accepted producer snapshot, never the later binding or a fresh config read. */
export function codexExecutionAccountSnapshot(
  account: RuntimeProviderProfile,
  launch: CodexAccountLaunchDescriptor,
): ExecutionAccountSnapshot {
  return Object.freeze({
    accountRef: account.id,
    displayName: account.displayName ?? account.id,
    authType: account.authType,
    accountRevision: launch.accountRevision,
    ...(launch.identity ? { identity: Object.freeze({ ...launch.identity }) } : {}),
  });
}
