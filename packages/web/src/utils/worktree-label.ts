/** Return the final directory segment for POSIX and Windows worktree paths. */
export function worktreeBasename(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

/** A listed HEAD as shown to a person: `git worktree list` names none for a bare repository, and that is said. */
export function worktreeHeadLabel(head: string): string {
  return head || '无 HEAD';
}

/** Format a worktree or linked root without losing its user-facing alias. */
export function worktreeLabel(worktree: { head: string; root: string; branch: string; removable?: boolean }): string {
  const basename = worktreeBasename(worktree.root);
  return worktree.head === 'linked'
    ? `📂 ${basename} — ${worktree.branch}${worktree.removable === false ? '（由设置连接）' : worktree.removable ? '（共享目录）' : ''}`
    : `${basename} — ${worktree.branch} (${worktreeHeadLabel(worktree.head)})`;
}
