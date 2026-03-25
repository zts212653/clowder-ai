/**
 * opencode Config Template Generator
 * Generates opencode.json configuration for Cat Cafe runtime.
 *
 * opencode reads its config from opencode.json (per-project or ~/.config/opencode/).
 * This generator produces a config with:
 * - Anthropic provider (via proxy) — legacy builtin-only path
 * - Custom provider support via OPENCODE_CONFIG env var + {env:VAR} credential injection
 * - Optional OMOC plugin (oh-my-opencode)
 * - No Cat Cafe MCP tools (isolation by design)
 *
 * Custom provider flow (F189):
 *   1. invoke-single-cat.ts calls writeOpenCodeRuntimeConfig() before each invoke
 *   2. Config written to {projectRoot}/.cat-cafe/opencode-runtime-{catId}.json
 *   3. OPENCODE_CONFIG env var points to the file
 *   4. Credentials injected via {env:CAT_CAFE_OC_API_KEY} / {env:CAT_CAFE_OC_BASE_URL}
 *   5. Per-catId files isolate multiple opencode members in the same session
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Legacy builtin-only config (Anthropic provider) ──────────────────────

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

interface OpenCodeConfig {
  $schema: string;
  model?: string;
  provider: Record<string, unknown>;
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

// ── Custom provider runtime config (F189) ────────────────────────────────

/** Env var names injected into the child process for {env:VAR} substitution. */
export const OC_API_KEY_ENV = 'CAT_CAFE_OC_API_KEY';
export const OC_BASE_URL_ENV = 'CAT_CAFE_OC_BASE_URL';

/**
 * Maps our api type shorthand to the npm package name expected by opencode.
 * opencode uses Vercel AI SDK adapters — the `npm` field in provider config
 * specifies which adapter to load.
 *
 * @see https://opencode.ai/docs/providers
 */
const NPM_ADAPTER_FOR_API_TYPE: Record<string, string> = {
  openai: '@ai-sdk/openai-compatible',
  anthropic: '@ai-sdk/anthropic',
  google: '@ai-sdk/google',
};

export interface OpenCodeRuntimeConfigOptions {
  /** Provider name as registered in opencode (e.g. "maas", "deepseek") */
  providerName: string;
  /** Model names available on this provider (e.g. ["glm-5", "glm-4-plus"]) */
  models: readonly string[];
  /** Full model string for the default model (e.g. "maas/glm-5") */
  defaultModel?: string;
  /** API SDK type: which wire protocol the endpoint speaks (default: "openai") */
  apiType?: 'openai' | 'anthropic' | 'google';
  /** Whether a base URL will be provided via env var (controls baseURL in config) */
  hasBaseUrl?: boolean;
}

/**
 * Generate an opencode runtime config object for a custom provider.
 * Credentials use {env:VAR} substitution — actual values are passed via child process env.
 *
 * Config shape follows official opencode format:
 *   provider.<id>.npm   — Vercel AI SDK adapter package
 *   provider.<id>.models — keyed object { modelId: { name } }
 *   provider.<id>.options — { baseURL, apiKey } with {env:VAR} substitution
 *
 * @see https://opencode.ai/docs/providers
 * @see https://opencode.ai/docs/models
 */
export function generateOpenCodeRuntimeConfig(options: OpenCodeRuntimeConfigOptions): OpenCodeConfig {
  const { providerName, models, defaultModel, apiType = 'openai', hasBaseUrl = false } = options;

  // models: keyed object where key = model ID used in `-m provider/modelId`
  const modelsMap: Record<string, { name: string }> = {};
  for (const modelName of models) {
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

/**
 * Parse "providerName/modelName" from a model string.
 * Returns null if the model string does not contain a provider prefix.
 */
export function parseOpenCodeModel(model: string): { providerName: string; modelName: string } | null {
  const trimmed = model.trim();
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) return null;
  return {
    providerName: trimmed.slice(0, slashIndex),
    modelName: trimmed.slice(slashIndex + 1),
  };
}

/**
 * Write an opencode runtime config file for a specific cat member.
 * Returns the absolute path to the written config file.
 *
 * File location: {projectRoot}/.cat-cafe/opencode-runtime-{catId}.json
 * Regenerated before each invoke to pick up mid-session config changes.
 */
export function writeOpenCodeRuntimeConfig(
  projectRoot: string,
  catId: string,
  options: OpenCodeRuntimeConfigOptions,
): string {
  const configDir = join(projectRoot, '.cat-cafe');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, `opencode-runtime-${catId}.json`);
  const config = generateOpenCodeRuntimeConfig(options);
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return configPath;
}
