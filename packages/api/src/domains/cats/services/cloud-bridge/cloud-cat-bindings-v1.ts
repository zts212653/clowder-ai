/**
 * F247 Workspace Agent (slice 1): versioned cloud cat bindings.
 *
 * Legacy `cloudCatBindings[catId]` values are plain ChatGPT conversation URL
 * strings owned by the Personal Chrome Host path. The Workspace Agent path
 * introduces a second provider whose outbound continuity lives on the provider
 * side (stable conversation_key), so a binding now records WHICH provider owns
 * the route instead of only WHERE to append.
 *
 * Migration contract:
 *  - Reads normalize legacy strings to `{v:1, provider:'personal-chrome-host'}`
 *    without rewriting persisted state (read-time migration only).
 *  - Unknown versions / providers / malformed URLs fail closed (null), never
 *    guessed — a corrupt binding must degrade to "needs binding", not route
 *    an outbound dispatch through the wrong provider.
 */

const CHATGPT_CHAT_URL_REGEX = /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+\/?$/;

export type CloudCatBindingV1 =
  | {
      readonly v: 1;
      readonly provider: 'personal-chrome-host';
      readonly conversationUrl: string;
    }
  | {
      readonly v: 1;
      readonly provider: 'workspace-agent';
      readonly workspaceId: string;
      readonly triggerId: string;
      /**
       * Owner-only recovery anchor from the dispatch 202 boundary. Lives in
       * the local-only binding sidecar (never the shared receipt / default
       * thread context / export) and is never a Personal Chrome route.
       */
      readonly conversationUrl?: string;
    };

export const CLOUD_CAT_BINDING_PROVIDERS = ['personal-chrome-host', 'workspace-agent'] as const;

function isBoundedNonEmpty(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

export function isCloudCatBindingV1(value: unknown): value is CloudCatBindingV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  if (binding.v !== 1) return false;
  if (binding.provider === 'personal-chrome-host') {
    return (
      Object.keys(binding).length === 3 &&
      typeof binding.conversationUrl === 'string' &&
      CHATGPT_CHAT_URL_REGEX.test(binding.conversationUrl)
    );
  }
  if (binding.provider === 'workspace-agent') {
    const keyCount = Object.keys(binding).length;
    const hasOptionalUrl = typeof binding.conversationUrl === 'string';
    if (keyCount !== (hasOptionalUrl ? 5 : 4)) return false;
    if (!isBoundedNonEmpty(binding.workspaceId, 256) || !isBoundedNonEmpty(binding.triggerId, 256)) return false;
    return !hasOptionalUrl || CHATGPT_CHAT_URL_REGEX.test(binding.conversationUrl as string);
  }
  return false;
}

/**
 * Normalize one persisted binding value (legacy string or versioned object)
 * to CloudCatBindingV1. Returns null for anything unrecognized — callers
 * treat null as "no usable binding" (needs-binding fallback), which is the
 * existing legacy behavior for stale/invalid URLs.
 */
export function normalizeCloudCatBinding(value: unknown): CloudCatBindingV1 | null {
  if (typeof value === 'string') {
    if (CHATGPT_CHAT_URL_REGEX.test(value)) {
      return { v: 1, provider: 'personal-chrome-host', conversationUrl: value };
    }
    // Redis-backed stores persist entries as JSON strings — decode them so
    // string and object storage read identically after normalization.
    if (value.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(value);
        return isCloudCatBindingV1(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }
  return isCloudCatBindingV1(value) ? value : null;
}

/**
 * Normalize a whole `cloudCatBindings` record. Keys without a usable binding
 * are dropped (mirrors the legacy read behavior of regex-validating each URL).
 */
export function normalizeCloudCatBindings(
  record: Record<string, unknown> | null | undefined,
): Record<string, CloudCatBindingV1> {
  const normalized: Record<string, CloudCatBindingV1> = {};
  if (!record || typeof record !== 'object') return normalized;
  for (const [catId, value] of Object.entries(record)) {
    const binding = normalizeCloudCatBinding(value);
    if (binding) normalized[catId] = binding;
  }
  return normalized;
}
