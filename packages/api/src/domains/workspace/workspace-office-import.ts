import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { DEFAULT_EDITOR_BRIDGE_MAX_CONTENT_BYTES } from '../collaborative-content/editor-bridge/service.js';
import { getWorktreeRoot, resolveWorkspaceFilesystemPath, WorkspaceSecurityError } from './workspace-security.js';

/** Read an initial owner import through the existing registered-workspace boundary. */
export async function readWorkspaceOfficeImport(worktreeId: string, path: string): Promise<Buffer> {
  const root = await getWorktreeRoot(worktreeId);
  const resolved = await resolveWorkspaceFilesystemPath(root, path);
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 4 || stat.size > DEFAULT_EDITOR_BRIDGE_MAX_CONTENT_BYTES) {
      throw new WorkspaceSecurityError('Office file is not a bounded regular file', 'DENIED');
    }
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size || bytes.readUInt32LE(0) !== 0x04034b50) {
      throw new WorkspaceSecurityError('Office file changed or is not an OOXML archive', 'DENIED');
    }
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
