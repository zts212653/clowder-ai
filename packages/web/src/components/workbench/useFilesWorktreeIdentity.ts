import { useCallback, useEffect, useState } from 'react';
import type { WorktreeEntry } from '@/hooks/useWorkspace';
import { ownsWorktreeIdentity, requestWorktrees } from './files-tree';

/** What the Files header knows about its worktree. Only `known` carries a branch or HEAD. */
export type FilesWorktreeIdentity =
  | { readonly state: 'loading' }
  | { readonly state: 'known'; readonly entry: WorktreeEntry }
  /** The listing was read and names no entry for this id. */
  | { readonly state: 'unlisted' }
  /** The listing names more than one entry for this id: nothing is chosen for the person. */
  | { readonly state: 'ambiguous' }
  /** The listing could not be read, or its answer could not be understood. */
  | { readonly state: 'failed' };

/** Header words for each state: branch/HEAD placeholders, and the reason line shown when identity is not known. */
export const IDENTITY_PLACEHOLDER: Record<FilesWorktreeIdentity['state'], string> = {
  loading: '读取中…',
  known: '',
  unlisted: '未知',
  ambiguous: '无法确认',
  failed: '读取失败',
};
export const IDENTITY_STATUS: Partial<Record<FilesWorktreeIdentity['state'], string>> = {
  unlisted: '没能确认这个工作区的 branch/HEAD（它不在对应项目的工作区列表里）；文件树照常可用。',
  ambiguous: '这个工作区在列表里对应到不止一项，没法唯一确认 branch/HEAD；文件树照常可用。',
  failed: '工作区的 branch/HEAD 暂时读取失败；文件树照常可用。',
};

/**
 * An id minted under an explicit listing coordinate is that exact entry id. Aliases (canonical / legacy ids)
 * only identify trees restored from descriptors that predate the coordinate.
 */
export function matchesWorktreeIdentity(entry: WorktreeEntry, worktreeId: string, exact: boolean): boolean {
  return exact ? entry.id === worktreeId : ownsWorktreeIdentity(entry, worktreeId);
}

/**
 * Reads the identity of one tree's worktree through `listingRoot`: the coordinate that minted its id
 * (e.g. the project Settings resolved it under), or the current chat's project for in-project trees.
 * Every read ends in a terminal state; nothing stays "loading" because a different root was asked.
 */
export function useFilesWorktreeIdentity(worktreeId: string | null, listingRoot: string, exact: boolean) {
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [identity, setIdentity] = useState<FilesWorktreeIdentity>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    void attempt;
    if (!worktreeId) {
      setWorktrees([]);
      setIdentity({ state: 'unlisted' });
      return;
    }
    let active = true;
    setIdentity({ state: 'loading' });
    void requestWorktrees(listingRoot)
      .then((listed) => {
        if (!active) return;
        setWorktrees(listed);
        const owners = listed.filter((entry) => matchesWorktreeIdentity(entry, worktreeId, exact));
        const [only] = owners;
        setIdentity(
          owners.length === 0
            ? { state: 'unlisted' }
            : owners.length === 1 && only
              ? { state: 'known', entry: only }
              : { state: 'ambiguous' },
        );
      })
      .catch(() => {
        if (!active) return;
        setWorktrees([]);
        setIdentity({ state: 'failed' });
      });
    return () => {
      active = false;
    };
  }, [worktreeId, listingRoot, exact, attempt]);
  const reread = useCallback(() => setAttempt((count) => count + 1), []);
  return { worktrees, identity, reread };
}
