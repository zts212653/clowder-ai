import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { DEFAULT_EDITOR_BRIDGE_MAX_CONTENT_BYTES } from '../collaborative-content/editor-bridge/service.js';
import { getWorktreeRoot, resolveWorkspaceFilesystemPath, WorkspaceSecurityError } from './workspace-security.js';

/** Read one bounded regular file through the same registered workspace authorization as DOCX. */
export async function readWorkspacePreviewSnapshot(worktreeId: string, path: string): Promise<Buffer> {
  const root = await getWorktreeRoot(worktreeId);
  const resolved = await resolveWorkspaceFilesystemPath(root, path);
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > DEFAULT_EDITOR_BRIDGE_MAX_CONTENT_BYTES)
      throw new WorkspaceSecurityError('Preview requires a bounded regular file', 'DENIED');
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new WorkspaceSecurityError('Preview source changed while reading', 'DENIED');
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
