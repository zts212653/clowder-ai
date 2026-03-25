import type { CatProvider } from '@cat-cafe/shared';
import { createModuleLogger } from '../infrastructure/logger.js';
import type {
  BuiltinAccountClient,
  ProviderProfileKind,
  ProviderProfileProtocol,
  RuntimeProviderProfile,
} from './provider-profiles.types.js';

const log = createModuleLogger('provider-binding');

const KNOWN_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'dare', 'opencode', 'antigravity', 'a2a']);

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
      if (!KNOWN_PROVIDERS.has(provider)) {
        log.info({ provider }, 'unknown provider — no builtin client mapping, will use generic path');
      }
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
      if (!KNOWN_PROVIDERS.has(provider)) {
        log.info({ provider }, 'unknown provider — no protocol mapping');
      }
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
    if (!ocProviderName?.trim()) {
      return 'client "opencode" with API key auth requires an OpenCode Provider name (e.g. anthropic, openai, maas)';
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
