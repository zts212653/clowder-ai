import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const AGY_NATIVE_CREDENTIAL_DIR = 'cat-cafe-credentials';

function requireOwnerDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error('AGY native credential directory must be owner-only and not a symlink');
  }
}

export function isLocalAgyCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** One process turn, one credential file. The CLI sees only its path in host-owned MCP config. */
export function prepareAgyNativeCredentialFile(
  profileHome: string,
  callbackEnv: Readonly<Record<string, string>>,
): { readonly apiUrl: string; readonly path: string; dispose(): void } {
  const apiUrl = callbackEnv.CAT_CAFE_API_URL;
  const invocationId = callbackEnv.CAT_CAFE_INVOCATION_ID;
  const callbackToken = callbackEnv.CAT_CAFE_CALLBACK_TOKEN;
  if (!apiUrl || !isLocalAgyCallbackUrl(apiUrl) || !invocationId || !callbackToken) {
    throw new Error('AGY native MCP requires a complete local callback credential');
  }
  const suppliedHome = resolve(profileHome);
  if (lstatSync(suppliedHome).isSymbolicLink()) throw new Error('AGY native credential HOME must not be a symlink');
  const home = realpathSync(suppliedHome);
  if (home === realpathSync(homedir())) throw new Error('AGY native credential requires an isolated HOME');
  const configDir = join(home, '.gemini', 'config');
  for (const dir of [join(home, '.gemini'), configDir]) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('AGY native credential config path is unsafe');
  }
  const dir = join(configDir, AGY_NATIVE_CREDENTIAL_DIR);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  requireOwnerDirectory(dir);
  const path = join(dir, `${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ invocationId, callbackToken }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { apiUrl, path, dispose: () => rmSync(path, { force: true }) };
}
