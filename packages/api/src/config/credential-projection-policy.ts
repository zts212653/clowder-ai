export type CredentialProjectionKind = 'directory' | 'file';
export type CredentialLinkType = 'dir' | 'file' | 'junction';
export type CredentialFileProjection = 'symlink' | 'hardlink';

/**
 * Directory links can use a Windows junction without symlink privilege.
 * File links cannot; keep them as symlinks so failures remain diagnosable.
 */
export function linkTypeForProjection(
  kind: CredentialProjectionKind,
  platform: NodeJS.Platform = process.platform,
): CredentialLinkType | undefined {
  if (kind === 'file') return undefined;
  return platform === 'win32' ? 'junction' : 'dir';
}

/**
 * Managed-layout files must share one canonical file. On Windows, a non-elevated
 * user cannot create a file symlink, so use an existing file hardlink instead.
 * Missing optional files (AGENTS.md / hooks.json) are skipped until they exist.
 */
export function fileProjectionForName(
  name: string,
  platform: NodeJS.Platform = process.platform,
): CredentialFileProjection {
  if (platform !== 'win32') return 'symlink';
  return name === 'config.toml' || name === 'AGENTS.md' || name === 'hooks.json'
    ? 'hardlink'
    : 'symlink';
}
