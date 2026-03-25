import type { CatProvider } from '@cat-cafe/shared';
import type {
  BuiltinAccountClient,
  ProviderProfileProtocol,
  RuntimeProviderProfile,
} from './provider-profiles.types.js';

export function resolveBuiltinClientForProvider(provider: CatProvider): BuiltinAccountClient | null {
  switch (provider) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
    case 'relayclaw':
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
 * The opencode CLI expects this format; bare models like "glm-5" become "glm-5/" at runtime.
 * Server-side callers MUST reject; frontend shows the same message as a pre-flight hint.
 */
export function validateModelFormatForProvider(provider: CatProvider, defaultModel?: string | null): string | null {
  if (provider !== 'opencode') return null;
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
  if (provider === 'relayclaw') {
    if (profile.authType !== 'api_key') {
      return 'client "jiuwenClaw" requires an API key provider profile';
    }
    if (profile.protocol !== 'openai') {
      return 'client "jiuwenClaw" currently only supports openai-compatible API key profiles';
    }
  }

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
