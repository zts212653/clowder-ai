import { codexConfigRecord, readCodexLaunchProjection } from './codex-launch-config.js';

/** This selects CLI-owned authentication; it does not verify a provider credential. */
export function usesNativeCodexThirdPartyProvider(home: string, cwd: string, args: readonly string[]): boolean {
  const { config, requirements } = readCodexLaunchProjection(home, cwd, args, { nativeHome: process.env.HOME });
  return nativeCodexProviderOwnsAuthentication(config, requirements);
}

export function nativeCodexProviderOwnsAuthentication(
  config: Record<string, unknown>,
  requirements: Record<string, unknown>,
): boolean {
  const id = requirements.model_provider ?? config.model_provider ?? 'openai';
  if (typeof id !== 'string' || !id || id === 'openai' || id === 'openai_https') return false;
  // Organization or user policy requiring a ChatGPT principal still needs its identity check.
  if ([config, requirements].some(requiresChatGptIdentity)) return false;
  // This bounded projection cannot certify how native policy admits a custom
  // provider under an organization login allowlist. Keep the identity gate.
  if (requirements.allowed_login_methods !== undefined) return false;
  // Requirements replace a provider definition; do not borrow missing fields from user config.
  const definitions = codexConfigRecord(requirements.model_providers);
  const provider = codexConfigRecord(
    Object.hasOwn(definitions, id) ? definitions[id] : codexConfigRecord(config.model_providers)[id],
  );
  if (provider.requires_openai_auth !== false || typeof provider.base_url !== 'string') return false;
  if (provider.wire_api !== undefined && provider.wire_api !== 'responses') return false;
  try {
    const endpoint = new URL(provider.base_url);
    return ['https:', 'http:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password;
  } catch {
    return false;
  }
}

function requiresChatGptIdentity(layer: Record<string, unknown>): boolean {
  return Boolean(
    (layer.forced_login_method && layer.forced_login_method !== 'api') || layer.forced_chatgpt_workspace_id,
  );
}
