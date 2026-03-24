import type { CatProvider } from '@cat-cafe/shared';
import type {
  BuiltinAccountClient,
  ProviderProfileKind,
  ProviderProfileProtocol,
  RuntimeProviderProfile,
} from './provider-profiles.types.js';

export function resolveBuiltinClientForProvider(provider: CatProvider): BuiltinAccountClient | null {
  switch (provider) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'google':
      return 'google';
    case 'dare':
      return 'dare';
    case 'opencode':
      return 'opencode';
    default:
      return null;
  }
}

function resolveExpectedProtocolForProvider(provider: CatProvider): ProviderProfileProtocol | null {
  switch (provider) {
    case 'anthropic':
    case 'opencode':
      return 'anthropic';
    case 'openai':
    case 'dare':
      return 'openai';
    case 'google':
      return 'google';
    default:
      return null;
  }
}

/**
 * Returns an error string when the opencode provider binding is incomplete.
 *
 * For api_key profiles: ocProviderName is **always required**. The runtime generates a
 * per-catId config file and assembles `${ocProviderName}/${defaultModel}` for -m routing.
 * Built-in provider names (anthropic, openai, openrouter) and custom names (maas, deepseek)
 * are both valid — "anthropic" as ocProviderName is just the special case that was previously
 * handled as a separate code path (Path B). Now unified into one mechanism.
 *
 * For builtin auth (OAuth): the model should use "providerId/modelId" format (e.g. openai/gpt-5.4)
 * since opencode's built-in provider registry handles routing natively.
 */
export function validateModelFormatForProvider(
  provider: CatProvider,
  defaultModel?: string | null,
  profileKind?: ProviderProfileKind,
  ocProviderName?: string | null,
): string | null {
  if (provider !== 'opencode') return null;
  const trimmedModel = defaultModel?.trim();
  if (!trimmedModel) return null;
  if (profileKind === 'api_key') {
    // api_key always requires ocProviderName — runtime config generation depends on it
    const trimmedOcProvider = ocProviderName?.trim();
    if (!trimmedOcProvider) {
      return 'client "opencode" with API key auth requires an OpenCode Provider name (e.g. anthropic, openai, maas)';
    }
    // If model already has provider/ prefix, it must match ocProviderName to avoid
    // generating a runtime config where the provider block and model prefix disagree.
    const slashIdx = trimmedModel.indexOf('/');
    if (slashIdx > 0) {
      const modelPrefix = trimmedModel.slice(0, slashIdx);
      if (modelPrefix !== trimmedOcProvider) {
        return `model prefix "${modelPrefix}" does not match Provider name "${trimmedOcProvider}". Use "${trimmedOcProvider}/${trimmedModel.slice(slashIdx + 1)}" or change the Provider name to "${modelPrefix}"`;
      }
    }
    return null;
  }
  // builtin/OAuth: recommend provider/model format for native routing
  const slashIndex = trimmedModel.indexOf('/');
  if (slashIndex > 0 && slashIndex < trimmedModel.length - 1) return null;
  return 'client "opencode" recommends model format "providerId/modelId" (e.g. openai/gpt-5.4)';
}

export function validateRuntimeProviderBinding(
  provider: CatProvider,
  profile: RuntimeProviderProfile,
  defaultModel?: string | null,
): string | null {
  // Gemini CLI currently only supports builtin Google auth in our runtime.
  // API-key profiles (especially third-party endpoints) are intentionally blocked
  // for provider="google" to enforce the hard constraint at server side.
  if (provider === 'google' && profile.kind !== 'builtin') {
    return 'client "google" only supports builtin Gemini auth';
  }

  const expectedClient = resolveBuiltinClientForProvider(provider);
  if (expectedClient && profile.kind === 'builtin' && profile.client && profile.client !== expectedClient) {
    return `bound provider profile "${profile.id}" is incompatible with client "${provider}"`;
  }
  // API Key accounts declare their own protocol — don't reject based on provider mismatch.
  // The invocation chain uses account.protocol for env var injection.

  // Model-in-profile validation removed: users may specify any model for any profile.
  // If the model is unsupported, the downstream CLI/client will report the error at
  // invocation time — we no longer gate at the binding level.

  return null;
}
