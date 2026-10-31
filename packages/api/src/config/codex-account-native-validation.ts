import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyCodexAccountRequirements,
  validateCodexApiAccountOverrides,
  validateCodexOAuthRequirements,
} from './codex-account-environment.js';
import { readCodexAccountIdentity, sameCodexIdentity } from './codex-account-identity.js';
import { codexCanonicalPath } from './codex-account-launch.js';
import { codexConfigRecord, overlayCodexSensitiveConfig } from './codex-launch-config.js';

export interface CodexNativeAccountExpectation {
  readonly authMode: 'oauth' | 'api_key' | 'auto';
  readonly sqliteHome: string;
  readonly cwd: string;
  readonly credentialHome?: string;
  readonly identity?: { userId: string; workspaceId: string };
}
type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
function unavailable(): never {
  throw new Error('codex_native_account_configuration_unavailable');
}
function conflict(key: string): never {
  throw new Error(`codex_native_account_configuration_conflict:${key}`);
}
function requiredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable();
  return value as Record<string, unknown>;
}
/** Same initialized host, before business RPC. This cannot prevent bootstrap auth access. */
export async function validateCodexNativeAccount(
  request: Request,
  expectation: CodexNativeAccountExpectation,
  rpcConfig: Record<string, unknown> = {},
): Promise<void> {
  if (expectation.authMode === 'api_key') validateCodexApiAccountOverrides([], rpcConfig);
  const loaded = requiredRecord(await request('config/read', { cwd: expectation.cwd, includeLayers: false }));
  const config = requiredRecord(loaded.config);
  // Pinned 0.159.0 wire name is configRequirements/read, not config/requirements/read.
  const constraints = requiredRecord(await request('configRequirements/read', {}));
  if (!Object.hasOwn(constraints, 'requirements')) unavailable();
  const requirements = constraints.requirements === null ? {} : requiredRecord(constraints.requirements);
  const observed = requiredRecord(await request('account/read', { refreshToken: false }));
  if (expectation.identity) {
    const current = expectation.credentialHome ? readCodexAccountIdentity(expectation.credentialHome) : undefined;
    if (!sameCodexIdentity(expectation.identity, current)) conflict('account_identity');
    const native = codexConfigRecord(observed.account);
    if (native.type !== 'chatgpt' || (native.email && native.email !== current?.email)) conflict('account_identity');
  }
  const effective = applyCodexAccountRequirements(overlayCodexSensitiveConfig(config, rpcConfig), requirements);
  if (typeof requirements.sqlite_home === 'string' && requirements.sqlite_home.startsWith('file:')) {
    try {
      effective.sqlite_home = fileURLToPath(requirements.sqlite_home);
    } catch {
      conflict('sqlite_home');
    }
  }
  if (expectation.authMode === 'oauth') {
    validateCodexOAuthRequirements(effective, requirements);
    if (codexConfigRecord(observed.account).type !== 'chatgpt') conflict('auth_mode');
    if (expectation.identity && effective.cli_auth_credentials_store !== 'file') conflict('cli_auth_credentials_store');
    if (expectation.identity && effective.forced_chatgpt_workspace_id !== expectation.identity.workspaceId)
      conflict('account_identity');
  }
  // Native config/read returns normalized paths. Never reinterpret an unknown relative origin as cwd.
  if (
    effective.sqlite_home !== undefined &&
    effective.sqlite_home !== null &&
    (typeof effective.sqlite_home !== 'string' ||
      !isAbsolute(effective.sqlite_home) ||
      codexCanonicalPath(effective.sqlite_home, expectation.cwd) !== expectation.sqliteHome)
  )
    conflict('sqlite_home');
}
