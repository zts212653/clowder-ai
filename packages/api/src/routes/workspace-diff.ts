import type { GitStatusEntry } from '../domains/workspace/git-status.js';

export interface WorkspaceChangedFile {
  status: string;
  path: string;
}

/** Paths are already decoded by the NUL-delimited Git reader; never split on arrows or newlines. */
export function toWorkspaceChangedFile(entry: GitStatusEntry): WorkspaceChangedFile {
  return { status: entry.status.trim(), path: entry.path };
}
