import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { agyOAuthFile, inspectAgyLogin } from './agy-account.js';

const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:';
const MAX_SECRET_BYTES = 65_536;

export interface AgyVerifiedOAuthDigests {
  readonly principalDigest: string;
  readonly grantDigest: string;
}

export type AgySecurityExec = (home: string, args: readonly string[]) => Promise<string> | string;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function defaultSecurityExec(home: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      '/usr/bin/security',
      [...args],
      {
        env: { HOME: home, PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: MAX_SECRET_BYTES,
      },
      (err, stdout) => {
        if (err) {
          // Never propagate ChildProcess stdout/stderr/cmd on error objects.
          reject(new Error('agy_keychain_exec_failed'));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function unwrapKeychainSecretEncoding(rawSecret: string): string | null {
  const trimmed = rawSecret.trim();
  if (!trimmed || trimmed.length > MAX_SECRET_BYTES) return null;

  let text = trimmed;
  if (trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    text = Buffer.from(trimmed, 'hex').toString('utf8').trim();
  }
  if (text.startsWith(GO_KEYRING_BASE64_PREFIX)) {
    const encoded = text.slice(GO_KEYRING_BASE64_PREFIX.length).trim();
    if (!encoded || !/^[A-Za-z0-9+/=_-]+$/.test(encoded)) return null;
    text = Buffer.from(encoded, 'base64').toString('utf8').trim();
  }
  return text.startsWith('{') ? text : null;
}

/**
 * Validate an AGY consumer OAuth JSON payload and return cryptographic digests only.
 * Raw tokens and email addresses never leave this function.
 */
export function parseAgyOAuthIdentityDigests(rawJson: string, nowMs = Date.now()): AgyVerifiedOAuthDigests | null {
  try {
    const parsed = JSON.parse(rawJson) as {
      auth_method?: unknown;
      id_token_email?: unknown;
      token?: { access_token?: unknown; refresh_token?: unknown; expiry?: unknown };
    };
    if (parsed.auth_method !== 'consumer') return null;
    const accessToken = typeof parsed.token?.access_token === 'string' ? parsed.token.access_token.trim() : '';
    const refreshToken = typeof parsed.token?.refresh_token === 'string' ? parsed.token.refresh_token.trim() : '';
    if (!accessToken) return null;

    const expiry = typeof parsed.token?.expiry === 'string' ? Date.parse(parsed.token.expiry) : Number.NaN;
    if (!Number.isFinite(expiry)) return null;
    if (expiry <= nowMs && !refreshToken) return null;

    const grant = refreshToken || accessToken;
    const grantDigest = sha256Hex(`oauth_grant:${grant}`);
    const email = typeof parsed.id_token_email === 'string' ? parsed.id_token_email.trim().toLowerCase() : '';
    const principalDigest = email ? sha256Hex(`google_principal:${email}`) : grantDigest;
    return { principalDigest, grantDigest };
  } catch {
    return null;
  }
}

export function inspectAgyOAuthFileIdentity(homePath: string): AgyVerifiedOAuthDigests | null {
  const status = inspectAgyLogin(homePath);
  if (status !== 'ready' && status !== 'refreshable') return null;
  try {
    return parseAgyOAuthIdentityDigests(readFileSync(agyOAuthFile(homePath), 'utf8'));
  } catch {
    return null;
  }
}

function isLocalPrivateDirectory(dirPath: string): boolean {
  const st = lstatSync(dirPath, { throwIfNoEntry: false });
  return Boolean(st && !st.isSymbolicLink() && st.isDirectory());
}

function isOperatorHome(resolvedHome: string): boolean {
  for (const candidate of [homedir(), userInfo().homedir]) {
    try {
      if (existsSync(candidate) && realpathSync(candidate) === resolvedHome) return true;
    } catch {
      // Ignore unresolvable host homedir in sandboxed environments.
    }
  }
  return false;
}

async function readPrivateKeychainDigests(
  home: string,
  keychainPath: string,
  runSecurity: AgySecurityExec,
): Promise<AgyVerifiedOAuthDigests | null> {
  try {
    await runSecurity(home, ['unlock-keychain', '-p', '', keychainPath]);
    const rawSecret = await runSecurity(home, [
      'find-generic-password',
      '-s',
      'gemini',
      '-a',
      'antigravity',
      '-w',
      keychainPath,
    ]);
    const jsonText = unwrapKeychainSecretEncoding(rawSecret);
    return jsonText ? parseAgyOAuthIdentityDigests(jsonText) : null;
  } catch {
    return null;
  }
}

export async function inspectAgyPrivateKeychainIdentity(
  profileHome: string,
  options?: { platform?: NodeJS.Platform; securityExec?: AgySecurityExec },
): Promise<AgyVerifiedOAuthDigests | null> {
  const platform = options?.platform ?? process.platform;
  if (platform !== 'darwin') return null;
  let home: string;
  let keychainPath: string;
  try {
    if (!isLocalPrivateDirectory(profileHome)) return null;
    home = realpathSync(profileHome);
    if (isOperatorHome(home)) return null;

    const libraryDir = join(home, 'Library');
    const keychainsDir = join(libraryDir, 'Keychains');
    if (!isLocalPrivateDirectory(libraryDir) || !isLocalPrivateDirectory(keychainsDir)) return null;

    keychainPath = join(keychainsDir, 'cat-cafe.keychain-db');
    const stat = lstatSync(keychainPath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
  } catch {
    return null;
  }

  return readPrivateKeychainDigests(home, keychainPath, options?.securityExec ?? defaultSecurityExec);
}
