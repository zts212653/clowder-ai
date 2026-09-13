import { extractUserEnvTemplates, hasSupportedEnvTemplate, resolveEnvMap } from '../env-map.js';
import { isDshHarnessCommand } from './dsh-acp-bootstrap.js';
import { isZcodeHarnessCommand } from './zcode-acp-bootstrap.js';

export interface AcpProcessEnvAccount {
  id: string;
  authType: 'oauth' | 'api_key';
  apiKey?: string;
  baseUrl?: string;
  envVars?: Record<string, string>;
}

export interface PrepareAcpProcessEnvOptions {
  clientId: string;
  provider?: string | null;
  /** Original ACP command (`acp.command`), not the rewritten spawn argv. */
  command?: string | null;
  baseModel?: string;
  account?: AcpProcessEnvAccount | null;
}

export type TryPrepareAcpProcessEnvResult =
  | { ok: true; env: Record<string, string> | undefined }
  | { ok: false; error: Error };

export function prepareAcpProcessEnv(options: PrepareAcpProcessEnvOptions): Record<string, string> | undefined {
  const account = options.account ?? null;
  const resolved: Record<string, string> = {};

  if (account?.authType === 'api_key') {
    if (!account.apiKey) {
      throw new Error(
        `account "${account.id}" is configured as api_key but has no API key set — ` +
          'add the key in Hub > account settings',
      );
    }
    const userEnvTemplates = account.envVars ? extractUserEnvTemplates(account.envVars) : undefined;
    // F161 AC-A5 / KD-1: generic ACP is a transport. Catalog `provider` is stripped on
    // save, so harness env-maps must come from the ACP command identity (zcode/grok/dsh),
    // never from a leftover provider field. Ordinary ACP commands stay envVars-only.
    const envMapProvider =
      options.clientId === 'acp' ? resolveAcpHarnessEnvMap(options.command) : (options.provider ?? undefined);
    Object.assign(
      resolved,
      resolveEnvMap(
        options.clientId,
        envMapProvider,
        { apiKey: account.apiKey, baseUrl: account.baseUrl, baseModel: options.baseModel },
        userEnvTemplates,
      ),
    );
  }

  const validEnvKey = /^[A-Z_][A-Za-z0-9_]*$/;
  if (account?.envVars) {
    for (const [key, value] of Object.entries(account.envVars)) {
      if (!validEnvKey.test(key) || key.startsWith('CAT_CAFE_')) continue;
      if (hasSupportedEnvTemplate(value)) continue;
      resolved[key] = value;
    }
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveAcpHarnessEnvMap(command: string | null | undefined): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) return undefined;
  if (isZcodeHarnessCommand(trimmed)) return 'zcode';
  if (isDshHarnessCommand(trimmed)) return 'deepseek';
  if (isGrokHarnessCommand(trimmed)) return 'xai';
  return undefined;
}

function isGrokHarnessCommand(command: string): boolean {
  const trimmed = command.trim();
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).replace(/\.(cjs|js|mjs|exe|cmd|bat)$/i, '');
  return base === 'grok';
}

export function tryPrepareAcpProcessEnv(options: PrepareAcpProcessEnvOptions): TryPrepareAcpProcessEnvResult {
  try {
    return { ok: true, env: prepareAcpProcessEnv(options) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
