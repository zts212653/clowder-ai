import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { DEFAULT_EDITOR_BRIDGE_MAX_CONTENT_BYTES } from '../collaborative-content/editor-bridge/service.js';
import { hasSameWorkspaceFileState } from './workspace-content-source-utils.js';
import { getWorktreeRoot, resolveWorkspaceFilesystemPath, WorkspaceSecurityError } from './workspace-security.js';

const MAX_PREVIEW_SOURCE_BYTES = Math.min(32 * 1024 * 1024, DEFAULT_EDITOR_BRIDGE_MAX_CONTENT_BYTES);

export class WorkspacePreviewReadError extends Error {
  constructor(readonly code: 'preview_file_too_large' | 'preview_source_changed') {
    super(code);
  }
}

/** Read one bounded regular file through the same registered workspace authorization as DOCX. */
export async function readWorkspacePreviewSnapshot(worktreeId: string, path: string): Promise<Buffer> {
  const root = await getWorktreeRoot(worktreeId);
  const resolved = await resolveWorkspaceFilesystemPath(root, path);
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new WorkspaceSecurityError('Preview requires a regular file', 'DENIED');
    if (before.size > MAX_PREVIEW_SOURCE_BYTES) throw new WorkspacePreviewReadError('preview_file_too_large');

    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const current = await lstat(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (
      bytesRead !== before.size ||
      !current?.isFile() ||
      !hasSameWorkspaceFileState(before, current) ||
      !hasSameWorkspaceFileState(before, await file.stat())
    ) {
      throw new WorkspacePreviewReadError('preview_source_changed');
    }

    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
