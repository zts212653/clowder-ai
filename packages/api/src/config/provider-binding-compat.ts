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
 * For api_key profiles: ocProviderName is required because the runtime generates a
 * per-catId config file and needs it for the provider block.
 * Model format is NOT validated — users may use any model naming convention
 * (e.g. OpenRouter's `z-ai/glm-4.7` where the prefix differs from ocProviderName).
 */
export function validateModelFormatForProvider(
  provider: CatProvider,
  _defaultModel?: string | null,
  profileKind?: ProviderProfileKind,
  ocProviderName?: string | null,
  options?: { legacyCompat?: boolean },
): string | null {
  if (provider !== 'opencode') return null;
  if (profileKind === 'api_key') {
    const trimmedOcProvider = ocProviderName?.trim();
    if (!trimmedOcProvider) {
      // Legacy compat: existing opencode+api_key members created before F189
      // may not have ocProviderName. Allow edits to pass through — the invoke
      // path skips the F189 config block when ocProviderName is absent.
      if (options?.legacyCompat) return null;
      return 'client "opencode" with API key auth requires an OpenCode Provider name (e.g. anthropic, openai, maas)';
    }
    if (trimmedOcProvider.includes('/')) {
      return 'OpenCode Provider name must not contain "/" — use a plain identifier (e.g. "openrouter", not "openrouter/google")';
    }
  }
  return null;
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
