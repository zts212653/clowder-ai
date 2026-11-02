import {
  linkSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CodexManagedAccount } from '@cat-cafe/shared';
import { resolveByAccountRef } from './account-resolver.js';
import { resolveAccountWriteRoot } from './account-store-topology.js';
import { codexCanonicalPath, resolveCodexAccountLaunch } from './codex-account-launch.js';
import {
  type CredentialFileProjection,
  type CredentialLinkType,
  type CredentialProjectionKind,
  fileProjectionForName,
  linkTypeForProjection,
} from './credential-projection-policy.js';
import { assertCodexSharedStateRoots } from './codex-shared-state.js';

export const CODEX_SHARED_DIRECTORIES = [
  'sessions',
  'archived_sessions',
  'thread-writer-locks',
  'memories',
  'memories_v2',
  'generated_images',
] as const;
const CONFIG_DIRECTORIES = ['skills', 'rules', 'prompts'] as const;
/** New immutable account roots; existing/default homes are never moved or imported. */
export function describeCodexManagedLayout(projectRoot: string, accountRef: string): CodexManagedAccount {
  if (!/^codex-[0-9a-f-]{36}$/.test(accountRef)) throw new Error('codex_managed_account_ref_invalid');
  const profile = resolveByAccountRef(projectRoot, 'codex');
  if (!profile || profile.authType !== 'oauth') throw new Error('codex_default_account_unavailable');
  const source = resolveCodexAccountLaunch(profile, { cwd: projectRoot });
  assertCodexSharedStateRoots(projectRoot);
  return {
    kind: 'managed',
    layoutVersion: 1,
    prepared: false,
    credentialHome: codexCanonicalPath(
      join(resolveAccountWriteRoot(projectRoot), '.cat-cafe', 'codex-accounts', accountRef, 'home'),
      projectRoot,
    ),
    stateRoot: source.stateRoot,
    sqliteHome: source.sqliteHome,
  };
}
type LinkFile = (target: string, path: string, type?: CredentialLinkType) => void;

/** Windows non-elevated users cannot create the file/directory links this layout needs.
 * Keep the failure closed, but name the missing prerequisite instead of surfacing a raw EPERM.
 */
export function createCodexManagedLink(
  target: string,
  link: string,
  linkFn: LinkFile = symlinkSync,
  platform: NodeJS.Platform = process.platform,
  kind: CredentialProjectionKind = 'file',
): void {
  try {
    linkFn(target, link, linkTypeForProjection(kind, platform));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      throw Object.assign(
        new Error(
          'codex_managed_layout_symlink_unavailable: managed Codex layouts require directory and file links; enable Windows Developer Mode/symlink privilege or use a supported layout.',
        ),
        { code: 'codex_managed_layout_symlink_unavailable', cause: error },
      );
    }
    throw error;
  }
}

function ensureLink(
  target: string,
  link: string,
  kind: CredentialProjectionKind = 'file',
  strategy: CredentialFileProjection = 'symlink',
): void {
  try {
    const info = lstatSync(link);
    if (strategy === 'hardlink') {
      const linkStat = statSync(link);
      const targetStat = statSync(target);
      if (linkStat.dev === targetStat.dev && linkStat.ino === targetStat.ino) return;
    } else if (info.isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === target) {
      return;
    }
    throw new Error('codex_managed_layout_changed');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (strategy === 'hardlink') {
    // Optional AGENTS.md / hooks.json may have no target yet. The caller seeds
    // a valid target before this point; never create a dangling file link.
    try {
      statSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      linkSync(target, link);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === 'win32') {
        throw Object.assign(
          new Error(
            'codex_managed_layout_symlink_unavailable: managed Codex layouts could not hardlink a shared file; keep the account state on the same volume or enable Windows symlink support.',
          ),
          { code: 'codex_managed_layout_symlink_unavailable', cause: error },
        );
      }
      throw error;
    }
  }
  createCodexManagedLink(target, link, symlinkSync, process.platform, kind);
}
/** Idempotent explicit preparation. Private auth/secrets/tmp/control files are never shared. */
export function prepareCodexManagedLayout(layout: CodexManagedAccount, projectRoot?: string): CodexManagedAccount {
  if (projectRoot) assertCodexSharedStateRoots(projectRoot, { layout });
  if (layout.credentialHome === layout.stateRoot) throw new Error('codex_managed_layout_invalid');
  mkdirSync(layout.credentialHome, { recursive: true, mode: 0o700 });
  mkdirSync(layout.sqliteHome, { recursive: true, mode: 0o700 });
  for (const name of [...CODEX_SHARED_DIRECTORIES, ...CONFIG_DIRECTORIES]) {
    const target = join(layout.stateRoot, name);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    ensureLink(target, join(layout.credentialHome, name), 'directory');
  }
  // Native config/value/write resolves this target before atomic replacement. Unknown external writers
  // that replace the link are refused by the launch-time layout check, never silently resynchronized.
  const config = join(layout.stateRoot, 'config.toml');
  try {
    writeFileSync(config, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  ensureLink(
    config,
    join(layout.credentialHome, 'config.toml'),
    'file',
    fileProjectionForName('config.toml'),
  );
  for (const name of ['AGENTS.md', 'hooks.json']) {
    const target = join(layout.stateRoot, name);
    if (process.platform === 'win32') {
      try {
        statSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A hardlink needs an existing target. These files are optional, so
        // seed a valid empty target instead of creating a dangling link.
        writeFileSync(target, name === 'hooks.json' ? '{}\n' : '', {
          flag: 'wx',
          mode: 0o600,
        });
      }
    }
    ensureLink(
      target,
      join(layout.credentialHome, name),
      'file',
      fileProjectionForName(name),
    );
  }
  return { ...layout, prepared: true };
}
function assertManagedLink(layout: CodexManagedAccount, name: string): void {
  const target = join(layout.stateRoot, name);
  const link = join(layout.credentialHome, name);
  let targetExists = true;
  try {
    statSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    targetExists = false;
  }

  if (!targetExists) {
    // Optional instructions/hooks may legitimately have no target yet. On
    // Windows there is nothing to hardlink; an existing dangling link means a
    // stale layout and must stay visible rather than being silently adopted.
    if (process.platform === 'win32') {
      try {
        lstatSync(link);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      throw new Error('codex_managed_layout_changed');
    }
  }

  if (fileProjectionForName(name) === 'hardlink') {
    const linkStat = statSync(link);
    const targetStat = statSync(target);
    if (linkStat.dev !== targetStat.dev || linkStat.ino !== targetStat.ino) {
      throw new Error('codex_managed_layout_changed');
    }
    return;
  }

  if (
    !lstatSync(link).isSymbolicLink() ||
    resolve(dirname(link), readlinkSync(link)) !== resolve(target)
  ) {
    throw new Error('codex_managed_layout_changed');
  }
}

/** Read-only admission validates source links, including a replaced config link. */
export function validateCodexManagedLayout(layout: CodexManagedAccount): void {
  if (!layout.prepared) throw new Error('codex_account_not_prepared');
  for (const name of [
    ...CODEX_SHARED_DIRECTORIES,
    ...CONFIG_DIRECTORIES,
    'config.toml',
    'AGENTS.md',
    'hooks.json',
  ]) {
    assertManagedLink(layout, name);
  }
}
