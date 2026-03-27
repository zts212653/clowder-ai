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

const NPM_ADAPTER_FOR_API_TYPE: Record<string, string> = {
  openai: '@ai-sdk/openai-compatible',
  anthropic: '@ai-sdk/anthropic',
  google: '@ai-sdk/google',
};

export interface OpenCodeRuntimeConfigOptions {
  providerName: string;
  models: readonly string[];
  defaultModel?: string;
  apiType?: 'openai' | 'anthropic' | 'google';
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

export function writeOpenCodeRuntimeConfig(
  projectRoot: string,
  catId: string,
  invocationId: string,
  options: OpenCodeRuntimeConfigOptions,
): string {
  const configDir = join(projectRoot, '.cat-cafe');
  mkdirSync(configDir, { recursive: true });
  const safeCatId = sanitizePathSegment(catId);
  const safeInvocationId = sanitizePathSegment(invocationId);
  const configPath = join(configDir, `opencode-runtime-${safeCatId}-${safeInvocationId}.json`);
  const tempPath = `${configPath}.tmp-${process.pid}`;
  const config = generateOpenCodeRuntimeConfig(options);
  writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tempPath, configPath);
  return configPath;
}
