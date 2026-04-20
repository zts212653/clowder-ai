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
 * - Optional Clowder AI MCP server (deterministic injection via mcpServerPath)
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
 * Derive the OpenCode API type from the member's provider name binding.
 *
 * Account-level protocol is no longer used — it was removed from the UI and
 * should not drive runtime routing. The sole authority is the provider name,
 * which the user explicitly sets in the member editor "Provider 名称" field.
 */
export function deriveOpenCodeApiType(providerName: string | undefined): OpenCodeApiType {
  const normalized = providerName?.toLowerCase();
  if (normalized === 'openai-responses') return 'openai-responses';
  if (normalized === 'anthropic') return 'anthropic';
  if (normalized === 'google') return 'google';
  return 'openai';
}

export interface OpenCodeRuntimeConfigOptions {
  providerName: string;
  models: readonly string[];
  defaultModel?: string;
  apiType?: OpenCodeApiType;
  hasBaseUrl?: boolean;
  /** Absolute path to Clowder AI MCP server entry (packages/mcp-server/dist/index.js). */
  mcpServerPath?: string;
}

export interface OpenCodeRuntimeConfigDebugSummary {
  model?: string;
  providerKeys: string[];
  providerSummary: Record<
    string,
    {
      npm?: string;
      modelKeys: string[];
      hasBaseUrl: boolean;
      apiKeySource: string;
      baseUrlSource?: string;
    }
  >;
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

/**
 * OpenCode treats certain provider names as built-in and forces its own SDK
 * handling (e.g. 'openai' → Responses API via sdk.responses()), ignoring the
 * npm adapter field.  Remap these names so the config's npm adapter is used.
 *
 * Only 'openai' needs remapping: its builtin forces Responses-style routing
 * that conflicts with Chat Completions proxies. 'anthropic' and 'google'
 * builtins already match the intended SDK adapter, so no remap needed.
 */
const OPENCODE_BUILTIN_NAMES = new Set(['openai']);

export function safeProviderName(name: string): string {
  return OPENCODE_BUILTIN_NAMES.has(name) ? `${name}-compat` : name;
}

export function generateOpenCodeRuntimeConfig(options: OpenCodeRuntimeConfigOptions): OpenCodeConfig {
  const { providerName, models, defaultModel, apiType = 'openai', hasBaseUrl = false, mcpServerPath } = options;

  const configName = safeProviderName(providerName);

  const modelsMap: Record<string, { name: string }> = {};
  for (const rawModel of models) {
    const modelName = stripOwnProviderPrefix(rawModel, providerName);
    modelsMap[modelName] = { name: modelName };
  }

  let configDefaultModel = defaultModel;
  if (configName !== providerName && defaultModel?.startsWith(`${providerName}/`)) {
    configDefaultModel = `${configName}/${defaultModel.slice(providerName.length + 1)}`;
  }

  const config: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    ...(configDefaultModel ? { model: configDefaultModel } : {}),
    provider: {
      [configName]: {
        npm: NPM_ADAPTER_FOR_API_TYPE[apiType] ?? NPM_ADAPTER_FOR_API_TYPE.openai,
        models: modelsMap,
        options: {
          ...(hasBaseUrl ? { baseURL: `{env:${OC_BASE_URL_ENV}}` } : {}),
          apiKey: `{env:${OC_API_KEY_ENV}}`,
        },
      },
    },
  };

  if (mcpServerPath) {
    config.mcp = {
      'cat-cafe': {
        type: 'local',
        command: ['node', mcpServerPath],
      },
    };
  }

  return config;
}

function summarizeEnvPlaceholder(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\{env:([^}]+)\}$/);
  return match ? `env:${match[1]}` : value;
}

export function summarizeOpenCodeRuntimeConfigForDebug(
  options: OpenCodeRuntimeConfigOptions,
): OpenCodeRuntimeConfigDebugSummary {
  const config = generateOpenCodeRuntimeConfig(options);
  const providerEntries = Object.entries(config.provider).sort(([a], [b]) => a.localeCompare(b));

  return {
    model: config.model,
    providerKeys: providerEntries.map(([providerName]) => providerName),
    providerSummary: Object.fromEntries(
      providerEntries.map(([providerName, providerConfig]) => [
        providerName,
        {
          npm: providerConfig.npm,
          modelKeys: Object.keys(providerConfig.models ?? {}).sort(),
          hasBaseUrl: Boolean(providerConfig.options.baseURL),
          apiKeySource: summarizeEnvPlaceholder(providerConfig.options.apiKey) ?? '(unset)',
          ...(providerConfig.options.baseURL
            ? { baseUrlSource: summarizeEnvPlaceholder(providerConfig.options.baseURL) }
            : {}),
        },
      ]),
    ),
  };
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/**
 * Writes a per-invocation opencode config file.
 * OpenCode's `OPENCODE_CONFIG` points to a config file path; `OPENCODE_CONFIG_DIR`
 * is reserved for the `.opencode/`-style config directory structure.
 * Returns the `opencode.json` file path (set it as `OPENCODE_CONFIG`).
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
  return configPath;
}
