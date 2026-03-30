import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * opencode Config Template Generator
 * Generates opencode.json configuration for Cat Cafe runtime.
 *
 * opencode reads its config from opencode.json (per-project or ~/.config/opencode/).
 * This generator produces a config with:
 * - Anthropic provider (via proxy)
 * - Optional OMOC plugin (oh-my-opencode)
 * - No Cat Cafe MCP tools (isolation by design)
 */

interface OpenCodeConfigOptions {
  /** Anthropic API key — validated but NOT written to config (stays in ANTHROPIC_API_KEY env var) */
  apiKey: string;
  /** Base URL for Anthropic API (passed through as configured) */
  baseUrl: string;
  /** Model name (e.g. 'claude-sonnet-4-6' or 'openrouter/google/gemini-3-flash-preview') */
  model: string;
  /** Enable Oh My OpenCode plugin (default: true) */
  enableOmoc?: boolean;
}

type OpenCodeProviderConfig = {
  npm?: string;
  models?: Record<string, { name: string }>;
  options: {
    apiKey?: string;
    baseURL?: string;
  };
};

interface OpenCodeConfig {
  $schema: string;
  model?: string;
  provider: Record<string, OpenCodeProviderConfig>;
  plugin?: string[];
  mcp?: Record<string, unknown>;
}

export function generateOpenCodeConfig(options: OpenCodeConfigOptions): OpenCodeConfig {
  const { baseUrl, model, enableOmoc = true } = options;

  const config: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    model,
    provider: {
      anthropic: {
        options: {
          baseURL: baseUrl,
        },
      },
    },
  };

  if (enableOmoc) {
    config.plugin = ['oh-my-opencode'];
  }

  return config;
}

export const OC_API_KEY_ENV = 'CAT_CAFE_OC_API_KEY';
export const OC_BASE_URL_ENV = 'CAT_CAFE_OC_BASE_URL';

/**
 * OpenCode API type determines which AI SDK npm adapter to use.
 * - 'openai'           → @ai-sdk/openai-compatible  (chat/completions, default for custom providers)
 * - 'openai-responses'  → @ai-sdk/openai             (responses API, for official OpenAI endpoints)
 * - 'anthropic'         → @ai-sdk/anthropic
 * - 'google'            → @ai-sdk/google
 */
export type OpenCodeApiType = 'openai' | 'openai-responses' | 'anthropic' | 'google';

const NPM_ADAPTER_FOR_API_TYPE: Record<string, string> = {
  openai: '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai',
  anthropic: '@ai-sdk/anthropic',
  google: '@ai-sdk/google',
};

/**
 * Derive the OpenCode API type from member authentication configuration.
 *
 * Priority: explicit account protocol > ocProviderName heuristic > default 'openai'.
 * This aligns with the product rule: derive apiType from the member's bound account,
 * not from the client type.
 */
export function deriveOpenCodeApiType(
  protocol: string | undefined,
  ocProviderName: string | undefined,
): OpenCodeApiType {
  // Explicit protocol always wins
  if (protocol) {
    if (protocol === 'anthropic') return 'anthropic';
    if (protocol === 'google') return 'google';
    if (protocol === 'openai-responses') return 'openai-responses';
    return 'openai';
  }
  // Fallback: infer from ocProviderName when protocol is not declared
  if (ocProviderName === 'anthropic') return 'anthropic';
  if (ocProviderName === 'google') return 'google';
  return 'openai';
}

export interface OpenCodeRuntimeConfigOptions {
  providerName: string;
  models: readonly string[];
  defaultModel?: string;
  apiType?: OpenCodeApiType;
  hasBaseUrl?: boolean;
}

export function parseOpenCodeModel(model: string): { providerName: string; modelName: string } | null {
  const trimmed = model.trim();
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) return null;
  return {
    providerName: trimmed.slice(0, slashIndex),
    modelName: trimmed.slice(slashIndex + 1),
  };
}

function stripOwnProviderPrefix(modelName: string, providerName: string): string {
  const prefix = `${providerName}/`;
  return modelName.startsWith(prefix) ? modelName.slice(prefix.length) : modelName;
}

export function generateOpenCodeRuntimeConfig(options: OpenCodeRuntimeConfigOptions): OpenCodeConfig {
  const { providerName, models, defaultModel, apiType = 'openai', hasBaseUrl = false } = options;

  const modelsMap: Record<string, { name: string }> = {};
  for (const rawModel of models) {
    const modelName = stripOwnProviderPrefix(rawModel, providerName);
    modelsMap[modelName] = { name: modelName };
  }

  return {
    $schema: 'https://opencode.ai/config.json',
    ...(defaultModel ? { model: defaultModel } : {}),
    provider: {
      [providerName]: {
        npm: NPM_ADAPTER_FOR_API_TYPE[apiType] ?? NPM_ADAPTER_FOR_API_TYPE.openai,
        models: modelsMap,
        options: {
          ...(hasBaseUrl ? { baseURL: `{env:${OC_BASE_URL_ENV}}` } : {}),
          apiKey: `{env:${OC_API_KEY_ENV}}`,
        },
      },
    },
  };
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/**
 * Writes a per-invocation opencode config directory.
 * opencode reads config from `OPENCODE_CONFIG_DIR/opencode.json` when the
 * `OPENCODE_CONFIG_DIR` env var is set, overriding the default user config dir.
 * Returns the **directory** path (set it as `OPENCODE_CONFIG_DIR`).
 */
export function writeOpenCodeRuntimeConfig(
  projectRoot: string,
  catId: string,
  invocationId: string,
  options: OpenCodeRuntimeConfigOptions,
): string {
  const safeCatId = sanitizePathSegment(catId);
  const safeInvocationId = sanitizePathSegment(invocationId);
  const configDir = join(projectRoot, '.cat-cafe', `oc-config-${safeCatId}-${safeInvocationId}`);
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'opencode.json');
  const tempPath = `${configPath}.tmp-${process.pid}`;
  const config = generateOpenCodeRuntimeConfig(options);
  writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tempPath, configPath);
  return configDir;
}
