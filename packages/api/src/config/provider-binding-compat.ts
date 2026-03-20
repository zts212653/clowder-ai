import type { CatProvider } from '@cat-cafe/shared';
import type { BuiltinAccountClient, ProviderProfileProtocol, RuntimeProviderProfile } from './provider-profiles.types.js';

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

export function validateRuntimeProviderBinding(
  provider: CatProvider,
  profile: RuntimeProviderProfile,
  defaultModel?: string | null,
): string | null {
  const expectedClient = resolveBuiltinClientForProvider(provider);
  if (expectedClient && profile.kind === 'builtin' && profile.client && profile.client !== expectedClient) {
    return `bound provider profile "${profile.id}" is incompatible with client "${provider}"`;
  }
  // API Key accounts declare their own protocol — don't reject based on provider mismatch.
  // The invocation chain uses account.protocol for env var injection.

  const trimmedModel = defaultModel?.trim();
  if (trimmedModel && profile.models?.length && !profile.models.includes(trimmedModel)) {
    return `model "${trimmedModel}" is not available on provider "${profile.id}"`;
  }

  return null;
}
