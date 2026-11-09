import { validateCodexNativeAccount } from '../../../../../config/codex-account-native-validation.js';
import type { AgentCarrierSession, AgentCarrierSessionOptions } from '../../types.js';

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type Expected = Parameters<typeof validateCodexNativeAccount>[1];
// A protocol observation input, not a resource/admission owner. The connection retains its launch snapshot.
const expectedByWire = new WeakMap<AgentCarrierSession, Expected>();
const transportByWire = new WeakMap<AgentCarrierSession, Readonly<Record<string, string>>>();
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
];
export function codexTransportEnvironment(wire: AgentCarrierSession): Readonly<Record<string, string>> {
  return transportByWire.get(wire) ?? {};
}

export function bindCodexAccountConfiguration(
  wire: AgentCarrierSession,
  options: AgentCarrierSessionOptions,
): AgentCarrierSession {
  const env = options.env;
  transportByWire.set(
    wire,
    Object.freeze(
      Object.fromEntries(PROXY_ENV_KEYS.flatMap((key) => (typeof env?.[key] === 'string' ? [[key, env[key]!]] : []))),
    ),
  );
  if (env?.CODEX_AUTH_MODE) {
    expectedByWire.set(
      wire,
      Object.freeze({
        authMode: env.CODEX_AUTH_MODE === 'api_key' ? 'api_key' : env.CODEX_AUTH_MODE === 'auto' ? 'auto' : 'oauth',
        sqliteHome: env.CODEX_SQLITE_HOME ?? '',
        cwd: options.cwd ?? process.cwd(),
        ...(env.CODEX_CAT_EXPECTED_USER_ID && env.CODEX_CAT_EXPECTED_WORKSPACE_ID
          ? {
              credentialHome: env.CODEX_CAT_EXPECTED_CREDENTIAL_HOME ?? '',
              identity: { userId: env.CODEX_CAT_EXPECTED_USER_ID, workspaceId: env.CODEX_CAT_EXPECTED_WORKSPACE_ID },
            }
          : {}),
      }),
    );
  }
  return wire;
}

/** Called on the same initialized connection before any thread, control or inventory business RPC. */
export async function validateCodexAccountConfiguration(
  wire: AgentCarrierSession,
  request: Request,
  config: Record<string, unknown> = {},
): Promise<void> {
  const expected = expectedByWire.get(wire);
  if (!expected) return;
  if (!expected.sqliteHome) throw new Error('codex_native_account_configuration_unavailable');
  await validateCodexNativeAccount(request, expected, config);
}
