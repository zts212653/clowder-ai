import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { ExecutionAccountSnapshot } from '@cat-cafe/shared';
import { parse } from 'smol-toml';
import { prepareAcpProcessEnv } from '../domains/cats/services/agents/providers/acp/acp-spawn-env.js';
import { resolveKimiRuntimePaths } from '../utils/kimi-cli-runtime.js';
import { resolveByAccountRef } from './account-resolver.js';

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 262_144;

const ALLOWED_LAUNCH_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'PATH',
  'LANG',
  'LC_ALL',
  'TERM',
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
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function hashCredentialFileIfSafe(shareDir: string, candidatePath: string): string | undefined {
  try {
    const resolved = resolve(candidatePath);
    const prefix = shareDir.endsWith(sep) ? shareDir : `${shareDir}${sep}`;
    if (!resolved.startsWith(prefix)) return undefined;
    if (!existsSync(resolved)) return undefined;
    const st = statSync(resolved);
    if (!st.isFile() || st.size > MAX_CREDENTIAL_BYTES) return undefined;
    return createHash('sha256').update(readFileSync(resolved)).digest('hex');
  } catch {
    return undefined;
  }
}

function inspectKimiOAuthCredentialVersion(
  shareDir: string,
  configPath: string,
  launchEnv: Readonly<Record<string, string>>,
): string | undefined {
  try {
    if (!existsSync(configPath)) return undefined;
    const st = statSync(configPath);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return undefined;
    const configText = readFileSync(configPath, 'utf8');
    if (Buffer.byteLength(configText) > MAX_CONFIG_BYTES) return undefined;
    const parsed = parse(configText);
    const providers = asRecord(parsed.providers);
    const oauthEntries: Array<{ providerId: string; key: string; credDigests: string[] }> = [];

    for (const [providerId, rawProvider] of Object.entries(providers).sort(([a], [b]) => a.localeCompare(b))) {
      const provider = asRecord(rawProvider);
      const oauth = asRecord(provider.oauth);
      if (
        provider.type !== 'kimi' ||
        oauth.storage !== 'file' ||
        typeof oauth.key !== 'string' ||
        !oauth.key.trim() ||
        (typeof provider.api_key === 'string' && provider.api_key.trim()) ||
        provider.api_key_env !== undefined
      ) {
        continue;
      }
      const key = oauth.key.trim();
      const candidates = [
        join(shareDir, key),
        join(shareDir, `${key}.json`),
        join(shareDir, 'credentials', `${basename(key)}.json`),
      ];
      const credDigests = [
        ...new Set(candidates.map((c) => hashCredentialFileIfSafe(shareDir, c)).filter(Boolean)),
      ] as string[];
      oauthEntries.push({ providerId, key, credDigests });
    }

    if (oauthEntries.length === 0) return undefined;

    return createHash('sha256')
      .update(
        JSON.stringify({
          shareDir,
          oauthEntries,
          baseUrl: launchEnv.KIMI_CODE_BASE_URL ?? '',
          oauthHost: launchEnv.KIMI_CODE_OAUTH_HOST ?? launchEnv.KIMI_OAUTH_HOST ?? '',
        }),
      )
      .digest('hex');
  } catch {
    return undefined;
  }
}

export interface KimiQuotaExecutionOwner {
  readonly snapshot: ExecutionAccountSnapshot;
  readonly shareDir: string;
  readonly configPath: string;
  readonly launchEnv: Readonly<Record<string, string>>;
}

/**
 * Resolve an account-scoped Kimi OAuth execution owner and isolated CLI launch env.
 * Never returns or persists secret credential contents.
 */
export function resolveKimiQuotaExecutionOwner(
  projectRoot: string,
  accountRef: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
): KimiQuotaExecutionOwner | null {
  const profile = resolveByAccountRef(projectRoot, accountRef);
  if (!profile || profile.client !== 'kimi' || profile.authType !== 'oauth' || profile.baseUrl) {
    return null;
  }

  let accountEnv: Record<string, string>;
  try {
    accountEnv = prepareAcpProcessEnv({ clientId: 'kimi', account: profile }) ?? {};
  } catch {
    return null;
  }
  if (Object.keys(accountEnv).some((key) => /(?:API_KEY|TOKEN|^KIMI_MODEL_|^NODE_OPTIONS$|^NODE_PATH$)/.test(key))) {
    return null;
  }

  const launchEnv: Record<string, string> = {};
  for (const key of ALLOWED_LAUNCH_ENV_KEYS) {
    const value = accountEnv[key] ?? hostEnv[key];
    if (typeof value === 'string' && value.length > 0) {
      launchEnv[key] = value;
    }
  }
  launchEnv.HOME ??= hostEnv.HOME || homedir();
  const nativeHome = process.platform === 'win32' ? (launchEnv.USERPROFILE ?? launchEnv.HOME) : launchEnv.HOME;
  const rawShareDir = launchEnv.KIMI_CODE_HOME || join(nativeHome, '.kimi-code');
  const shareDir = existsSync(rawShareDir) ? realpathSync(rawShareDir) : resolve(rawShareDir);
  const configPath = resolveKimiRuntimePaths({ KIMI_CODE_HOME: shareDir }, nativeHome).configPath;
  launchEnv.KIMI_CODE_HOME = shareDir;

  const credentialVersion = inspectKimiOAuthCredentialVersion(shareDir, configPath, launchEnv);
  const accountRevision = createHash('sha256')
    .update(
      JSON.stringify({
        id: profile.id,
        authType: profile.authType,
        baseUrl: profile.baseUrl ?? null,
        envVars: profile.envVars ?? null,
        shareDir,
        credentialVersion: credentialVersion ?? null,
      }),
    )
    .digest('hex');

  const snapshot: ExecutionAccountSnapshot = Object.freeze({
    accountRef: profile.id,
    displayName: profile.displayName ?? profile.id,
    authType: profile.authType,
    accountRevision,
    ...(credentialVersion ? { credentialVersion } : {}),
  });

  return Object.freeze({
    snapshot,
    shareDir,
    configPath,
    launchEnv: Object.freeze(launchEnv),
  });
}
