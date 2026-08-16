import { lstat, mkdtemp, readFile, readlink, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, win32 } from 'node:path';

import { isolatedLiveGateProjectRoot, LiveGateNotObservedError } from './f247-personal-chrome-live-contract.mjs';

export function defaultChromeUserDataDirectory({
  platform = process.platform,
  homeDirectory = homedir(),
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  if (platform === 'darwin') return join(homeDirectory, 'Library/Application Support/Google/Chrome');
  if (platform === 'linux') return join(homeDirectory, '.config/google-chrome');
  if (platform === 'win32') {
    if (!localAppData) throw new Error('LOCALAPPDATA is required for a Windows Chrome profile');
    return win32.join(localAppData, 'Google', 'Chrome', 'User Data');
  }
  throw new Error(`unsupported platform: ${platform}`);
}

export async function resolveChromeProfile({ userDataDirectory, profileDirectory }) {
  if (
    typeof profileDirectory !== 'string' ||
    !profileDirectory ||
    profileDirectory.trim() !== profileDirectory ||
    basename(profileDirectory) !== profileDirectory
  ) {
    throw new Error('profileDirectory must be one exact Chrome profile directory name');
  }
  const localState = JSON.parse(await readFile(join(userDataDirectory, 'Local State'), 'utf8'));
  const profile = localState?.profile?.info_cache?.[profileDirectory];
  if (!profile || typeof profile.name !== 'string') {
    throw new Error('profileDirectory is not registered in Chrome Local State');
  }
  const metadata = await stat(join(userDataDirectory, profileDirectory));
  if (!metadata.isDirectory()) throw new Error('registered Chrome profile path is not a directory');
  return { userDataDirectory, profileDirectory, profileName: profile.name };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

export async function inspectChromeProfileLock(userDataDirectory, { isProcessAlive = processIsAlive } = {}) {
  const lockPath = join(userDataDirectory, 'SingletonLock');
  let metadata;
  try {
    metadata = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { inUse: false, lockPath };
    throw error;
  }
  if (!metadata.isSymbolicLink()) return { inUse: true, lockPath, ownerPid: null };
  const target = await readlink(lockPath);
  const ownerPid = Number(target.match(/-(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return { inUse: true, lockPath, ownerPid: null };
  return { inUse: isProcessAlive(ownerPid), lockPath, ownerPid };
}

export async function prepareChromeBrowserScope({ env, homeDirectory, fallbackProjectRoot }) {
  const profileDirectory = env.F247_CHROME_PROFILE_DIRECTORY?.trim();
  if (!profileDirectory) {
    const userDataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-f247-live-profile-'));
    return {
      userDataDir,
      projectRoot: isolatedLiveGateProjectRoot(userDataDir),
      profileDirectory: null,
      profileLabel: 'isolated-temporary',
      ownsUserDataDir: true,
      retainInstallation: false,
    };
  }
  const userDataDir = defaultChromeUserDataDirectory({ homeDirectory, localAppData: env.LOCALAPPDATA });
  const profile = await resolveChromeProfile({ userDataDirectory: userDataDir, profileDirectory });
  const lock = await inspectChromeProfileLock(userDataDir);
  if (lock.inUse) {
    throw new LiveGateNotObservedError(
      'CHROME_PROFILE_IN_USE',
      `Chrome profile ${profile.profileDirectory} (${profile.profileName}) is owned by a running Chrome process`,
    );
  }
  return {
    userDataDir,
    projectRoot: env.CAT_CAFE_CONFIG_ROOT?.trim() || fallbackProjectRoot,
    profileDirectory: profile.profileDirectory,
    profileLabel: `owner-existing:${profile.profileDirectory}`,
    ownsUserDataDir: false,
    retainInstallation: true,
  };
}
