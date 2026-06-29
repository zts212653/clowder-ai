import {
  deriveOpenCodeApiType,
  OC_API_KEY_ENV,
  OC_BASE_URL_ENV,
  type OpenCodeRuntimeConfigDebugSummary,
  parseOpenCodeModel,
  summarizeOpenCodeRuntimeConfigForDebug,
} from './opencode-config-template.js';
import { writeOpenCodeRuntimeConfig } from './opencode-config-writer.js';

export interface OpenCodeAcpSpawnAccount {
  id: string;
  authType: 'oauth' | 'api_key';
  apiKey?: string;
  baseUrl?: string;
  models?: readonly string[];
}

export interface OpenCodeAcpSpawnConfigOptions {
  projectRoot: string;
  profileId: string;
  clientId: string;
  providerName?: string | null;
  defaultModel?: string | null;
  account?: OpenCodeAcpSpawnAccount | null;
}

export interface PreparedOpenCodeAcpSpawnConfig {
  env: Record<string, string>;
  configPath: string;
  runtimeConfigSummary: OpenCodeRuntimeConfigDebugSummary;
}

// F161 cleanup: OpenCode managed config is opt-in via clientId='opencode' only.
// Generic ACP (clientId='acp') is NOT auto-upgraded by sniffing the command
// basename — a generic carrier that points at the opencode binary stays on the
// pure generic env path. This keeps the spawn-config path consistent with the
// env-map path, which already dropped command-based builtin inference.
function isOpenCodeAcpTarget(clientId: string): boolean {
  return clientId === 'opencode';
}

function resolveEffectiveOpenCodeModel(
  providerName: string | null | undefined,
  defaultModel: string | null | undefined,
): { providerName: string; model: string } | null {
  const modelProviderName = providerName?.trim() || undefined;
  const trimmedDefaultModel = defaultModel?.trim() || undefined;
  if (!trimmedDefaultModel) return null;

  const parsed = parseOpenCodeModel(trimmedDefaultModel);
  if (parsed) {
    if (modelProviderName && parsed.providerName !== modelProviderName) {
      return {
        providerName: modelProviderName,
        model: `${modelProviderName}/${trimmedDefaultModel}`,
      };
    }
    return {
      providerName: modelProviderName ?? parsed.providerName,
      model: trimmedDefaultModel,
    };
  }

  if (!modelProviderName) return null;
  return {
    providerName: modelProviderName,
    model: `${modelProviderName}/${trimmedDefaultModel}`,
  };
}

/**
 * Build the spawn-scoped OpenCode runtime config used by `opencode acp`.
 *
 * Unlike normal OpenCode invocations, ACP pools are long-lived processes, so this
 * intentionally excludes per-invocation instructions/MCP and only pins provider,
 * model, and credentials at process spawn time.
 */
export async function prepareOpenCodeAcpSpawnConfig(
  options: OpenCodeAcpSpawnConfigOptions,
): Promise<PreparedOpenCodeAcpSpawnConfig | null> {
  if (!isOpenCodeAcpTarget(options.clientId)) return null;

  const effective = resolveEffectiveOpenCodeModel(options.providerName, options.defaultModel);
  if (!effective) return null;

  const account = options.account ?? null;
  if (account?.authType === 'api_key' && !account.apiKey) {
    throw new Error(`account "${account.id}" is configured as api_key but has no API key set`);
  }

  const runtimeConfigOptions = {
    providerName: effective.providerName,
    models: account?.models?.length ? account.models : [effective.model],
    defaultModel: effective.model,
    apiType: deriveOpenCodeApiType(effective.providerName),
    hasBaseUrl: Boolean(account?.baseUrl),
    omitProviderAuth: account?.authType !== 'api_key',
  } as const;

  const configPath = await writeOpenCodeRuntimeConfig(
    options.projectRoot,
    options.profileId,
    'acp-pool',
    runtimeConfigOptions,
  );

  const env: Record<string, string> = { OPENCODE_CONFIG: configPath };
  if (account?.authType === 'api_key' && account.apiKey) {
    env[OC_API_KEY_ENV] = account.apiKey;
    if (account.baseUrl) env[OC_BASE_URL_ENV] = account.baseUrl;
  }

  return {
    env,
    configPath,
    runtimeConfigSummary: summarizeOpenCodeRuntimeConfigForDebug(runtimeConfigOptions),
  };
}
