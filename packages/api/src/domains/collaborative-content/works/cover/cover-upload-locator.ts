import { basename, isAbsolute, join, relative } from 'node:path';
import { MediaOwnerError } from '../../../video-studio/content-owner/media-errors.js';

/** Map an owner upload file name to the registered Workspace root that contains the upload directory. */
export async function locateUploadedFile(
  fileName: string,
  deps: {
    uploadDir: string;
    roots(): Promise<readonly { id: string; root: string }[]>;
    resolve(locator: { worktreeId: string; path: string }): Promise<{ worktreeId: string; path: string }>;
  },
): Promise<{ kind: 'workspace'; rootId: string; path: string }> {
  if (!fileName || fileName !== basename(fileName) || fileName.includes('\\') || fileName.includes('\0'))
    throw new MediaOwnerError('invalid_media');
  const path = join(deps.uploadDir, fileName);
  const root = (await deps.roots()).find((entry) => {
    const rel = relative(entry.root, path);
    return rel && !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!root) throw new MediaOwnerError('media_unavailable');
  const located = await deps.resolve({ worktreeId: root.id, path: relative(root.root, path).split('\\').join('/') });
  return { kind: 'workspace', rootId: located.worktreeId, path: located.path };
}
