import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { prepareAcpProcessEnv } from '../../domains/cats/services/agents/providers/acp/acp-spawn-env.js';
import { resolveKimiRuntimePaths } from '../../utils/kimi-cli-runtime.js';
import { type RuntimeProviderProfile, resolveForClient } from '../account-resolver.js';
import { inspectKimiNativeLaunch, type KimiNativeLaunch } from './kimi-installation.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
async function boundedText(path: string, optional = false): Promise<string> {
  try {
    if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('native_config_too_large');
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('native_config_too_large');
    return text;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export interface KimiNativeAccount {
  readonly profile: RuntimeProviderProfile;
  readonly home: string;
  readonly configPath: string;
  readonly modelAlias: string;
  readonly model: string;
  readonly accountEnv: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly foreignServers: readonly string[];
}

/** Current native OAuth is referenced in place. No token, login, default or account is written. */
export async function readKimiNativeAccount(
  native: KimiNativeLaunch,
  modelAlias: string,
  accountRef = native.accountRef,
): Promise<KimiNativeAccount> {
  try {
    if (inspectKimiNativeLaunch(native)?.packagePath !== native.packagePath) throw new Error('native_changed');
    const profile = resolveForClient(native.projectRoot, 'kimi', accountRef);
    if (!profile || profile.syntheticNative || profile.authType !== 'oauth') throw new Error('native_oauth_required');
    const accountEnv = prepareAcpProcessEnv({ clientId: 'kimi', account: profile }) ?? {};
    if (Object.keys(accountEnv).some((key) => /(?:API_KEY|TOKEN|^KIMI_MODEL_|^NODE_OPTIONS$|^NODE_PATH$)/.test(key)))
      throw new Error('native_oauth_override');
    const env: Record<string, string> = {};
    for (const key of [
      'HOME',
      'USERPROFILE',
      'PATH',
      'LANG',
      'LC_ALL',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'NODE_EXTRA_CA_CERTS',
      'KIMI_CODE_HOME',
      'KIMI_CODE_BASE_URL',
      'KIMI_CODE_OAUTH_HOST',
      'KIMI_OAUTH_HOST',
    ]) {
      const value = accountEnv[key] ?? native.env[key] ?? process.env[key];
      if (value) env[key] = value;
    }
    env.HOME ??= homedir();
    const paths = resolveKimiRuntimePaths(env);
    env.KIMI_CODE_HOME = paths.shareDir;
    const configText = await boundedText(paths.configPath);
    // Scoped ACP installs a sole-MCP tool allowlist. Global Shell hooks can
    // belong to another Host checkout and are preserved with the native config.
    const config = parse(configText),
      model = record(record(config.models)[modelAlias]);
    if (typeof model.provider !== 'string' || typeof model.model !== 'string') throw new Error('native_model_missing');
    const provider = record(record(config.providers)[model.provider]),
      oauth = record(provider.oauth);
    if (
      provider.type !== 'kimi' ||
      oauth.storage !== 'file' ||
      typeof oauth.key !== 'string' ||
      !oauth.key ||
      (typeof provider.api_key === 'string' && provider.api_key.trim()) ||
      provider.api_key_env !== undefined
    )
      throw new Error('native_oauth_route_unavailable');
    const mcpText = await boundedText(join(paths.shareDir, 'mcp.json'), true);
    const mcp = mcpText ? record(JSON.parse(mcpText)) : {};
    const foreignServers = Object.keys(record(mcp.mcpServers ?? mcp.servers));
    const nativeSourceRevision = createHash('sha256')
      .update(
        JSON.stringify({
          configText,
          mcpText,
          env,
          modelAlias,
          packagePath: native.packagePath,
        }),
      )
      .digest('hex');
    return Object.freeze({
      profile: Object.freeze({ ...profile, nativeSourceRevision }),
      home: paths.shareDir,
      configPath: paths.configPath,
      modelAlias,
      model: model.model,
      accountEnv: Object.freeze({ ...accountEnv }),
      env: Object.freeze(env),
      foreignServers: Object.freeze(foreignServers),
    });
  } catch {
    throw new Error('kimi_native_account_unavailable');
  }
}
