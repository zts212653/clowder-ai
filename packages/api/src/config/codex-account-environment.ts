import { readCodexAccountIdentity, sameCodexIdentity } from './codex-account-identity.js';
import type { CodexAccountLaunchDescriptor } from './codex-account-launch.js';
import { codexCanonicalPath } from './codex-account-launch.js';
import { withoutUnreviewedCodexEnvironment } from './codex-env-namespace.js';
import {
  codexCliConfig,
  codexConfigRecord,
  overlayCodexSensitiveConfig,
  readCodexLaunchProjection,
} from './codex-launch-config.js';
import { validateCodexManagedLayout } from './codex-managed-layout.js';
import { assertCodexSharedStateRoots } from './codex-shared-state.js';

// These native inputs select another principal or its authentication transport, even with an isolated home.
const ALTERNATIVE_CREDENTIAL_ENV = [
  'CODEX_APP_SERVER_TEST_USER_CONFIG_FILE',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_FEDERATION_RULE_ID',
  'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
  'CODEX_AUTHAPI_BASE_URL',
  'CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL',
  'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
];
// Native organization/project headers plus the API fields supported by the existing env map.
const API_ACCOUNT_ENV = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
];
type CodexAccountEnvironment = Record<string, string | null> & { CODEX_HOME: string; CODEX_SQLITE_HOME: string };
function conflict(key: string): never {
  throw new Error(`codex_oauth_configuration_conflict:${key}`);
}

