import { statSync } from 'node:fs';

/** Native filesystem identity on the supported local NTFS path, never a folded display string. */
export function acpBootstrapDirectoryIdentity(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.ino === 0n) throw new Error('ACP directory identity is unavailable');
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
