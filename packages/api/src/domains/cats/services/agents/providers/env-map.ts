/**
 * F161: Template-based environment variable mapping for agent subprocess injection.
 *
 * Design: Internal canonical variables (${api_key}, ${base_url}) are mapped to
 * provider-specific env var names via templates. Known clients have built-in
 * mappings; unknown clients use user-configured templates from account/member envVars.
 *
 * Resolution priority:
 *   1. User-defined env map (from account/member envVars with ${...} templates)
 *   2. Built-in map by provider name (for opencode multi-provider routing)
 *   3. Built-in map by clientId (for direct-provider clients like anthropic/google)
 *   4. Empty (OAuth / self-managed credential — no injection needed)
 */

/** Internal canonical variable names available in templates */
export type EnvTemplateVariable = 'api_key' | 'base_url' | 'base_model' | 'model';

/** Template pattern: ${variable_name} */
const TEMPLATE_RE = /\$\{(\w+)\}/g;
const SUPPORTED_TEMPLATE_VARIABLES = new Set<string>(['api_key', 'base_url', 'base_model', 'model']);

/** Valid env key pattern (F171 parity: same as accountEnv sanitizer) */
const VALID_ENV_KEY = /^[A-Z_][A-Za-z0-9_]*$/;

/**
 * These direct-provider maps intentionally set OPENROUTER_API_KEY for OpenCode
 * routing compatibility. This is an alias, not provider identity conversion.
 */
export const OPENROUTER_COMPAT_ENV_ALIAS_CLIENTS = ['openai', 'google'] as const;
const OPENROUTER_API_KEY_TEMPLATE = '${api_key}';

/**
 * Built-in env mappings for known clients/providers.
 * Key = clientId or provider name.
 * Value = { TARGET_ENV_VAR: '${canonical_var}' }
 */
export const BUILTIN_ENV_MAPS: Record<string, Record<string, string>> = {
  anthropic: {
    ANTHROPIC_API_KEY: '${api_key}',
    ANTHROPIC_BASE_URL: '${base_url}',
  },
  openai: {
    OPENAI_API_KEY: '${api_key}',
    OPENROUTER_API_KEY: OPENROUTER_API_KEY_TEMPLATE,
    OPENAI_BASE_URL: '${base_url}',
    OPENAI_API_BASE: '${base_url}', // Legacy alias for older SDKs
  },
  google: {
    GEMINI_API_KEY: '${api_key}',
    GOOGLE_API_KEY: '${api_key}',
    OPENROUTER_API_KEY: OPENROUTER_API_KEY_TEMPLATE,
    GEMINI_BASE_URL: '${base_url}',
  },
  opencode: {
    OPENCODE_API_KEY: '${api_key}',
    OPENCODE_BASE_URL: '${base_url}',
  },
  openrouter: {
    OPENROUTER_API_KEY: OPENROUTER_API_KEY_TEMPLATE,
  },
  kimi: {
    MOONSHOT_API_KEY: '${api_key}',
  },
};

export interface EnvMapAccount {
  apiKey?: string;
  baseUrl?: string;
  baseModel?: string;
}

/**
 * Resolve env vars to inject into a subprocess, using template variable substitution.
 *
 * @param clientId - The client identity (e.g. 'opencode', 'google', 'acp')
 * @param provider - Optional backend provider name (for multi-provider CLIs like opencode)
 * @param account - Resolved account with API key / base URL
 * @param userEnvMap - User-configured env vars (may contain ${api_key} / ${base_url} / ${base_model} templates)
 * @returns Resolved env vars ready for subprocess injection. Empty values are omitted.
 */
export function resolveEnvMap(
  clientId: string,
  provider: string | undefined,
  account: EnvMapAccount | undefined,
  userEnvMap?: Record<string, string>,
): Record<string, string> {
  if (!account) return {};

  // Priority: user-defined > provider built-in > clientId built-in > empty
  const template = pickTemplate(clientId, provider, userEnvMap);
  if (!template || Object.keys(template).length === 0) return {};

  const vars: Record<string, string> = {
    api_key: account.apiKey ?? '',
    base_url: account.baseUrl ?? '',
    base_model: account.baseModel ?? '',
    model: account.baseModel ?? '',
  };

  const result: Record<string, string> = {};
  for (const [envKey, tmpl] of Object.entries(template)) {
    // Sanitize: reject reserved prefix and malformed key names (F171 parity)
    if (envKey.startsWith('CAT_CAFE_') || !VALID_ENV_KEY.test(envKey)) continue;
    const resolved = tmpl.replace(TEMPLATE_RE, (placeholder: string, name: string) =>
      SUPPORTED_TEMPLATE_VARIABLES.has(name) ? (vars[name as EnvTemplateVariable] ?? '') : placeholder,
    );
    // Only inject non-empty values — empty means the account doesn't have that field
    if (resolved) {
      result[envKey] = resolved;
    }
  }
  return result;
}

export function hasSupportedEnvTemplate(value: string): boolean {
  TEMPLATE_RE.lastIndex = 0;
  for (const match of value.matchAll(TEMPLATE_RE)) {
    if (SUPPORTED_TEMPLATE_VARIABLES.has(match[1])) {
      TEMPLATE_RE.lastIndex = 0;
      return true;
    }
  }
  TEMPLATE_RE.lastIndex = 0;
  return false;
}

/**
 * Extract template entries from user-defined envVars.
 * Returns only entries that contain supported Clowder AI credential templates.
 * Non-template entries are pass-through (handled separately by accountEnv).
 */
export function extractUserEnvTemplates(
  userEnvVars: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!userEnvVars) return undefined;
  const templates: Record<string, string> = {};
  let hasTemplates = false;
  for (const [key, value] of Object.entries(userEnvVars)) {
    if (hasSupportedEnvTemplate(value)) {
      templates[key] = value;
      hasTemplates = true;
    }
  }
  return hasTemplates ? templates : undefined;
}

/**
 * Build the effective template map by merging built-in + user templates.
 * User templates extend/override built-in entries (same key → user wins),
 * but do NOT replace the entire built-in map (P2 fix: merge, not replace).
 */
function pickTemplate(
  clientId: string,
  provider: string | undefined,
  userEnvMap?: Record<string, string>,
): Record<string, string> | undefined {
  // Built-in base: provider name > clientId > empty
  const builtinMap = (provider && BUILTIN_ENV_MAPS[provider]) || BUILTIN_ENV_MAPS[clientId] || undefined;

  // User-defined templates: merge on top of built-in (user keys override same-name built-in)
  const userTemplates = extractUserEnvTemplates(userEnvMap);
  if (userTemplates && builtinMap) {
    return { ...builtinMap, ...userTemplates };
  }
  // Only user templates (unknown client with custom env) or only built-in
  return userTemplates ?? builtinMap;
}
