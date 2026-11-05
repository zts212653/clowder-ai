import { execFile } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
type RunSecurity = (home: string, args: readonly string[]) => Promise<string>;

async function runSecurity(home: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/security', [...args], {
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 16_384,
  });
  return stdout;
}

function assertLocalEntry(path: string, kind: 'directory' | 'file'): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return false;
  if (entry.isSymbolicLink() || (kind === 'directory' ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) {
    throw new Error(`AGY private keychain ${kind} must not redirect or share storage: ${path}`);
  }
  return true;
}

function securityPaths(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const path: unknown = JSON.parse(line);
      if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Invalid macOS keychain path response');
      return resolve(path);
    });
}

async function configuredDefault(home: string, execute: RunSecurity): Promise<string[]> {
  try {
    return securityPaths(await execute(home, ['default-keychain', '-d', 'user']));
  } catch (error) {
    if (
      error instanceof Error &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      error.stderr.includes('A default keychain could not be found')
    )
      return [];
    throw error;
  }
}

/**
 * The carrier keeps both its OAuth fallback file and its macOS keychain inside
 * the same private HOME. Never link/import the operator's login keychain.
 * Apple Security's user preferences resolve HOME and write that home's plist;
 * all keychain writes additionally name this one private file explicitly.
 */
export async function prepareAgyNativeKeychain({
  profileHome,
  platform = process.platform,
  execute = runSecurity,
}: {
  readonly profileHome: string;
  readonly platform?: NodeJS.Platform;
  readonly execute?: RunSecurity;
}): Promise<void> {
  if (platform !== 'darwin') return;
  assertLocalEntry(profileHome, 'directory');
  const home = realpathSync(profileHome);
  if ([homedir(), userInfo().homedir].some((root) => realpathSync(root) === home)) {
    throw new Error('AGY private keychain cannot use the operator HOME');
  }
  const library = join(home, 'Library');
  const keychains = join(library, 'Keychains');
  const preferences = join(library, 'Preferences');
  const keychain = join(keychains, 'cat-cafe.keychain-db');
  const plist = join(preferences, 'com.apple.security.plist');
  for (const path of [library, keychains, preferences]) assertLocalEntry(path, 'directory');
  assertLocalEntry(plist, 'file');
  const exists = assertLocalEntry(keychain, 'file');

  // An existing search list is never silently redirected away from another
  // credential store, including an operator-provided system-keychain link.
  const search = securityPaths(await execute(home, ['list-keychains', '-d', 'user']));
  const priorDefault = await configuredDefault(home, execute);
  if ([...search, ...priorDefault].some((path) => path !== keychain)) {
    throw new Error('AGY profile keychain search list is not private; refusing to replace it');
  }
  for (const path of [library, keychains, preferences]) {
    assertLocalEntry(path, 'directory');
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  if (!exists) await execute(home, ['create-keychain', '-p', '', keychain]);
  assertLocalEntry(keychain, 'file');
  chmodSync(keychain, 0o600);
  // This app-owned empty-password store has the same account/file boundary as
  // the CLI's existing 0600 OAuth file; no operator keychain is unlocked.
  await execute(home, ['unlock-keychain', '-p', '', keychain]);
  await execute(home, ['set-keychain-settings', keychain]);
  await execute(home, ['default-keychain', '-d', 'user', '-s', keychain]);
  await execute(home, ['list-keychains', '-d', 'user', '-s', keychain]);
  assertLocalEntry(plist, 'file');
  chmodSync(plist, 0o600);
  const actualDefault = securityPaths(await execute(home, ['default-keychain', '-d', 'user']));
  const actualSearch = securityPaths(await execute(home, ['list-keychains', '-d', 'user']));
  if (
    actualDefault.length !== 1 ||
    actualDefault[0] !== keychain ||
    actualSearch.length !== 1 ||
    actualSearch[0] !== keychain
  ) {
    throw new Error('AGY private keychain binding was not established');
  }
}
