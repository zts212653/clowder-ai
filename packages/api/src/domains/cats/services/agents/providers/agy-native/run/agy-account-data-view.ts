import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AGY_OAUTH_FILE, agyOAuthFile, assertAgyCredentialHome } from '../../../../../../../config/agy-account.js';
import {
  areWin32DirectoriesAclPrivate,
  canonicalWin32Path,
  hardenWin32PrivateDirectoryAcl,
  hasOnlyControlledWin32Hardlinks,
  isControlledAgyOAuthAlias,
  isControlledAgySharedFileAlias,
} from '../../../../../../../config/win32-fs-security.js';

const SHARED_DIRECTORIES = ['brain', 'conversations', 'implicit'];
const SHARED_FILES = [
  'conversation_summaries.db',
  'conversation_summaries.db-wal',
  'conversation_summaries.db-shm',
  'installation_id',
];

export interface PrepareAgyAccountDataViewOptions {
  /** Test seam: emulate non-admin Windows where file `symlinkSync` fails with `EPERM`. */
  readonly forceWin32HardlinkFallback?: boolean;
  /** Test seam: override `linkSync` (e.g. to verify fail-closed `EXDEV` cross-volume handling). */
  readonly linkSyncFn?: typeof linkSync;
}

function wrapWin32HardlinkError(error: unknown): Error {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV') {
    return new Error('agy_account_view_cross_volume_unsupported');
  }
  return error instanceof Error ? error : new Error(String(error));
}

function directory(path: string, hardenWin32 = false): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('agy_account_view_directory_unsafe');
    if (hardenWin32 && !areWin32DirectoriesAclPrivate([path])) throw new Error('agy_account_view_directory_unsafe');
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (hardenWin32) {
    try {
      hardenWin32PrivateDirectoryAcl(path);
    } catch {
      throw new Error('agy_account_view_directory_unsafe');
    }
  }
}

function atomicHardlinkReplace(target: string, viewPath: string, doLinkSync: typeof linkSync): void {
  const tempPath = join(dirname(viewPath), `.relink-${randomUUID()}`);
  try {
    doLinkSync(target, tempPath);
    renameSync(tempPath, viewPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw wrapWin32HardlinkError(error);
  }
}

function link(
  target: string,
  path: string,
  isDirectory: boolean,
  options: {
    readonly allowPromoteToCanonical: boolean;
    readonly forceWin32HardlinkFallback: boolean;
    readonly linkSyncFn: typeof linkSync;
  },
): void {
  const win32Mode = process.platform === 'win32' || options.forceWin32HardlinkFallback;
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat) {
    if (stat.isSymbolicLink() && resolve(readlinkSync(path)) === target) return;
    if (win32Mode && !isDirectory && stat.isFile() && !stat.isSymbolicLink()) {
      const targetStat = lstatSync(target, { throwIfNoEntry: false });
      if (targetStat) {
        if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error('agy_account_view_link_changed');
        if (stat.dev === targetStat.dev && stat.ino === targetStat.ino) return;
        // Canonical file was atomically replaced (e.g. OAuth re-login created a new inode):
        // re-link the view alias atomically without copying any file contents.
        atomicHardlinkReplace(target, path, options.linkSyncFn);
        return;
      }
      if (options.allowPromoteToCanonical && stat.nlink === 1) {
        // First DB/shared-file creation under non-admin hardlink fallback: the CLI created the
        // file inside the view while canonical did not yet exist. Promote it to canonical owner
        // and hardlink the view back to the exact same inode.
        renameSync(path, target);
        try {
          options.linkSyncFn(target, path);
        } catch (error) {
          try {
            renameSync(target, path);
          } catch {
            // Best-effort rollback; surface the link failure below.
          }
          throw wrapWin32HardlinkError(error);
        }
        return;
      }
    }
    throw new Error('agy_account_view_link_changed');
  }
  if (isDirectory) {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  try {
    if (options.forceWin32HardlinkFallback) {
      const eperm = Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
      throw eperm;
    }
    symlinkSync(target, path);
  } catch (error) {
    if (win32Mode && (error as NodeJS.ErrnoException).code === 'EPERM') {
      const targetStat = lstatSync(target, { throwIfNoEntry: false });
      if (!targetStat) return;
      if (targetStat.isFile() && !targetStat.isSymbolicLink()) {
        try {
          options.linkSyncFn(target, path);
        } catch (linkError) {
          throw wrapWin32HardlinkError(linkError);
        }
        return;
      }
    }
    throw error;
  }
}

/**
 * A stable view per member/account: only the official token file belongs to the
 * account. All conversation data keeps the member's original canonical owner.
 * The CLI writes through its token link (1.5.6 uses os.WriteFile); no token copy.
 * On non-admin Windows where file symlinks fail with EPERM, NTFS hardlinks provide
 * zero-copy inode sharing within the same volume; cross-volume EXDEV fails closed.
 * Called inside the existing profile preparation lease.
 */
export function prepareAgyAccountDataView(
  profileHome: string,
  credentialHome: string,
  options: PrepareAgyAccountDataViewOptions = {},
): string {
  assertAgyCredentialHome(credentialHome);
  const profile = canonicalWin32Path(profileHome);
  const account = canonicalWin32Path(credentialHome);
  const data = join(profile, '.gemini', 'antigravity-cli');
  const views = join(profile, '.cat-cafe-account-views');
  const view = join(views, createHash('sha256').update(account).digest('hex'));
  directory(views, true);
  directory(view, true);
  const linkOpts = {
    forceWin32HardlinkFallback: options.forceWin32HardlinkFallback === true,
    linkSyncFn: options.linkSyncFn ?? linkSync,
  };
  // Settings, entitlement caches and plugin secrets stay private. The CLI
  // atomically replaces some of them, so linking every app-data entry is wrong.
  for (const name of [...SHARED_DIRECTORIES, ...SHARED_FILES]) {
    const isDir = SHARED_DIRECTORIES.includes(name);
    const target = join(data, name);
    if (isDir) directory(target);
    else {
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('agy_shared_session_file_unsafe');
        if (
          stat.nlink !== 1 &&
          (process.platform !== 'win32' ||
            !hasOnlyControlledWin32Hardlinks(target, isControlledAgySharedFileAlias(profile, name)))
        ) {
          throw new Error('agy_shared_session_file_unsafe');
        }
      }
    }
    link(target, join(view, name), isDir, { ...linkOpts, allowPromoteToCanonical: !isDir });
  }
  const oauthTarget = agyOAuthFile(account);
  const oauthStat = lstatSync(oauthTarget, { throwIfNoEntry: false });
  if (oauthStat) {
    if (!oauthStat.isFile() || oauthStat.isSymbolicLink()) throw new Error('agy_shared_session_file_unsafe');
    if (
      oauthStat.nlink !== 1 &&
      (process.platform !== 'win32' ||
        !hasOnlyControlledWin32Hardlinks(oauthTarget, isControlledAgyOAuthAlias(account, AGY_OAUTH_FILE)))
    ) {
      throw new Error('agy_shared_session_file_unsafe');
    }
  }
  link(oauthTarget, join(view, AGY_OAUTH_FILE), false, { ...linkOpts, allowPromoteToCanonical: false });
  return view;
}
