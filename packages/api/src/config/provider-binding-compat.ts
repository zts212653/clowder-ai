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
 * Returns an error string when the model does not follow "providerId/modelId" convention for opencode.
 * The opencode CLI expects this format for routing; bare models like "glm-5" need a provider prefix.
 *
 * Skipped when profileKind is "api_key" — api_key members store bare model names (e.g. "glm-5")
 * and the provider prefix is supplied by the separate ocProviderName field on the member config.
 * Runtime assembly happens in invoke-single-cat.ts: `${ocProviderName}/${defaultModel}`.
 *
 * For builtin auth (OAuth), the model must already include the provider prefix since there's
 * no separate provider name field — opencode's builtin providers handle routing by convention.
 */
export function validateModelFormatForProvider(
  provider: CatProvider,
  defaultModel?: string | null,
  profileKind?: ProviderProfileKind,
): string | null {
  if (provider !== 'opencode') return null;
  // api_key members use ocProviderName for routing — bare model names are valid
  if (profileKind === 'api_key') return null;
  const trimmedModel = defaultModel?.trim();
  if (!trimmedModel) return null;
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

  const trimmedModel = defaultModel?.trim().replace(/\x1B\[[^m]*m|\[\d+m\]/g, '');
  if (trimmedModel && profile.models?.length && !profile.models.includes(trimmedModel)) {
    return `model "${trimmedModel}" is not available on provider "${profile.id}"`;
  }

  return null;
}