const API_OWNED_PROVIDER_FIELDS = new Set([
  'name',
  'wire_api',
  'base_url',
  'env_key',
  'experimental_bearer_token',
  'auth',
  'gateway_oauth',
  'aws',
  'requires_openai_auth',
  'http_headers',
  'env_http_headers',
  'model_catalog_url',
  'query_params',
]);
function assertApiOverrideKey(key: string): void {
  const root = key.split('.')[0];
  if (
    [
      'model_provider',
      'openai_base_url',
      'chatgpt_base_url',
      'experimental_realtime_webrtc_call_base_url',
      'experimental_realtime_ws_base_url',
      'forced_login_method',
      'forced_chatgpt_workspace_id',
      'cli_auth_credentials_store',
      'sqlite_home',
      'profile',
      'profiles',
      'profiles_v2',
    ].includes(root)
  )
    throw new Error(`codex_api_account_configuration_conflict:${root}`);
  if (key === 'model_providers' || key === 'model_providers.custom')
    throw new Error('codex_api_account_configuration_conflict:model_providers');
  if (key.startsWith('model_providers.custom.')) {
    const field = key.slice('model_providers.custom.'.length).split('.')[0];
    if (API_OWNED_PROVIDER_FIELDS.has(field))
      throw new Error(`codex_api_account_configuration_conflict:model_providers.custom.${field}`);
  }
}
/** Account routing is not a member preference. Ordinary model/tool/retry settings remain configurable. */
export function validateCodexApiAccountOverrides(
  args: readonly string[],
  rpcConfig: Record<string, unknown> = {},
): void {
  if (
    args.some(
      (arg) =>
        ['--oss', '--local-provider', '--profile', '-p'].includes(arg) ||
        arg.startsWith('--local-provider=') ||
        arg.startsWith('--profile=') ||
        (arg.startsWith('-p') && arg.length > 2),
    )
  )
    throw new Error('codex_api_account_configuration_conflict:model_provider');
  codexCliConfig(args, assertApiOverrideKey);
  // Whole provider/header/auth tables are rejected at their root, including nested RPC objects.
  for (const key of Object.keys(rpcConfig)) assertApiOverrideKey(key);
}
/** Sensitive fields only; this does not implement the native configuration loader. */
export function validateCodexOAuthConfig(config: Record<string, unknown>): void {
  if (config.forced_login_method === 'api') conflict('forced_login_method');
  for (const key of [
    'openai_base_url',
    'chatgpt_base_url',
    'experimental_realtime_webrtc_call_base_url',
    'experimental_realtime_ws_base_url',
  ])
    if (config[key] !== undefined && config[key] !== null && config[key] !== '') {
      // Pinned native 0.159.0 config/read materializes this builtin default, even with no user override.
      if (key === 'chatgpt_base_url' && config[key] === 'https://chatgpt.com/backend-api/') continue;
      conflict(key);
    }
  const providerId = config.model_provider ?? 'openai';
  if (providerId !== 'openai' && providerId !== 'openai_https') conflict('model_provider');
  // Configured definitions cannot replace native builtin openai; managed requirements can.
  if (providerId === 'openai_https')
    validateCodexOwnedProvider(codexConfigRecord(codexConfigRecord(config.model_providers).openai_https));
}
// Serialized Option::None fields from pinned ModelProviderInfo are absent inputs, not overrides.
const NATIVE_UNSET_PROVIDER_FIELDS = new Set([
  'base_url',
  // 0.164.0 serializes this new Option field as null on every provider; a set value still conflicts.
  'capabilities',
  'model_catalog_url',
  'env_key',
  'env_key_instructions',
  'experimental_bearer_token',
  'auth',
  'gateway_oauth',
  'aws',
  'query_params',
  'http_headers',
  'env_http_headers',
  'request_max_retries',
  'stream_max_retries',
  'stream_idle_timeout_ms',
  'websocket_connect_timeout_ms',
]);
export function validateCodexOwnedProvider(provider: Record<string, unknown>): void {
  const allowed: Record<string, unknown> = {
    name: 'OpenAI',
    wire_api: 'responses',
    requires_openai_auth: true,
    supports_websockets: false,
  };
  for (const [key, value] of Object.entries(provider))
    if (
      allowed[key] !== value &&
      !(value === null && NATIVE_UNSET_PROVIDER_FIELDS.has(key)) &&
      !(key === 'supports_standalone_web_search' && value === false)
    )
      conflict(`model_providers.openai_https.${key}`);
  for (const [key, value] of Object.entries(allowed))
    if (provider[key] !== value) conflict(`model_providers.openai_https.${key}`);
}
/** Managed definitions can replace native builtins. They are not ignored user-provider tables. */
export function applyCodexAccountRequirements(
  config: Record<string, unknown>,
  requirements: Record<string, unknown>,
): Record<string, unknown> {
  const effective = { ...config };
  for (const key of ['model_provider', 'chatgpt_base_url', 'sqlite_home', 'cli_auth_credentials_store'])
    if (requirements[key] !== undefined && requirements[key] !== null) effective[key] = requirements[key];
  return effective;
}
export function validateCodexOAuthRequirements(
  config: Record<string, unknown>,
  requirements: Record<string, unknown>,
): void {
  validateCodexOAuthConfig(config);
  const methods = requirements.allowed_login_methods;
  if (Array.isArray(methods) && !methods.includes('chatgpt')) conflict('allowed_login_methods');
  const definition = codexConfigRecord(requirements.model_providers)[String(config.model_provider ?? 'openai')];
  if (definition !== undefined) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition))
      conflict('managed_provider_definition');
    validateCodexOwnedProvider(codexConfigRecord(definition));
  }
}
/** Run after every account/MCP/CLI overlay. Nulls prevent process.env from reintroducing credentials. */
export function finalizeCodexAccountEnvironment(
  descriptor: CodexAccountLaunchDescriptor,
  input: {
    env: Record<string, string | null>;
    /** Account-produced values before parent/MCP inheritance; omitted fields never inherit in explicit API mode. */
    selectedApiEnv?: Readonly<Record<string, string | null>>;
    /** Untrusted member config before system/user dedup loses its ownership. */
    memberConfigArgs?: readonly string[];
    args: readonly string[];
    cwd: string;
    executionHome?: string;
    rpcConfig?: Record<string, unknown>;
  },
): CodexAccountEnvironment {
  if (descriptor.managed || (descriptor.accountRef === 'codex' && descriptor.authMode === 'oauth'))
    assertCodexSharedStateRoots(descriptor.accountOwnerRoot, { launch: descriptor });
  if (descriptor.managed) {
    validateCodexManagedLayout({
      kind: 'managed',
      layoutVersion: 1,
      prepared: true,
      credentialHome: descriptor.credentialHome,
      stateRoot: descriptor.stateRoot,
      sqliteHome: descriptor.sqliteHome,
    });
    const currentIdentity = readCodexAccountIdentity(descriptor.credentialHome);
    if (!sameCodexIdentity(descriptor.identity, currentIdentity)) throw new Error('codex_account_identity_unavailable');
  }
  const home = codexCanonicalPath(input.executionHome ?? descriptor.credentialHome, input.cwd);
  const sqliteHome = input.executionHome ? home : descriptor.sqliteHome;
  const env: CodexAccountEnvironment = {
    ...input.env,
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: sqliteHome,
    CODEX_AUTH_MODE: descriptor.authMode,
    CODEX_CAT_EXPECTED_USER_ID: descriptor.identity?.userId ?? null,
    CODEX_CAT_EXPECTED_WORKSPACE_ID: descriptor.identity?.workspaceId ?? null,
    CODEX_CAT_EXPECTED_CREDENTIAL_HOME: descriptor.identity ? home : null,
    CODEX_CAT_ACCOUNT_REF:
      descriptor.managed || (descriptor.accountRef === 'codex' && descriptor.authMode === 'oauth')
        ? descriptor.accountRef
        : null,
    CODEX_CAT_STATE_ROOT:
      descriptor.managed || (descriptor.accountRef === 'codex' && descriptor.authMode === 'oauth')
        ? descriptor.stateRoot
        : null,
    CODEX_CAT_SHARED_SQLITE_HOME:
      descriptor.managed || (descriptor.accountRef === 'codex' && descriptor.authMode === 'oauth')
        ? descriptor.sqliteHome
        : null,
    CODEX_CAT_ACCOUNT_OWNER_ROOT:
      descriptor.managed || (descriptor.accountRef === 'codex' && descriptor.authMode === 'oauth')
        ? descriptor.accountOwnerRoot
        : null,
  };
  if (descriptor.authMode === 'auto') return env;
  if (descriptor.managed && descriptor.authMode === 'oauth') Object.assign(env, withoutUnreviewedCodexEnvironment(env));
  for (const key of ALTERNATIVE_CREDENTIAL_ENV) env[key] = null;
  // The composed environment alone cannot distinguish selected routing from another account's ambient fields.
  for (const key of API_ACCOUNT_ENV)
    env[key] = descriptor.authMode === 'api_key' ? (input.selectedApiEnv?.[key] ?? null) : null;
  if (descriptor.authMode === 'api_key') {
    validateCodexApiAccountOverrides(input.memberConfigArgs ?? [], input.rpcConfig);
    return env;
  }
  if (input.args.some((arg) => arg === '--oss' || arg === '--local-provider' || arg.startsWith('--local-provider=')))
    conflict('model_provider');
  const projection = readCodexLaunchProjection(home, input.cwd, input.args, {
    nativeHome: input.env.HOME ?? undefined,
  });
  if (descriptor.managed && projection.layers.some((layer) => layer.kind === 'profile')) conflict('profile');
  const config = applyCodexAccountRequirements(
    overlayCodexSensitiveConfig(projection.config, input.rpcConfig ?? {}),
    projection.requirements,
  );
  validateCodexOAuthRequirements(config, projection.requirements);
  if (descriptor.managed && config.cli_auth_credentials_store !== 'file') conflict('cli_auth_credentials_store');
  if (
    descriptor.identity &&
    config.forced_chatgpt_workspace_id &&
    config.forced_chatgpt_workspace_id !== descriptor.identity.workspaceId
  )
    conflict('forced_chatgpt_workspace_id');
  if (
    config.sqlite_home !== undefined &&
    (typeof config.sqlite_home !== 'string' || codexCanonicalPath(config.sqlite_home, input.cwd) !== sqliteHome)
  )
    conflict('sqlite_home');
  return env;
}
