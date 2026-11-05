import { stat } from 'node:fs/promises';
import { canLaunchLocalFile, contentFileMime } from '@cat-cafe/shared';
import { resolveWorkspaceFilesystemPath } from './workspace-security.js';

type LocalFileFacts = {
  path: string;
  mime: string;
  byteLength: number;
  canReveal: boolean;
  canOpen: boolean;
};
/** A confined local object has the same locate/launch facts through upload, raw URL or Workspace. */
export async function resolveLocalFile(root: string, relativePath: string): Promise<LocalFileFacts | { local: false }> {
  const path = await resolveWorkspaceFilesystemPath(root, relativePath);
  const info = await stat(path);
  if (!info.isFile() && !info.isDirectory()) return { local: false as const };
  return {
    path,
    mime: info.isDirectory() ? 'inode/directory' : contentFileMime(path),
    byteLength: info.size,
    canReveal: true,
    canOpen: info.isFile() && canLaunchLocalFile(path),
  };
}
