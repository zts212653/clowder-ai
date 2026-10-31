import type { CodexAccountLaunchDescriptor } from './codex-account-launch.js';
import { codexCliConfig } from './codex-launch-config.js';

/** Shared database ownership and private file authentication are account fields, not model preferences. */
export function codexManagedLaunchArgs(
  descriptor: CodexAccountLaunchDescriptor,
  memberArgs: readonly string[],
): string[] {
  if (!descriptor.managed) return [];
  const owned = new Set([
    'sqlite_home',
    'cli_auth_credentials_store',
    'forced_login_method',
    'forced_chatgpt_workspace_id',
    'profile',
    'profiles',
    'profiles_v2',
  ]);
  codexCliConfig(memberArgs, (key) => {
    if (owned.has(key.split('.')[0])) throw new Error('codex_managed_account_configuration_conflict');
  });
  if (
    memberArgs.some(
      (arg) =>
        arg === '--profile' || arg === '-p' || arg.startsWith('--profile=') || (arg.startsWith('-p') && arg.length > 2),
    )
  )
    throw new Error('codex_managed_account_configuration_conflict');
  return [
    '--config',
    `sqlite_home=${JSON.stringify(descriptor.sqliteHome)}`,
    '--config',
    'cli_auth_credentials_store="file"',
    '--config',
    'forced_login_method="chatgpt"',
    ...(descriptor.identity
      ? ['--config', `forced_chatgpt_workspace_id=${JSON.stringify(descriptor.identity.workspaceId)}`]
      : []),
  ];
}
