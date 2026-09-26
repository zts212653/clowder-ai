/** Read-only credential presence checks. No runtime spawn, network call or secret projection. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export interface ClientAuthDeps {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}

export interface ClientAuthResult {
  hasApiKey: boolean;
  authenticated: boolean;
  /** The source is intentionally descriptive only; no credential value is returned. */
  authType: 'environment' | 'native' | 'none';
  accountRef?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function readText(path: string, deps: ClientAuthDeps): string {
  return (deps.readFile ?? ((file) => readFileSync(file, 'utf8')))(path);
}

function hasKimiNativeAuth(home: string, env: NodeJS.ProcessEnv, deps: ClientAuthDeps): boolean {
  const shareDir = env.KIMI_SHARE_DIR?.trim() || join(home, '.kimi');
  try {
    const parsed = record(JSON.parse(readText(join(shareDir, 'credentials', 'kimi-code.json'), deps)));
    return nonEmpty(parsed?.access_token) && nonEmpty(parsed?.refresh_token);
  } catch {
    return false;
  }
}

function hasOpenCodeNativeAuth(home: string, env: NodeJS.ProcessEnv, deps: ClientAuthDeps): boolean {
  const xdg = env.XDG_DATA_HOME?.trim();
  const dataDir =
    env.OPENCODE_DATA_DIR?.trim() ||
    // OpenCode uses xdg-basedir's data directory on every platform. Keep the
    // default aligned with the CLI (`~/.local/share`); only XDG_DATA_HOME or
    // the explicit test/runtime override changes it.
    (xdg ? join(xdg, 'opencode') : join(home, '.local', 'share', 'opencode'));
  try {
    const parsed = record(JSON.parse(readText(join(dataDir, 'auth.json'), deps)));
    return (
      !!parsed &&
      Object.values(parsed).some((value) => {
        const entry = record(value);
        if (!entry) return false;
        const type = entry.type;
        if (type !== 'oauth' && type !== 'api' && type !== 'wellknown') return false;
        const oauth = record(entry.oauth);
        const api = record(entry.api);
        const wellknown = record(entry.wellknown);
        const access = nonEmpty(oauth?.access) || nonEmpty(oauth?.access_token) || nonEmpty(entry.access);
        const refresh = nonEmpty(oauth?.refresh) || nonEmpty(oauth?.refresh_token) || nonEmpty(entry.refresh);
        const apiKey = nonEmpty(api?.key) || nonEmpty(wellknown?.key) || nonEmpty(entry.key);
        return type === 'api' || type === 'wellknown'
          ? apiKey
          : type === 'oauth'
            ? access && refresh
            : access && refresh;
      })
    );
  } catch {
    return false;
  }
}

/**
 * Codex can be authenticated without auth.json or OPENAI_API_KEY. In that
 * mode the CLI reads a bearer value from the provider selected by
 * `model_provider` in config.toml. Keep the lookup scoped to that provider:
 * an unused provider entry must never make the active CLI look authenticated.
 */
function hasCodexConfigAuth(configPath: string, deps: ClientAuthDeps): boolean {
  try {
    const parsed = record(parseToml(readText(configPath, deps)));
    const providerName = parsed?.model_provider;
    if (!nonEmpty(providerName)) return false;
    const providers = record(parsed?.model_providers);
    const provider = record(providers?.[providerName as string]);
    return nonEmpty(provider?.base_url) && nonEmpty(provider?.experimental_bearer_token);
  } catch {
    return false;
  }
}

function getCredentialPath(client: string, home: string, env: NodeJS.ProcessEnv, codexHome: string): string | null {
  if (client === 'claude') return join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), '.credentials.json');
  if (client === 'codex') return join(codexHome, 'auth.json');
  if (client === 'gemini') return join(home, '.gemini', 'oauth_creds.json');
  return null;
}

function hasJsonAuth(client: string, parsed: Record<string, unknown> | null): boolean {
  const tokens = record(client === 'claude' ? parsed?.claudeAiOauth : client === 'codex' ? parsed?.tokens : parsed);
  if (client === 'claude') return nonEmpty(tokens?.accessToken) && nonEmpty(tokens?.refreshToken);
  return nonEmpty(tokens?.access_token) && nonEmpty(tokens?.refresh_token);
}

export function detectClientAuth(client: string, envKey: string, deps: ClientAuthDeps = {}) {
  const env = deps.env ?? process.env;
  const hasApiKey = nonEmpty(env[envKey]) || (client === 'gemini' && nonEmpty(env.GEMINI_API_KEY));
  if (hasApiKey) {
    return {
      hasApiKey: true,
      authenticated: true,
      authType: 'environment',
      accountRef: client === 'claude' ? 'claude' : client,
    } satisfies ClientAuthResult;
  }
  const home = deps.homeDir ?? homedir();
  // These must match the CLI's runtime home, not the quota panel's optional account override.
  const codexHome = env.CODEX_HOME?.trim() || join(home, '.codex');
  const path = getCredentialPath(client, home, env, codexHome);
  if (!path) {
    const authenticated =
      client === 'kimi'
        ? hasKimiNativeAuth(home, env, deps)
        : client === 'opencode'
          ? hasOpenCodeNativeAuth(home, env, deps)
          : false;
    return {
      hasApiKey: false,
      authenticated,
      authType: authenticated ? 'native' : 'none',
      ...(authenticated ? { accountRef: client } : {}),
    } satisfies ClientAuthResult;
  }
  try {
    const parsed = record(JSON.parse(readText(path, deps)));
    const authenticated = hasJsonAuth(client, parsed);
    if (authenticated || client !== 'codex') {
      return {
        hasApiKey: false,
        authenticated,
        authType: authenticated ? 'native' : 'none',
        ...(authenticated ? { accountRef: client } : {}),
      } satisfies ClientAuthResult;
    }
    const configAuthenticated = hasCodexConfigAuth(join(codexHome, 'config.toml'), deps);
    return {
      hasApiKey: false,
      authenticated: configAuthenticated,
      authType: configAuthenticated ? 'native' : 'none',
      ...(configAuthenticated ? { accountRef: client } : {}),
    } satisfies ClientAuthResult;
  } catch {
    if (client === 'codex') {
      const configAuthenticated = hasCodexConfigAuth(join(codexHome, 'config.toml'), deps);
      return {
        hasApiKey: false,
        authenticated: configAuthenticated,
        authType: configAuthenticated ? 'native' : 'none',
        ...(configAuthenticated ? { accountRef: client } : {}),
      } satisfies ClientAuthResult;
    }
    return { hasApiKey: false, authenticated: false, authType: 'none' } satisfies ClientAuthResult;
  }
}
