import type { ChatFileReference } from '@cat-cafe/shared';
import type { FileData } from '@/hooks/useWorkspace';

/** A loaded Workspace file keeps its existing registered locator for explicit desktop actions. */
export function workspaceFileReference(file: FileData, worktreeId: string, root?: string): ChatFileReference {
  return {
    kind: 'file',
    entryType: 'file',
    worktreeId,
    path: file.path,
    absolutePath: file.absolutePath ?? (root ? `${root.replace(/\/$/, '')}/${file.path}` : file.path),
    line: null,
    mime: file.mime,
    size: file.size,
    modifiedAt: '',
    pageCount: file.pageCount,
    pageUnit: file.pageUnit,
  };
}
