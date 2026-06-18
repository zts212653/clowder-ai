import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

type OpenCodePermissionAction = 'allow' | 'ask' | 'deny';

interface OpenCodeConfig {
  $schema: string;
  model?: string;
  small_model?: string;
  provider: Record<string, OpenCodeProviderConfig>;
  plugin?: string[];
  mcp?: Record<string, unknown>;
  /** Instruction file paths for native L0 injection (compression-immune system role). */
  instructions?: string[];
  /** OpenCode permission grants for directories outside the working directory. */
  permission?: {
    external_directory?: Record<string, OpenCodePermissionAction>;
  };
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
  /**
   * Native-auth OpenCode accounts (OAuth/subscription) must not receive
   * provider auth placeholders that point at unset CAT_CAFE_OC_* env vars.
   */
  omitProviderAuth?: boolean;
  /** Absolute path to Clowder AI MCP server entry (packages/mcp-server/dist/index.js). */
  mcpServerPath?: string;
  /**
   * F203 Phase I: Instruction file paths injected into OpenCode's `instructions` config.
   * These are loaded by OpenCode every turn into `role: "system"` messages — compression-immune.
   * Typical contents: [compiledL0Path, "OPENCODE.md"].
   */
  instructions?: readonly string[];
  /**
   * #935: Directories outside the OpenCode working directory that should be
   * granted `permission.external_directory` access. Typically includes the
   * Cat Cafe host project root when the thread's working directory is external.
   */
  externalDirectories?: readonly string[];
}

export interface OpenCodeRuntimeConfigDebugSummary {
  model?: string;
  smallModel?: string;
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

function buildExternalDirectoryPermissions(
  externalDirectories?: readonly string[],
): Record<string, OpenCodePermissionAction> | undefined {
  const rules: Record<string, OpenCodePermissionAction> = {};
  for (const directory of externalDirectories ?? []) {
    const normalized = directory.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized) rules[`${normalized}/**`] = 'allow';
  }
  return Object.keys(rules).length > 0 ? rules : undefined;
}

export function generateOpenCodeRuntimeConfig(options: OpenCodeRuntimeConfigOptions): OpenCodeConfig {
  const {
    providerName,
    models,
    defaultModel,
    apiType = 'openai',
    hasBaseUrl = false,
    omitProviderAuth = false,
    mcpServerPath,
    instructions,
    externalDirectories,
  } = options;

  const configName = safeProviderName(providerName);

  const modelsMap: Record<string, { name: string }> = {};
  const modelsToRegister = defaultModel ? [...models, defaultModel] : [...models];
  for (const rawModel of modelsToRegister) {
    const modelName = stripOwnProviderPrefix(rawModel, providerName);
    modelsMap[modelName] = { name: modelName };
  }

  let configDefaultModel = defaultModel;
  if (configName !== providerName && defaultModel?.startsWith(`${providerName}/`)) {
    configDefaultModel = `${configName}/${defaultModel.slice(providerName.length + 1)}`;
  }

  const config: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    ...(configDefaultModel ? { model: configDefaultModel, small_model: configDefaultModel } : {}),
    provider: {
      [configName]: {
        npm: NPM_ADAPTER_FOR_API_TYPE[apiType] ?? NPM_ADAPTER_FOR_API_TYPE.openai,
        models: modelsMap,
        options: {
          ...(!omitProviderAuth && hasBaseUrl ? { baseURL: `{env:${OC_BASE_URL_ENV}}` } : {}),
          ...(!omitProviderAuth ? { apiKey: `{env:${OC_API_KEY_ENV}}` } : {}),
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

  // F203 Phase I: inject compiled L0 + OPENCODE.md paths into instructions.
  // OpenCode merges instructions across config layers (concat + dedup),
  // so these are additive to any project-root opencode.json instructions.
  if (instructions && instructions.length > 0) {
    config.instructions = [...instructions];
  }

  // #935: Grant external_directory permission for Clowder-approved workspace roots.
  // Without this, OpenCode on Windows rejects tool calls that touch paths outside
  // the working directory, forcing users to edit global config manually.
  const externalDirectoryPermissions = buildExternalDirectoryPermissions(externalDirectories);
  if (externalDirectoryPermissions) {
    config.permission = {
      external_directory: externalDirectoryPermissions,
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
    smallModel: config.small_model,
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
 * F203 Phase I: Write an instructions-only opencode config (no provider block).
 *
 * Used for OpenCode fallback paths (subscription/unresolved/known-model) where
 * a full runtime config is not generated. The config ONLY contains `instructions`
 * so OpenCode reads L0 + OPENCODE.md into system role. No provider/apiKey fields
 * → `buildEnv` must NOT clear native auth when this config is set.
 *
 * Callers must also set `CAT_CAFE_OC_INSTRUCTIONS_ONLY=1` in callbackEnv so
 * `OpenCodeAgentService.buildEnv` knows to preserve native auth.
 */
export function writeOpenCodeInstructionsOnlyConfig(
  projectRoot: string,
  catId: string,
  invocationId: string,
  instructions: readonly string[],
  externalDirectories?: readonly string[],
): string {
  const safeCatId = sanitizePathSegment(catId);
  const safeInvocationId = sanitizePathSegment(invocationId);
  const configDir = join(projectRoot, '.cat-cafe', `oc-config-${safeCatId}-${safeInvocationId}`);
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'opencode.json');
  const tempPath = `${configPath}.tmp-${process.pid}`;
  const config: Pick<OpenCodeConfig, '$schema' | 'instructions' | 'permission'> = {
    $schema: 'https://opencode.ai/config.json',
    instructions: [...instructions],
  };
  const externalDirectoryPermissions = buildExternalDirectoryPermissions(externalDirectories);
  if (externalDirectoryPermissions) {
    config.permission = { external_directory: externalDirectoryPermissions };
  }
  writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tempPath, configPath);
  return configPath;
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
