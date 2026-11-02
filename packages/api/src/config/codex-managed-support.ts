import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { admitCodexNativeCapability } from '../infrastructure/codex-native-compat/admission.js';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import { readCodexAccountIdentity, sameCodexIdentity } from './codex-account-identity.js';

const run = promisify(execFile);
const POLICY_PROBE =
  'ObjC.import("Foundation"); ObjC.bindFunction("CFPreferencesAppValueIsForced", ["bool", ["id", "id"]]); JSON.stringify(["config_toml_base64", "requirements_toml_base64"].map(function(k) { return $.CFPreferencesAppValueIsForced($(k), $("com.openai.codex")); }));';
/** A busy machine must not turn a policy read into an outage; unknown policy still fails closed. */
const POLICY_PROBE_TIMEOUT_MS = 10_000;

/**
 * Explicit admission for the measured platform, operator policy and carrier. Never disable an
 * operator's native policy. The version is admitted by a recorded credential-free measurement of
 * that exact installed version (see codex-native-compat), not by a hard-coded version string, so a
 * terminal upgrade is measured and followed instead of rejecting every managed account.
 */
export async function assertCodexManagedPlatformSupport(home: string, command = 'codex'): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('codex_managed_platform_unsupported');
  if (['/etc/codex/managed_config.toml', '/etc/codex/requirements.toml'].some(existsSync))
    throw new Error('codex_managed_policy_unsupported');
  let flags: unknown;
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', POLICY_PROBE], {
      encoding: 'utf8',
      timeout: POLICY_PROBE_TIMEOUT_MS,
    });
    flags = JSON.parse(stdout);
  } catch {
    throw new Error('codex_managed_policy_unavailable');
  }
  if (!Array.isArray(flags) || flags.length !== 2 || flags.some((flag) => flag !== false))
    throw new Error('codex_managed_policy_unsupported');
  const native = resolveCliCommand('codex');
  const selected = resolveCliCommand(command);
  if (!native || !selected || realpathSync(native) !== realpathSync(selected))
    throw new Error('codex_managed_native_carrier_required');
  await admitCodexNativeCapability(
    native,
    'managed_accounts',
    { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, NODE_ENV: process.env.NODE_ENV ?? 'production' },
    'codex_managed_version_unverified',
  );
}
/** Recreated control/attachment hosts consume their original accepted environment before acquisition. */
export async function assertCodexManagedCarrierSupport(
  env: Record<string, string | null> | undefined,
  command: string,
): Promise<void> {
  if (!env?.CODEX_CAT_EXPECTED_USER_ID) return;
  const home = env.CODEX_CAT_EXPECTED_CREDENTIAL_HOME;
  const workspaceId = env.CODEX_CAT_EXPECTED_WORKSPACE_ID;
  if (!home || !workspaceId) throw new Error('codex_account_identity_unavailable');
  await assertCodexManagedPlatformSupport(home, command);
  const identity = readCodexAccountIdentity(home);
  if (!sameCodexIdentity({ userId: env.CODEX_CAT_EXPECTED_USER_ID, workspaceId }, identity))
    throw new Error('codex_account_identity_unavailable');
}
